use crate::{
    database::Database,
    sync::protocol::{digest, valid_asset, MIB},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::{collections::BTreeSet, sync::Arc};
use tauri::{AppHandle, Manager};

pub const MAX_ASSET: u64 = 20 * MIB;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, sqlx::FromRow)]
pub struct Asset {
    pub hash: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
}
impl Asset {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_asset(&self.hash)
            || self.size <= 0
            || self.size as u64 > MAX_ASSET
            || self.name.is_empty()
            || self.name.len() > 512
            || self.name.contains(['/', '\\', '\0'])
            || !matches!(
                self.mime.as_str(),
                "image/png"
                    | "image/jpeg"
                    | "image/gif"
                    | "image/webp"
                    | "application/octet-stream"
            )
        {
            return Err("附件标识、名称、类型或大小无效".into());
        }
        Ok(())
    }
}
pub async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("CREATE TABLE IF NOT EXISTS note_assets(hash TEXT PRIMARY KEY,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,bytes BLOB NOT NULL,created_at INTEGER NOT NULL)")
        .execute(pool).await?;
    Ok(())
}
pub fn references(html: &str) -> BTreeSet<String> {
    // 只读取标签属性，代码块中的附件 HTML 示例不会被误判为真实引用。
    let mut reader = quick_xml::Reader::from_str(html);
    reader.config_mut().check_end_names = false;
    reader.config_mut().allow_unmatched_ends = true;
    let mut result = BTreeSet::new();
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(tag) | quick_xml::events::Event::Empty(tag)) => {
                for attr in tag.attributes().with_checks(false).flatten() {
                    if attr.key.as_ref() == b"data-asset" {
                        if let Ok(hash) = attr.decode_and_unescape_value(reader.decoder()) {
                            if valid_asset(&hash) {
                                result.insert(hash.into_owned());
                            }
                        }
                    }
                }
            }
            Ok(quick_xml::events::Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    result
}
pub async fn metadata(pool: &SqlitePool, hash: &str) -> Result<Asset, String> {
    sqlx::query_as("SELECT hash,name,mime,size FROM note_assets WHERE hash=?")
        .bind(hash)
        .fetch_optional(pool)
        .await
        .map_err(|_| "附件索引读取失败")?
        .ok_or_else(|| "本地附件缺失，请先完成同步".into())
}
pub async fn bytes(pool: &SqlitePool, hash: &str) -> Result<Vec<u8>, String> {
    if !valid_asset(hash) {
        return Err("附件标识无效".into());
    }
    let value: Vec<u8> = sqlx::query_scalar("SELECT bytes FROM note_assets WHERE hash=?")
        .bind(hash)
        .fetch_optional(pool)
        .await
        .map_err(|_| "附件读取失败")?
        .ok_or("本地附件缺失，请先完成同步")?;
    if value.len() as u64 > MAX_ASSET || digest(&value) != hash {
        return Err("本地附件校验失败".into());
    }
    Ok(value)
}
pub async fn persist(pool: &SqlitePool, asset: &Asset, bytes: &[u8]) -> Result<(), String> {
    asset.validate()?;
    if bytes.len() as i64 != asset.size || digest(bytes) != asset.hash {
        return Err("附件内容校验失败".into());
    }
    let mut tx = pool.begin().await.map_err(|_| "附件保存失败")?;
    // 删除超过一天且没有任何便签引用的资源；新插入、撤销中的附件留出恢复窗口。
    sqlx::query("DELETE FROM note_assets WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM notes WHERE instr(content,'data-asset=\"'||note_assets.hash||'\"')>0)")
        .bind(chrono::Utc::now().timestamp_millis() - 86_400_000).execute(&mut *tx).await.map_err(|_| "附件回收失败")?;
    let used: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(size),0) FROM note_assets WHERE hash<>?")
            .bind(&asset.hash)
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| "附件容量读取失败")?;
    if used.saturating_add(asset.size) > (500 * MIB) as i64 {
        return Err("本地便签附件达到 500 MiB，请清理不需要的附件后重试".into());
    }
    sqlx::query("INSERT OR IGNORE INTO note_assets VALUES(?,?,?,?,?,?)")
        .bind(&asset.hash)
        .bind(&asset.name)
        .bind(&asset.mime)
        .bind(asset.size)
        .bind(bytes)
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(&mut *tx)
        .await
        .map_err(|_| "附件保存失败")?;
    tx.commit().await.map_err(|_| "附件保存失败")?;
    Ok(())
}
#[tauri::command]
pub async fn store_note_asset(
    bytes: Vec<u8>,
    name: String,
    mime: String,
    db: tauri::State<'_, Arc<Database>>,
) -> Result<Asset, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_ASSET {
        return Err("单个附件不能超过 20 MiB".into());
    }
    let safe_name: String = name
        .chars()
        .filter(|c| !c.is_control() && !"/\\<>:\"|?*".contains(*c))
        .take(120)
        .collect();
    let detected = match image::guess_format(&bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::Gif) => "image/gif",
        Ok(image::ImageFormat::WebP) => "image/webp",
        _ => "application/octet-stream",
    };
    // MIME 来自文件内容，SVG 和任意 HTML 作为附件下载，不作为活动内容渲染。
    let _ = mime;
    let asset = Asset {
        hash: digest(&bytes),
        name: if safe_name.is_empty() {
            "附件".into()
        } else {
            safe_name
        },
        mime: detected.into(),
        size: bytes.len() as i64,
    };
    persist(&db.pool, &asset, &bytes).await?;
    Ok(asset)
}
#[tauri::command]
pub async fn read_note_asset(
    hash: String,
    db: tauri::State<'_, Arc<Database>>,
) -> Result<String, String> {
    let asset = metadata(&db.pool, &hash).await?;
    if !asset.mime.starts_with("image/") {
        return Err("此附件不是可显示的图片".into());
    }
    Ok(format!(
        "data:{};base64,{}",
        asset.mime,
        base64::engine::general_purpose::STANDARD.encode(bytes(&db.pool, &hash).await?)
    ))
}
#[tauri::command]
pub async fn save_note_asset(app: AppHandle, hash: String, name: String) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    let data = bytes(&app.state::<Arc<Database>>().pool, &hash).await?;
    let file_name: String = name
        .chars()
        .filter(|c| !c.is_control() && !"/\\<>:\"|?*".contains(*c))
        .take(120)
        .collect();
    let target = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(file_name)
            .blocking_save_file()
    })
    .await
    .map_err(|_| "另存对话框失败")?;
    if let Some(path) = target {
        let path = path.into_path().map_err(|_| "保存路径无效")?;
        tokio::fs::write(path, data)
            .await
            .map_err(|_| "附件保存失败，请检查权限和磁盘空间")?;
    }
    Ok(())
}
#[tauri::command]
pub fn open_note_link(url: String) -> Result<(), String> {
    use windows::{
        core::PCWSTR,
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };
    let parsed = reqwest::Url::parse(&url).map_err(|_| "链接格式无效")?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || url.contains('\0')
    {
        return Err("只支持 HTTP、HTTPS 和邮件链接".into());
    }
    let action: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = parsed.as_str().encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(action.as_ptr()),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        return Err("无法打开链接".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn asset_roundtrip_dedup_and_integrity() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE notes(content TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        migrate(&pool).await.unwrap();
        let value = b"test attachment";
        let asset = Asset {
            hash: digest(value),
            name: "测试.txt".into(),
            mime: "application/octet-stream".into(),
            size: value.len() as i64,
        };
        persist(&pool, &asset, value).await.unwrap();
        persist(&pool, &asset, value).await.unwrap();
        assert_eq!(bytes(&pool, &asset.hash).await.unwrap(), value);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM note_assets")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert!(persist(&pool, &asset, b"tampered").await.is_err());
        assert!(bytes(&pool, "../../secrets").await.is_err());
        assert_eq!(
            references(&format!("<img data-asset=\"{}\">", asset.hash)).len(),
            1
        );
        assert_eq!(
            references(&format!("<img data-asset='{}'>", asset.hash)).len(),
            1
        );
        assert!(references(&format!(
            "<pre><code>&lt;img data-asset=\"{}\"&gt;</code></pre>",
            asset.hash
        ))
        .is_empty());
    }
}
