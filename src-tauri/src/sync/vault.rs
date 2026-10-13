use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use pbkdf2::pbkdf2_hmac;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{fs, path::Path};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const ITERATIONS: u32 = 600_000;
const AAD: &[u8] = b"pastepaw-webdav-vault-v1";

// 凭据禁止实现 Debug，避免日志意外打印；释放时清理字符串。
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct Credentials {
    #[serde(default = "profile_id")]
    pub profile_id: String,
    pub endpoint: String,
    pub directory: String,
    pub username: String,
    pub password: String,
}

fn profile_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Credentials {
    pub fn root(&self) -> Result<reqwest::Url, String> {
        if uuid::Uuid::parse_str(&self.profile_id).is_err()
            || [&self.endpoint, &self.username, &self.password]
                .iter()
                .any(|s| s.len() > 4096)
        {
            return Err("连接信息长度或配置标识无效".into());
        }
        let mut url = reqwest::Url::parse(&self.endpoint).map_err(|_| "WebDAV 地址格式不正确")?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "请使用 HTTP 或 HTTPS 地址，账号密码单独填写；地址不能带查询参数或片段".into(),
            );
        }
        if self.directory.is_empty()
            || self.directory.len() > 64
            || !self
                .directory
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            || self.username.is_empty()
            || self.password.is_empty()
        {
            return Err("请填写账号密码；专用目录仅允许英文字母、数字、短横线和下划线".into());
        }
        url.path_segments_mut()
            .map_err(|_| "WebDAV 地址不支持目录")?
            .pop_if_empty()
            .push(&self.directory)
            .push("v1")
            .push("");
        Ok(url)
    }

    pub fn scope(&self) -> Result<String, String> {
        self.root()?;
        // 本地基线采用随机配置标识，避免通过地址/账号的裸哈希猜测连接信息。
        Ok(self.profile_id.clone())
    }

    pub fn is_sensitive_text(&self, text: &str) -> bool {
        text == self.username
            || text.contains(&self.endpoint)
            || (!self.password.is_empty() && text.contains(&self.password))
    }
}

#[derive(Serialize, Deserialize)]
struct Vault {
    version: u32,
    iterations: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

pub fn encrypt(credentials: &Credentials, password: &str) -> Result<String, String> {
    if password.chars().count() < 6 || password.len() > 1024 {
        return Err("独立解锁密码至少 6 个字符，且不超过 1024 字节".into());
    }
    credentials.root()?;
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let mut key = Zeroizing::new([0u8; 32]);
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, ITERATIONS, key.as_mut());
    let plain = Zeroizing::new(serde_json::to_vec(credentials).map_err(|_| "凭据编码失败")?);
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "凭据加密初始化失败")?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plain,
                aad: AAD,
            },
        )
        .map_err(|_| "凭据加密失败")?;
    serde_json::to_string_pretty(&Vault {
        version: 1,
        iterations: ITERATIONS,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
    .map_err(|_| "凭据文件编码失败".into())
}

pub fn decrypt(json: &str, password: &str) -> Result<Credentials, String> {
    if json.len() > 64 * 1024 || password.len() > 1024 {
        return Err("凭据文件或密码长度异常".into());
    }
    let vault: Vault = serde_json::from_str(json).map_err(|_| "凭据文件损坏")?;
    if vault.version != 1 || !(ITERATIONS..=2_000_000).contains(&vault.iterations) {
        return Err("不支持的凭据文件版本或加密参数".into());
    }
    let salt = STANDARD.decode(&vault.salt).map_err(|_| "凭据文件损坏")?;
    let nonce = STANDARD.decode(&vault.nonce).map_err(|_| "凭据文件损坏")?;
    if salt.len() != 16 || nonce.len() != 12 {
        return Err("凭据文件损坏".into());
    }
    let ciphertext = STANDARD
        .decode(&vault.ciphertext)
        .map_err(|_| "凭据文件损坏")?;
    let mut key = Zeroizing::new([0u8; 32]);
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, vault.iterations, key.as_mut());
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "凭据解密初始化失败")?;
    let plain = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: AAD,
                },
            )
            .map_err(|_| "解锁密码不正确或凭据文件被修改")?,
    );
    let credentials: Credentials =
        serde_json::from_slice(&plain).map_err(|_| "凭据文件内容异常")?;
    credentials.root()?;
    Ok(credentials)
}

pub fn save(path: &Path, json: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("凭据目录无效")?;
    fs::create_dir_all(parent).map_err(|_| "安装目录不可写，请调整安装位置或目录权限")?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|_| "无法写入凭据，请检查安装目录权限")?;
    fs::rename(&tmp, path).map_err(|_| "无法替换凭据文件，请检查目录权限".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_is_authenticated_and_contains_no_plain_secrets() {
        let credentials = Credentials {
            profile_id: profile_id(),
            endpoint: "https://example.invalid/dav/".into(),
            directory: "pastepaw".into(),
            username: "fixture-user".into(),
            password: "fixture-password".into(),
        };
        let json = encrypt(&credentials, "fixture-unlock-password").unwrap();
        for secret in [
            &credentials.endpoint,
            &credentials.username,
            &credentials.password,
        ] {
            assert!(!json.contains(secret));
        }
        assert_eq!(
            decrypt(&json, "fixture-unlock-password").unwrap().username,
            credentials.username
        );
        assert!(decrypt(&json, "incorrect-password").is_err());
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        value["ciphertext"] = serde_json::json!(STANDARD.encode([0; 32]));
        assert!(decrypt(&value.to_string(), "fixture-unlock-password").is_err());
    }

    #[test]
    fn allows_http_and_six_character_unlock_password() {
        let mut credentials = Credentials {
            profile_id: profile_id(),
            endpoint: "http://example.invalid/dav/".into(),
            directory: "pastepaw".into(),
            username: "fixture-user".into(),
            password: "fixture-password".into(),
        };
        assert_eq!(
            credentials.root().unwrap().as_str(),
            "http://example.invalid/dav/pastepaw/v1/"
        );
        assert!(encrypt(&credentials, "12345").is_err());
        assert!(encrypt(&credentials, "🔑🔑🔑🔑🔑").is_err());
        let json = encrypt(&credentials, "123456").unwrap();
        assert_eq!(
            decrypt(&json, "123456").unwrap().endpoint,
            credentials.endpoint
        );
        credentials.endpoint = "ftp://example.invalid/dav/".into();
        assert!(credentials.root().is_err());
        credentials.endpoint = "http://user:pass@example.invalid/dav/".into();
        assert!(credentials.root().is_err());
    }

    #[test]
    fn rejects_credential_urls_and_path_escape() {
        let mut c = Credentials {
            profile_id: profile_id(),
            endpoint: "https://user:pass@example.invalid/".into(),
            directory: "pastepaw".into(),
            username: "u".into(),
            password: "p".into(),
        };
        assert!(c.root().is_err());
        c.endpoint = "https://example.invalid/dav/".into();
        c.directory = "../other".into();
        assert!(c.root().is_err());
    }
}
