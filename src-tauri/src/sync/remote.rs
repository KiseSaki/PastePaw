use super::{
    protocol::{digest, MAX_DOCUMENT},
    vault::Credentials,
};
use futures::StreamExt;
use quick_xml::{events::Event, Reader};
use reqwest::{
    header::{DATE, ETAG, IF_MATCH, IF_NONE_MATCH},
    Client, Method, Response, StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub struct Remote {
    client: Client,
    root: Url,
    credentials: Credentials,
    clock: parking_lot::Mutex<Option<(i64, Instant)>>,
}
pub struct File {
    pub bytes: Vec<u8>,
    pub etag: String,
}
#[derive(Clone, Debug)]
pub struct InventoryEntry {
    pub path: String,
    pub size: u64,
    pub modified_at: i64,
}

#[derive(Serialize, Deserialize)]
struct LeaseData {
    owner: String,
    expires_at: i64,
}
pub struct Lease {
    owner: String,
    etag: String,
}

fn transport_error(error: reqwest::Error) -> String {
    // reqwest 的原始错误可能包含完整地址，必须在边界转换为不含凭据的信息。
    if error.is_timeout() {
        "WebDAV 请求超时".into()
    } else if error.is_connect() {
        "无法连接 WebDAV，请检查网络、地址和证书".into()
    } else {
        "WebDAV 网络请求失败".into()
    }
}

fn status_error(status: StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => "WebDAV 身份验证失败或权限不足".into(),
        412 => "远端数据已被修改，请重试同步".into(),
        507 => "WebDAV 存储配额已满，已停止上传".into(),
        301..=308 => "WebDAV 返回重定向，请直接填写最终 HTTP 或 HTTPS 地址".into(),
        code => format!("WebDAV 请求失败（HTTP {code}）"),
    }
}

impl Remote {
    pub fn new(credentials: Credentials) -> Result<Self, String> {
        let root = credentials.root()?;
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "无法初始化 WebDAV 客户端")?;
        Ok(Self {
            client,
            root,
            credentials,
            clock: parking_lot::Mutex::new(None),
        })
    }

    fn observe_clock(&self, response: &Response) {
        if let Some(date) = response
            .headers()
            .get(DATE)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| chrono::DateTime::parse_from_rfc2822(s).ok())
        {
            *self.clock.lock() = Some((date.timestamp_millis(), Instant::now()));
        }
    }

    pub fn now(&self) -> Result<i64, String> {
        self.clock
            .lock()
            .as_ref()
            .map(|(time, since)| time + since.elapsed().as_millis() as i64)
            .ok_or_else(|| "WebDAV 未提供有效 Date 响应头，无法安全处理远端租约".into())
    }

    fn request(&self, method: Method, path: &str) -> Result<reqwest::RequestBuilder, String> {
        if path.starts_with('/')
            || path.contains("..")
            || path.contains('%')
            || path.contains('?')
            || path.contains('#')
        {
            return Err("同步文件路径无效".into());
        }
        let url = self.root.join(path).map_err(|_| "同步文件路径无效")?;
        Ok(self
            .client
            .request(method, url)
            .basic_auth(&self.credentials.username, Some(&self.credentials.password)))
    }

    async fn body(response: Response, max: u64) -> Result<Vec<u8>, String> {
        if response.content_length().is_some_and(|n| n > max) {
            return Err("远端文件超过大小限制".into());
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(transport_error)?;
            if bytes.len() as u64 + chunk.len() as u64 > max {
                return Err("远端文件超过大小限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    pub async fn get(&self, path: &str, max: u64) -> Result<Option<File>, String> {
        let mut weak_retries = 0;
        loop {
            let response = self
                .request(Method::GET, path)?
                .send()
                .await
                .map_err(transport_error)?;
            self.observe_clock(&response);
            if response.status() == StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !response.status().is_success() {
                return Err(status_error(response.status()));
            }
            let etag = response
                .headers()
                .get(ETAG)
                .and_then(|h| h.to_str().ok())
                .unwrap_or("")
                .to_owned();
            if etag.is_empty() {
                return Err("WebDAV 未返回 ETag，请检查服务端或反向代理是否关闭了 ETag".into());
            }
            if etag.starts_with("W/") {
                if weak_retries >= 2 {
                    return Err(
                        "WebDAV 持续返回弱 ETag，请检查服务端配置；双向同步需要强 ETag".into(),
                    );
                }
                // Apache 对刚写入不足一秒的文件返回弱 ETag；等待后重新读取正文和版本。
                // 不去掉 W/ 前缀冒充强版本，保持 If-Match 的并发保护。
                drop(response);
                weak_retries += 1;
                tokio::time::sleep(Duration::from_millis(1100)).await;
                continue;
            }
            return Ok(Some(File {
                etag,
                bytes: Self::body(response, max).await?,
            }));
        }
    }

    pub async fn put(
        &self,
        path: &str,
        bytes: Vec<u8>,
        etag: Option<&str>,
    ) -> Result<String, String> {
        let request = self
            .request(Method::PUT, path)?
            .header("Content-Type", "application/octet-stream");
        let request = match etag {
            Some(tag) => request.header(IF_MATCH, tag),
            None => request.header(IF_NONE_MATCH, "*"),
        };
        let response = request.body(bytes).send().await.map_err(transport_error)?;
        self.observe_clock(&response);
        if !response.status().is_success() {
            return Err(status_error(response.status()));
        }
        // 部分服务的 PUT 不返回 ETag，GET 验证实际保存结果后取得版本。
        if let Some(tag) = response
            .headers()
            .get(ETAG)
            .and_then(|h| h.to_str().ok())
            .filter(|tag| !tag.is_empty() && !tag.starts_with("W/"))
        {
            return Ok(tag.to_owned());
        }
        self.get(path, MAX_DOCUMENT)
            .await?
            .map(|f| f.etag)
            .ok_or_else(|| "上传完成后远端文件不存在".into())
    }

    pub async fn delete(&self, path: &str, etag: Option<&str>) -> Result<(), String> {
        let mut request = self.request(Method::DELETE, path)?;
        if let Some(tag) = etag {
            request = request.header(IF_MATCH, tag);
        }
        let response = request.send().await.map_err(transport_error)?;
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(status_error(response.status()))
        }
    }

    pub async fn initialize(&self) -> Result<(), String> {
        let mut parent = self.root.clone();
        parent
            .path_segments_mut()
            .map_err(|_| "同步目录无效")?
            .pop_if_empty()
            .pop()
            .push("");
        for url in [
            parent,
            self.root.clone(),
            self.root.join("assets/").map_err(|_| "同步目录无效")?,
            self.root.join("note-assets/").map_err(|_| "同步目录无效")?,
        ] {
            let response = self
                .client
                .request(Method::from_bytes(b"MKCOL").unwrap(), url)
                .basic_auth(&self.credentials.username, Some(&self.credentials.password))
                .send()
                .await
                .map_err(transport_error)?;
            if !response.status().is_success()
                && response.status() != StatusCode::METHOD_NOT_ALLOWED
            {
                return Err(status_error(response.status()));
            }
        }
        Ok(())
    }

    pub async fn probe(&self) -> Result<(), String> {
        self.initialize().await?;
        let path = format!("probe-{}.json", Uuid::new_v4());
        let first = self.put(&path, b"{}".to_vec(), None).await?;
        let updated = self
            .put(&path, b"{\"ok\":true}".to_vec(), Some(&first))
            .await?;
        let stale = self
            .request(Method::PUT, &path)?
            .header(IF_MATCH, &first)
            .body("{}")
            .send()
            .await
            .map_err(transport_error)?;
        let create_again = self
            .request(Method::PUT, &path)?
            .header(IF_NONE_MATCH, "*")
            .body("{}")
            .send()
            .await
            .map_err(transport_error)?;
        let verified = self.get(&path, 1024).await?;
        let safe = first != updated
            && stale.status() == StatusCode::PRECONDITION_FAILED
            && create_again.status() == StatusCode::PRECONDITION_FAILED
            && verified
                .as_ref()
                .is_some_and(|f| f.bytes == b"{\"ok\":true}");
        let inventory = self.inventory().await?;
        let inventory_valid = inventory.iter().any(|e| {
            e.path == path && e.size == b"{\"ok\":true}".len() as u64 && e.modified_at > 0
        });
        self.delete(&path, None).await?;
        if !safe {
            return Err("WebDAV 未正确执行条件写入，已拒绝开启双向同步".into());
        }
        if !inventory_valid {
            return Err("WebDAV 未正确返回文件大小和修改时间，无法安全核算和回收容量".into());
        }
        self.now()?;
        Ok(())
    }

    pub async fn acquire(&self) -> Result<Lease, String> {
        let owner = Uuid::new_v4().to_string();
        let previous = self.get("lease.json", 4096).await?;
        if let Some(file) = &previous {
            let value: LeaseData =
                serde_json::from_slice(&file.bytes).map_err(|_| "远端租约数据损坏")?;
            if value.expires_at > self.now()? {
                return Err("另一台电脑正在同步，请稍后重试".into());
            }
        }
        let bytes = serde_json::to_vec(&LeaseData {
            owner: owner.clone(),
            expires_at: self.now()? + 120_000,
        })
        .map_err(|_| "租约编码失败")?;
        let etag = self
            .put(
                "lease.json",
                bytes,
                previous.as_ref().map(|f| f.etag.as_str()),
            )
            .await?;
        Ok(Lease { owner, etag })
    }

    pub async fn renew(&self, lease: &mut Lease) -> Result<(), String> {
        let bytes = serde_json::to_vec(&LeaseData {
            owner: lease.owner.clone(),
            expires_at: self.now()? + 120_000,
        })
        .map_err(|_| "租约编码失败")?;
        lease.etag = self.put("lease.json", bytes, Some(&lease.etag)).await?;
        Ok(())
    }

    pub async fn release(&self, lease: &Lease) {
        if let Ok(bytes) = serde_json::to_vec(&LeaseData {
            owner: lease.owner.clone(),
            expires_at: 0,
        }) {
            let _ = self.put("lease.json", bytes, Some(&lease.etag)).await;
        }
    }

    pub async fn inventory(&self) -> Result<Vec<InventoryEntry>, String> {
        let mut result = Vec::new();
        for directory in ["", "assets/", "note-assets/"] {
            let response = self.request(Method::from_bytes(b"PROPFIND").unwrap(), directory)?
                .header("Depth", "1").header("Content-Type", "application/xml; charset=utf-8")
                .body("<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>")
                .send().await.map_err(transport_error)?;
            if response.status() != StatusCode::MULTI_STATUS {
                return Err(status_error(response.status()));
            }
            let bytes = Self::body(response, 4 * 1024 * 1024).await?;
            let xml = std::str::from_utf8(&bytes).map_err(|_| "WebDAV 目录列表不是 UTF-8")?;
            let list = parse_inventory(xml)?;
            for (href, size, modified_at) in list {
                let url = self.root.join(&href).map_err(|_| "WebDAV 返回了无效路径")?;
                if url.origin() != self.root.origin() {
                    return Err("WebDAV 返回了外部路径".into());
                }
                let Some(path) = url.path().strip_prefix(self.root.path()) else {
                    return Err("WebDAV 返回了目录外的路径".into());
                };
                if path.is_empty() || path.ends_with('/') {
                    continue;
                }
                result.push(InventoryEntry {
                    path: path.to_owned(),
                    size,
                    modified_at,
                });
            }
        }
        result.sort_by(|a, b| a.path.cmp(&b.path));
        result.dedup_by(|a, b| a.path == b.path);
        Ok(result)
    }

    pub async fn asset(&self, hash: &str, size: u64) -> Result<Vec<u8>, String> {
        if !super::protocol::valid_asset(hash) {
            return Err("图片标识无效".into());
        }
        let file = self
            .get(&format!("assets/{hash}.png"), size)
            .await?
            .ok_or("远端原图缺失")?;
        if file.bytes.len() as u64 != size || digest(&file.bytes) != hash {
            return Err("远端图片校验失败".into());
        }
        Ok(file.bytes)
    }

    pub async fn note_asset(&self, hash: &str, size: u64) -> Result<Vec<u8>, String> {
        if !super::protocol::valid_asset(hash) || size == 0 || size > crate::note_assets::MAX_ASSET
        {
            return Err("便签附件参数无效".into());
        }
        let file = self
            .get(&format!("note-assets/{hash}.bin"), size)
            .await?
            .ok_or("远端便签附件缺失")?;
        if file.bytes.len() as u64 != size || digest(&file.bytes) != hash {
            return Err("远端便签附件校验失败".into());
        }
        Ok(file.bytes)
    }
}

fn parse_inventory(xml: &str) -> Result<Vec<(String, u64, i64)>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut result = Vec::new();
    let mut field = String::new();
    let (mut href, mut length, mut modified, mut directory) = (String::new(), None, 0, false);
    loop {
        match reader.read_event().map_err(|_| "WebDAV 目录列表格式错误")? {
            Event::Start(e) => {
                field = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                if field == "response" {
                    href.clear();
                    length = None;
                    modified = 0;
                    directory = false;
                }
                if field == "collection" {
                    directory = true;
                }
            }
            Event::Empty(e) if e.local_name().as_ref() == b"collection" => {
                directory = true;
            }
            Event::Text(e) => {
                let decoded = e.decode().map_err(|_| "WebDAV 列表文本编码错误")?;
                let text =
                    quick_xml::escape::unescape(&decoded).map_err(|_| "WebDAV 列表文本错误")?;
                match field.as_str() {
                    "href" => href.push_str(&text),
                    "getcontentlength" => length = text.parse::<u64>().ok(),
                    "getlastmodified" => {
                        modified = chrono::DateTime::parse_from_rfc2822(&text)
                            .map(|d| d.timestamp_millis())
                            .unwrap_or(0)
                    }
                    _ => {}
                }
            }
            Event::End(e) => {
                if e.local_name().as_ref() == b"response" && !directory && !href.ends_with('/') {
                    if href.is_empty() {
                        return Err("WebDAV 列表缺少路径".into());
                    }
                    result.push((
                        href.clone(),
                        length.ok_or("WebDAV 未提供文件大小，无法核算容量")?,
                        modified,
                    ));
                }
                field.clear();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inventory_reads_namespaced_properties_and_rejects_unknown_size() {
        let xml = "<d:multistatus xmlns:d='DAV:'><d:response><d:href>/dav/pastepaw/v1/a.json</d:href><d:propstat><d:prop><d:getcontentlength>12</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>";
        assert_eq!(parse_inventory(xml).unwrap()[0].1, 12);
        assert!(
            parse_inventory(&xml.replace("<d:getcontentlength>12</d:getcontentlength>", ""))
                .is_err()
        );
    }

    struct TestServer {
        endpoint: String,
        files: std::sync::Arc<parking_lot::Mutex<std::collections::BTreeMap<String, Vec<u8>>>>,
        task: tokio::task::JoinHandle<()>,
    }
    #[derive(Clone, Copy)]
    enum TestEtags {
        Strong,
        TransientWeak,
        Weak,
        Missing,
    }
    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl TestServer {
        async fn start(conditional: bool, quota: u64, etags: TestEtags) -> Self {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!(
                "http://127.0.0.1:{}/dav/",
                listener.local_addr().unwrap().port()
            );
            let files = std::sync::Arc::new(parking_lot::Mutex::new(std::collections::BTreeMap::<
                String,
                Vec<u8>,
            >::new()));
            let storage = files.clone();
            let task = tokio::spawn(async move {
                let mut fresh_files = std::collections::BTreeSet::new();
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 4096];
                    let header_end;
                    loop {
                        let read = socket.read(&mut buffer).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..read]);
                        if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                            header_end = end + 4;
                            break;
                        }
                    }
                    let header = String::from_utf8_lossy(&request[..header_end]).into_owned();
                    let first: Vec<_> = header.lines().next().unwrap().split_whitespace().collect();
                    let method = first[0];
                    let path = first[1];
                    let headers: std::collections::BTreeMap<_, _> = header
                        .lines()
                        .skip(1)
                        .filter_map(|line| line.split_once(':'))
                        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
                        .collect();
                    let length: usize = headers
                        .get("content-length")
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                    while request.len() < header_end + length {
                        let read = socket.read(&mut buffer).await.unwrap_or(0);
                        if read == 0 {
                            break;
                        }
                        request.extend_from_slice(&buffer[..read]);
                    }
                    let body = &request[header_end..];
                    let (status, response, etag) = {
                        let mut files = storage.lock();
                        let previous = files.get(path).cloned();
                        let tag = previous
                            .as_ref()
                            .map(|bytes| format!("\"{}\"", digest(bytes)));
                        let precondition = !conditional
                            || (!headers
                                .get("if-none-match")
                                .is_some_and(|s| s == "*" && previous.is_some())
                                && !headers
                                    .get("if-match")
                                    .is_some_and(|s| Some(s) != tag.as_ref()));
                        match method {
                            "MKCOL" => (201, Vec::new(), None),
                            "GET" => match previous {
                                Some(bytes) => (200, bytes, tag),
                                None => (404, Vec::new(), None),
                            },
                            "PUT" if !precondition => (412, Vec::new(), None),
                            "PUT" => {
                                let total: u64 = files
                                    .iter()
                                    .filter(|(key, _)| key.as_str() != path)
                                    .map(|(_, bytes)| bytes.len() as u64)
                                    .sum();
                                if total + body.len() as u64 > quota {
                                    (507, Vec::new(), None)
                                } else {
                                    files.insert(path.into(), body.to_vec());
                                    (201, Vec::new(), Some(format!("\"{}\"", digest(body))))
                                }
                            }
                            "DELETE" if !precondition => (412, Vec::new(), None),
                            "DELETE" => {
                                files.remove(path);
                                (204, Vec::new(), None)
                            }
                            "PROPFIND" => {
                                let modified = (chrono::Utc::now() - chrono::Duration::hours(1))
                                    .format("%a, %d %b %Y %H:%M:%S GMT")
                                    .to_string();
                                let entries = files.iter().filter(|(key,_)| key.strip_prefix(path).is_some_and(|rest| !rest.is_empty() && !rest.contains('/')))
                                    .map(|(key,bytes)| format!("<d:response><d:href>{key}</d:href><d:propstat><d:prop><d:getcontentlength>{}</d:getcontentlength><d:getlastmodified>{modified}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",bytes.len())).collect::<String>();
                                (
                                    207,
                                    format!(
                                        "<d:multistatus xmlns:d=\"DAV:\">{entries}</d:multistatus>"
                                    )
                                    .into_bytes(),
                                    None,
                                )
                            }
                            _ => (405, Vec::new(), None),
                        }
                    };
                    if method == "PUT" && (200..300).contains(&status) {
                        fresh_files.insert(path.to_owned());
                    }
                    let etag = match etags {
                        TestEtags::Missing => None,
                        TestEtags::Weak => etag.map(|tag| format!("W/{tag}")),
                        TestEtags::TransientWeak
                            if method == "PUT" || (method == "GET" && fresh_files.remove(path)) =>
                        {
                            etag.map(|tag| format!("W/{tag}"))
                        }
                        _ => etag,
                    };
                    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT");
                    let tag = etag.map(|s| format!("ETag: {s}\r\n")).unwrap_or_default();
                    let response_header = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nDate: {date}\r\n{tag}Connection: close\r\n\r\n", response.len());
                    let _ = socket.write_all(response_header.as_bytes()).await;
                    let _ = socket.write_all(&response).await;
                }
            });
            Self {
                endpoint,
                files,
                task,
            }
        }
        fn remote(&self) -> Remote {
            Remote::new(Credentials {
                profile_id: Uuid::new_v4().to_string(),
                endpoint: self.endpoint.clone(),
                directory: "pastepaw".into(),
                username: "fixture-user".into(),
                password: "fixture-password".into(),
            })
            .unwrap()
        }
    }

    #[tokio::test]
    async fn real_http_probe_and_lease_exclude_simultaneous_writers() {
        let server = TestServer::start(true, 1024 * 1024, TestEtags::Strong).await;
        let first = server.remote();
        let second = server.remote();
        first.probe().await.unwrap();
        assert!(server.files.lock().is_empty());
        let lease = first.acquire().await.unwrap();
        assert!(second.acquire().await.is_err());
        first.release(&lease).await;
        let lease = second.acquire().await.unwrap();
        second.release(&lease).await;
        assert!((first.now().unwrap() - chrono::Utc::now().timestamp_millis()).abs() < 2000);
    }

    #[tokio::test]
    async fn rejects_servers_that_ignore_conditionals_and_reports_quota() {
        let server = TestServer::start(false, 1024 * 1024, TestEtags::Strong).await;
        assert!(server.remote().probe().await.is_err());
        let server = TestServer::start(true, 16, TestEtags::Strong).await;
        let error = server
            .remote()
            .put("oversize", vec![0; 32], None)
            .await
            .unwrap_err();
        assert!(error.contains("配额"));
        assert!(!error.contains(&server.endpoint));
    }

    #[tokio::test]
    async fn original_image_integrity_and_byte_limits_are_enforced() {
        let server = TestServer::start(true, 1024 * 1024, TestEtags::Strong).await;
        let remote = server.remote();
        let bytes = b"synthetic-image".to_vec();
        let hash = digest(&bytes);
        remote
            .put(&format!("assets/{hash}.png"), bytes.clone(), None)
            .await
            .unwrap();
        assert_eq!(
            remote.asset(&hash, bytes.len() as u64).await.unwrap(),
            bytes
        );
        assert!(remote.asset(&hash, 2).await.is_err());
        server.files.lock().insert(
            format!("/dav/pastepaw/v1/assets/{hash}.png"),
            vec![0; bytes.len()],
        );
        assert!(remote.asset(&hash, bytes.len() as u64).await.is_err());
        let path = format!("note-assets/{hash}.bin");
        remote.put(&path, bytes.clone(), None).await.unwrap();
        assert_eq!(
            remote.note_asset(&hash, bytes.len() as u64).await.unwrap(),
            bytes
        );
        server
            .files
            .lock()
            .insert(format!("/dav/pastepaw/v1/{path}"), vec![0; bytes.len()]);
        assert!(remote.note_asset(&hash, bytes.len() as u64).await.is_err());
        assert!(remote.note_asset("../escape", 1).await.is_err());
    }

    #[tokio::test]
    async fn transient_weak_etags_are_reread_without_losing_conditional_protection() {
        let server = TestServer::start(true, 1024 * 1024, TestEtags::TransientWeak).await;
        let first = server.remote();
        let second = server.remote();
        first.probe().await.unwrap();
        assert!(server.files.lock().is_empty());
        let mut lease = first.acquire().await.unwrap();
        assert!(!lease.etag.starts_with("W/"));
        assert!(second.acquire().await.is_err());
        first.renew(&mut lease).await.unwrap();
        first.release(&lease).await;
    }

    #[tokio::test]
    async fn persistent_weak_or_missing_etags_still_reject_bidirectional_sync() {
        for (etags, message) in [
            (TestEtags::Weak, "持续返回弱 ETag"),
            (TestEtags::Missing, "未返回 ETag"),
        ] {
            let server = TestServer::start(true, 1024 * 1024, etags).await;
            let error = server.remote().probe().await.unwrap_err();
            assert!(error.contains(message));
            assert!(!error.contains(&server.endpoint));
        }
    }

    #[tokio::test]
    #[ignore = "需要设置 PASTEPAW_WEBDAV_TEST_URL，指向使用虚拟账号的本机隔离 WebDAV 容器"]
    async fn bytemark_webdav_real_container_accepts_probe_and_enforces_stale_writes() {
        let endpoint = std::env::var("PASTEPAW_WEBDAV_TEST_URL").unwrap();
        let url = Url::parse(&endpoint).unwrap();
        assert!(matches!(url.host_str(), Some("127.0.0.1" | "localhost")));
        let credentials = Credentials {
            profile_id: Uuid::new_v4().to_string(),
            endpoint,
            directory: "pastepaw-compat".into(),
            username: "fixture-user".into(),
            password: "fixture-password".into(),
        };
        let first = Remote::new(credentials.clone()).unwrap();
        let second = Remote::new(credentials).unwrap();
        first.probe().await.unwrap();
        let mut lease = first.acquire().await.unwrap();
        assert!(second.acquire().await.is_err());
        first.renew(&mut lease).await.unwrap();
        first.release(&lease).await;
        let lease = second.acquire().await.unwrap();
        second.release(&lease).await;
        let original = first
            .put("compat-notes.json", b"{}".to_vec(), None)
            .await
            .unwrap();
        let current = first
            .put(
                "compat-notes.json",
                b"{\"ok\":true}".to_vec(),
                Some(&original),
            )
            .await
            .unwrap();
        assert!(second
            .put("compat-notes.json", b"{}".to_vec(), Some(&original))
            .await
            .is_err());
        assert_eq!(
            first
                .get("compat-notes.json", 1024)
                .await
                .unwrap()
                .unwrap()
                .bytes,
            b"{\"ok\":true}"
        );
        first
            .delete("compat-notes.json", Some(&current))
            .await
            .unwrap();
    }
}
