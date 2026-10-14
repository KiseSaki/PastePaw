pub mod conflicts;
mod note_merge;
pub mod protocol;
mod remote;
pub mod store;
mod vault;

use crate::database::Database;
use parking_lot::Mutex;
use protocol::*;
use remote::{InventoryEntry, Lease, Remote};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::watch;
use vault::Credentials;
use zeroize::Zeroizing;

static PRIVATE_INPUT_UNTIL: AtomicI64 = AtomicI64::new(0);
static MANUAL_PAUSE_UNTIL: AtomicI64 = AtomicI64::new(0);
static NOTE_PENDING: once_cell::sync::Lazy<Mutex<BTreeMap<String, (u64, Instant)>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(BTreeMap::new()));
pub fn private_input_active() -> bool {
    PRIVATE_INPUT_UNTIL
        .load(Ordering::Relaxed)
        .max(MANUAL_PAUSE_UNTIL.load(Ordering::Relaxed))
        > chrono::Utc::now().timestamp_millis()
}

#[tauri::command]
pub fn pause_sync_clipboard(minutes: u64) -> Result<(), String> {
    if minutes > 15 {
        return Err("暂停时长不能超过 15 分钟".into());
    }
    MANUAL_PAUSE_UNTIL.store(
        if minutes == 0 {
            0
        } else {
            chrono::Utc::now().timestamp_millis() + (minutes * 60_000) as i64
        },
        Ordering::Relaxed,
    );
    Ok(())
}

#[tauri::command]
pub fn set_sync_note_pending(id: String, token: u64, pending: bool) {
    if uuid::Uuid::parse_str(&id).is_err() {
        return;
    }
    let mut notes = NOTE_PENDING.lock();
    notes.retain(|_, (_, time)| time.elapsed() < Duration::from_secs(30));
    if pending {
        notes.insert(id, (token, Instant::now()));
    } else if notes.get(&id).is_some_and(|(current, _)| *current == token) {
        notes.remove(&id);
    }
}

pub fn note_pending(id: &str) -> bool {
    NOTE_PENDING
        .lock()
        .get(id)
        .is_some_and(|(_, time)| time.elapsed() < Duration::from_secs(30))
}

struct Session {
    credentials: Credentials,
    expires: Instant,
}
pub struct SyncManager {
    path: PathBuf,
    session: Mutex<Option<Session>>,
    busy: AtomicBool,
    dirty: AtomicBool,
    cancel: watch::Sender<u64>,
    report: Mutex<Option<SyncReport>>,
    error: Mutex<Option<String>>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct SyncReport {
    pub notes: usize,
    pub clips: usize,
    pub conflicts: usize,
    pub merged: usize,
    pub skipped: usize,
    pub used_bytes: u64,
    pub finished_at: String,
}

#[derive(Serialize)]
pub struct SyncStatus {
    configured: bool,
    unlocked: bool,
    busy: bool,
    vault_path: String,
    options: SyncOptions,
    last_result: Option<SyncReport>,
    last_error: Option<String>,
    capture_paused_until: i64,
}

impl SyncManager {
    pub fn new() -> Result<Self, std::io::Error> {
        let exe = std::env::current_exe()?;
        let path = exe
            .parent()
            .ok_or_else(|| std::io::Error::other("无法定位安装目录"))?
            .join("secrets")
            .join("webdav.vault.json");
        Ok(Self {
            path,
            session: Mutex::new(None),
            busy: AtomicBool::new(false),
            dirty: AtomicBool::new(false),
            cancel: watch::channel(0).0,
            report: Mutex::new(None),
            error: Mutex::new(None),
        })
    }
    fn lock(&self) {
        *self.session.lock() = None;
        self.cancel.send_modify(|generation| *generation += 1);
    }
    fn credentials(&self) -> Result<Credentials, String> {
        let mut session = self.session.lock();
        if session
            .as_ref()
            .is_some_and(|s| Instant::now() >= s.expires)
        {
            *session = None;
            self.cancel.send_modify(|generation| *generation += 1);
        }
        session
            .as_ref()
            .map(|s| s.credentials.clone())
            .ok_or_else(|| "请先解锁 WebDAV 凭据".into())
    }
    fn enter(&self) -> Result<BusyGuard<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "正在处理同步，请稍后重试")?;
        Ok(BusyGuard(self))
    }
}

struct BusyGuard<'a>(&'a SyncManager);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
    }
}

async fn options(db: &Database) -> Result<SyncOptions, String> {
    let value = match db.get_setting("webdav_sync_options").await {
        Some(value) => serde_json::from_str(&value).map_err(|_| "同步设置损坏")?,
        None => SyncOptions::default(),
    };
    value.validate()?;
    Ok(value)
}

#[tauri::command]
pub async fn get_sync_status(app: AppHandle) -> Result<SyncStatus, String> {
    let db = app.state::<Arc<Database>>();
    let manager = app.state::<Arc<SyncManager>>();
    let unlocked = manager.credentials().is_ok();
    let last_result = manager.report.lock().clone();
    let last_error = manager.error.lock().clone();
    Ok(SyncStatus {
        configured: manager.path.exists(),
        unlocked,
        busy: manager.busy.load(Ordering::SeqCst),
        vault_path: manager.path.to_string_lossy().into_owned(),
        options: options(&db).await?,
        last_result,
        last_error,
        capture_paused_until: MANUAL_PAUSE_UNTIL.load(Ordering::Relaxed),
    })
}

#[tauri::command]
pub async fn save_sync_options(app: AppHandle, settings: SyncOptions) -> Result<(), String> {
    settings.validate()?;
    let manager = app.state::<Arc<SyncManager>>();
    let _guard = manager.enter()?;
    let db = app.state::<Arc<Database>>();
    let before = options(&db).await?;
    let mut tx = db.pool.begin().await.map_err(|_| "无法保存同步设置")?;
    if before.policy != settings.policy {
        sqlx::query("INSERT INTO settings(key,value) VALUES('webdav_policy_dirty','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .execute(&mut *tx).await.map_err(|_| "容量策略保存失败")?;
    }
    sqlx::query("INSERT INTO settings(key,value) VALUES('webdav_sync_options',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(serde_json::to_string(&settings).map_err(|_| "同步设置编码失败")?).execute(&mut *tx).await.map_err(|_| "同步设置保存失败")?;
    tx.commit().await.map_err(|_| "同步设置保存失败")?;
    manager.dirty.store(true, Ordering::Relaxed);
    if !settings.enabled {
        manager.lock();
    }
    Ok(())
}

#[tauri::command]
pub fn set_sync_private_input(active: bool) {
    // 输入窗口意外关闭后，暂停状态最多保留一分钟。
    PRIVATE_INPUT_UNTIL.store(
        chrono::Utc::now().timestamp_millis() + if active { 60_000 } else { 2_000 },
        Ordering::Relaxed,
    );
}

#[tauri::command]
pub async fn save_sync_credentials(
    app: AppHandle,
    credentials: Credentials,
    unlock_password: String,
) -> Result<(), String> {
    let unlock = Zeroizing::new(unlock_password);
    let manager = app.state::<Arc<SyncManager>>();
    let _guard = manager.enter()?;
    let db = app.state::<Arc<Database>>();
    let seconds = options(&db).await?.lock_after_minutes * 60;
    let plaintext = credentials.clone();
    let encryption_password = unlock.clone();
    let json = tauri::async_runtime::spawn_blocking(move || {
        vault::encrypt(&plaintext, &encryption_password)
    })
    .await
    .map_err(|_| "凭据加密任务失败")??;
    vault::save(&manager.path, &json)?;
    store::scrub(&db.pool, &credentials, &unlock).await?;
    let _ = app.emit(
        "clipboard-change",
        serde_json::json!({"action":"privacy-cleanup"}),
    );
    manager.lock();
    *manager.session.lock() = Some(Session {
        credentials,
        expires: Instant::now() + Duration::from_secs(seconds),
    });
    *manager.error.lock() = None;
    Ok(())
}

#[tauri::command]
pub async fn unlock_sync_credentials(
    app: AppHandle,
    unlock_password: String,
) -> Result<(), String> {
    let unlock = Zeroizing::new(unlock_password);
    let manager = app.state::<Arc<SyncManager>>();
    let _guard = manager.enter()?;
    let db = app.state::<Arc<Database>>();
    let seconds = options(&db).await?.lock_after_minutes * 60;
    let size = std::fs::metadata(&manager.path)
        .map_err(|_| "凭据文件不存在或无法读取")?
        .len();
    if size > 64 * 1024 {
        return Err("凭据文件过大".into());
    }
    let json = std::fs::read_to_string(&manager.path).map_err(|_| "无法读取 UTF-8 凭据文件")?;
    let decryption_password = unlock.clone();
    let credentials =
        tauri::async_runtime::spawn_blocking(move || vault::decrypt(&json, &decryption_password))
            .await
            .map_err(|_| "凭据解锁任务失败")??;
    store::scrub(&db.pool, &credentials, &unlock).await?;
    let _ = app.emit(
        "clipboard-change",
        serde_json::json!({"action":"privacy-cleanup"}),
    );
    manager.lock();
    *manager.session.lock() = Some(Session {
        credentials,
        expires: Instant::now() + Duration::from_secs(seconds),
    });
    Ok(())
}

#[tauri::command]
pub fn lock_sync_credentials(app: AppHandle) {
    app.state::<Arc<SyncManager>>().lock();
}

#[tauri::command]
pub fn forget_sync_credentials(app: AppHandle) -> Result<(), String> {
    let manager = app.state::<Arc<SyncManager>>();
    let _guard = manager.enter()?;
    manager.lock();
    for path in [&manager.path, &manager.path.with_extension("tmp")] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法清除凭据文件，请检查安装目录权限".into()),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn test_sync_connection(app: AppHandle) -> Result<String, String> {
    let manager = app.state::<Arc<SyncManager>>();
    let _guard = manager.enter()?;
    let credentials = manager.credentials()?;
    let scope = credentials.scope()?;
    let remote = Remote::new(credentials)?;
    let mut cancellation = manager.cancel.subscribe();
    tokio::select! {
        result = remote.probe() => { result?; },
        _ = cancellation.changed() => { return Err("凭据已锁定，连接测试已取消".into()); }
    }
    app.state::<Arc<Database>>()
        .set_setting(&format!("sync-tested-{scope}"), "1")
        .await
        .map_err(|_| "连接验证结果保存失败")?;
    Ok("连接通过：目录读写、条件更新、删除和容量核算均可用。服务器硬配额仍须在服务端设置。".into())
}

fn decode_document(file: &Option<remote::File>, space: &str) -> Result<Document, String> {
    let document = match file {
        Some(file) => serde_json::from_slice(&file.bytes).map_err(|_| "远端同步文件损坏")?,
        None => Document::new(space.into()),
    };
    document.validate()?;
    Ok(document)
}

fn validate_payloads(document: &Document, notes: bool) -> Result<(), String> {
    use base64::Engine;
    for record in document.records.values() {
        if let Some(value) = &record.data {
            if notes {
                let data: NoteData =
                    serde_json::from_value(value.clone()).map_err(|_| "远端便签记录格式异常")?;
                chrono::DateTime::parse_from_rfc3339(&data.created_at)
                    .map_err(|_| "远端便签时间无效")?;
                chrono::DateTime::parse_from_rfc3339(&data.updated_at)
                    .map_err(|_| "远端便签时间无效")?;
                if crate::note_assets::references(&data.content)
                    .iter()
                    .any(|hash| !document.note_assets.contains_key(hash))
                {
                    return Err("远端便签的附件索引不完整".into());
                }
            } else {
                let data: ClipData =
                    serde_json::from_value(value.clone()).map_err(|_| "远端剪切板记录格式异常")?;
                chrono::DateTime::parse_from_rfc3339(&data.created_at)
                    .map_err(|_| "远端剪切板时间无效")?;
                if !valid_asset(&data.content_hash)
                    || data
                        .folder_uuid
                        .as_ref()
                        .is_some_and(|id| !document.folders.contains_key(id))
                {
                    return Err("远端剪切板标识或分组关系无效".into());
                }
                match data.clip_type.as_str() {
                    "text" => {
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(&data.content)
                            .map_err(|_| "远端文本编码异常")?;
                        if data.asset.is_some()
                            || bytes.len() as u64 != data.size_bytes
                            || digest(&bytes) != data.content_hash
                            || std::str::from_utf8(&bytes).is_err()
                        {
                            return Err("远端文本校验失败".into());
                        }
                    }
                    "image" => {
                        if !data.content.is_empty()
                            || !data.asset.as_deref().is_some_and(valid_asset)
                            || data.size_bytes == 0
                        {
                            return Err("远端图片索引异常".into());
                        }
                    }
                    _ => return Err("不支持的远端剪切板类型".into()),
                }
            }
        }
    }
    Ok(())
}

fn same_document(a: &Document, b: &Document) -> bool {
    a.records == b.records
        && a.folders == b.folders
        && a.policy == b.policy
        && a.note_assets == b.note_assets
        && a.schema_version == b.schema_version
        && a.note_conflicts == b.note_conflicts
}
fn encoded(document: &Document) -> Result<Vec<u8>, String> {
    document.validate()?;
    let bytes = serde_json::to_vec(document).map_err(|_| "同步文件编码失败")?;
    if bytes.len() as u64 > MAX_DOCUMENT {
        return Err("同步索引超过 32 MiB，请减少内容或迁移同步空间".into());
    }
    Ok(bytes)
}
fn used(inventory: &[InventoryEntry]) -> u64 {
    inventory
        .iter()
        .fold(0u64, |total, entry| total.saturating_add(entry.size))
}
fn budget(inventory: &[InventoryEntry], extra: u64, policy: &CloudPolicy) -> Result<(), String> {
    if used(inventory)
        .saturating_add(extra)
        .saturating_add(256 * 1024)
        > policy.total_mib * MIB
    {
        return Err("云端总容量不足，已暂停上传；便签和本地记录均保留".into());
    }
    Ok(())
}

fn asset_references(document: &Document) -> Result<HashSet<String>, String> {
    let mut result = HashSet::new();
    for record in document.records.values() {
        if let Some(data) = &record.data {
            let clip: ClipData =
                serde_json::from_value(data.clone()).map_err(|_| "剪切板记录格式异常")?;
            if let Some(hash) = clip.asset {
                if !valid_asset(&hash) {
                    return Err("原图标识无效".into());
                }
                result.insert(format!("assets/{hash}.png"));
            }
        }
    }
    Ok(result)
}

fn note_references(document: &Document) -> HashSet<String> {
    document
        .note_assets
        .keys()
        .map(|hash| format!("note-assets/{hash}.bin"))
        .collect()
}

async fn cleanup(
    remote: &Remote,
    lease: &mut Lease,
    references: &HashSet<String>,
    inventory: &mut Vec<InventoryEntry>,
) -> Result<(), String> {
    let cutoff = remote.now()? - 120_000;
    let garbage: Vec<String> = inventory
        .iter()
        .filter(|entry| {
            let asset = entry
                .path
                .strip_prefix("assets/")
                .and_then(|p| p.strip_suffix(".png"))
                .is_some_and(valid_asset);
            let probe = entry
                .path
                .strip_prefix("probe-")
                .and_then(|p| p.strip_suffix(".json"))
                .is_some_and(|p| uuid::Uuid::parse_str(p).is_ok());
            let note_asset = entry
                .path
                .strip_prefix("note-assets/")
                .and_then(|p| p.strip_suffix(".bin"))
                .is_some_and(valid_asset);
            (asset || note_asset || probe)
                && !references.contains(&entry.path)
                && entry.modified_at > 0
                && entry.modified_at < cutoff
        })
        .map(|entry| entry.path.clone())
        .collect();
    for path in garbage {
        remote.renew(lease).await?;
        remote.delete(&path, None).await?;
        inventory.retain(|entry| entry.path != path);
    }
    Ok(())
}

async fn execute(app: &AppHandle, credentials: Credentials) -> Result<SyncReport, String> {
    let scope = credentials.scope()?;
    let db = app.state::<Arc<Database>>();
    if db
        .get_setting(&format!("sync-tested-{scope}"))
        .await
        .as_deref()
        != Some("1")
    {
        return Err("请先点击测试连接，验证服务器支持安全的双向同步".into());
    }
    let mut settings = options(&db).await?;
    if !settings.enabled {
        return Err("请先开启 WebDAV 同步".into());
    }
    let remote = Remote::new(credentials.clone())?;
    remote.initialize().await?;
    let mut lease = remote.acquire().await?;
    let outcome = async {
        let notes_file = remote.get("notes.json", MAX_DOCUMENT).await?;
        let clips_file = remote.get("clipboard.json", MAX_DOCUMENT).await?;
        let default_space = uuid::Uuid::new_v4().to_string();
        let mut notes = decode_document(&notes_file, &default_space)?;
        let space = if notes_file.is_some() {
            notes.space_id.clone()
        } else {
            decode_document(&clips_file, &default_space)?.space_id
        };
        notes.space_id = space.clone();
        let mut clips = decode_document(&clips_file, &space)?;
        validate_payloads(&notes, true)?;
        validate_payloads(&clips, false)?;
        if clips.space_id != space {
            return Err("便签和剪切板属于不同同步空间，已停止同步".into());
        }
        let policy_dirty = db.get_setting("webdav_policy_dirty").await.as_deref() == Some("true");
        if !policy_dirty {
            if let Some(policy) = &clips.policy {
                settings.policy = policy.clone();
            }
        }
        let policy = settings.policy.clone();
        let notes_base = store::baseline(&db.pool, &scope, "notes", &space).await?;
        let clips_base = store::baseline(&db.pool, &scope, "clipboard", &space).await?;
        if (notes_base.generation > 0 && (notes_file.is_none() || notes_base.space_id != space))
            || (clips_base.generation > 0 && (clips_file.is_none() || clips_base.space_id != space))
        {
            return Err("远端空间被重置或同步文件缺失，请恢复备份或使用新的专用目录".into());
        }
        let mut inventory = remote.inventory().await?;
        let backup_file = remote.get("notes-backup.json", MAX_DOCUMENT).await?;
        let backup_notes = decode_document(&backup_file, &space)?;
        let mut protected = asset_references(&clips)?;
        protected.extend(note_references(&notes));
        protected.extend(note_references(&backup_notes));
        cleanup(&remote, &mut lease, &protected, &mut inventory).await?;
        let local_notes =
            store::capture(&db.pool, "notes", &notes_base, &policy, &credentials).await?;
        let (merged_notes, note_conflicts, auto_merged) =
            merge_detailed(&notes_base, &local_notes.document, &notes, true);
        // 先完整上传和验证资源，再发布正文索引；失败时远端原正文仍然可读。
        for (hash, asset) in &merged_notes.note_assets {
            let path = format!("note-assets/{hash}.bin");
            remote.renew(&mut lease).await?;
            if inventory.iter().any(|e| e.path == path) {
                if crate::note_assets::metadata(&db.pool, hash).await.is_err() {
                    let bytes = remote.note_asset(hash, asset.size as u64).await?;
                    crate::note_assets::persist(&db.pool, asset, &bytes).await?;
                }
            } else {
                let bytes = crate::note_assets::bytes(&db.pool, hash).await?;
                budget(&inventory, bytes.len() as u64, &policy)?;
                remote.put(&path, bytes.clone(), None).await?;
                inventory.push(InventoryEntry {
                    path,
                    size: bytes.len() as u64,
                    modified_at: remote.now()?,
                });
            }
        }
        let notes_changed = !same_document(&merged_notes, &notes_base);
        if !same_document(&merged_notes, &notes) || notes_file.is_none() {
            let bytes = encoded(&merged_notes)?;
            if let Some(previous) = &notes_file {
                // 只保留一份上一版便签，覆盖失败时仍有可恢复的完整内容，并计入总额度。
                let backup = remote.get("notes-backup.json", MAX_DOCUMENT).await?;
                budget(&inventory, previous.bytes.len() as u64, &policy)?;
                remote.renew(&mut lease).await?;
                remote
                    .put(
                        "notes-backup.json",
                        previous.bytes.clone(),
                        backup.as_ref().map(|f| f.etag.as_str()),
                    )
                    .await?;
                inventory.retain(|e| e.path != "notes-backup.json");
                inventory.push(InventoryEntry {
                    path: "notes-backup.json".into(),
                    size: previous.bytes.len() as u64,
                    modified_at: remote.now()?,
                });
            }
            budget(&inventory, bytes.len() as u64, &policy)?;
            remote.renew(&mut lease).await?;
            remote
                .put(
                    "notes.json",
                    bytes.clone(),
                    notes_file.as_ref().map(|f| f.etag.as_str()),
                )
                .await?;
            inventory.retain(|e| e.path != "notes.json");
            inventory.push(InventoryEntry {
                path: "notes.json".into(),
                size: bytes.len() as u64,
                modified_at: chrono::Utc::now().timestamp_millis(),
            });
        }
        store::apply(
            &db.pool,
            &scope,
            "notes",
            &local_notes,
            &merged_notes,
            &BTreeMap::new(),
        )
        .await?;
        if notes_changed {
            let _ = app.emit("notes-changed", serde_json::json!({"action":"sync"}));
        }
        let local_clips =
            store::capture(&db.pool, "clipboard", &clips_base, &policy, &credentials).await?;
        let (mut merged_clips, clip_conflicts, _) =
            merge_detailed(&clips_base, &local_clips.document, &clips, false);
        for record in merged_clips.records.values_mut() {
            let sensitive = record
                .data
                .as_ref()
                .and_then(|v| serde_json::from_value::<ClipData>(v.clone()).ok())
                .filter(|clip| clip.clip_type == "text")
                .and_then(|clip| {
                    use base64::Engine;
                    base64::engine::general_purpose::STANDARD
                        .decode(clip.content)
                        .ok()
                })
                .is_some_and(|bytes| {
                    credentials.is_sensitive_text(&String::from_utf8_lossy(&bytes))
                });
            if sensitive {
                record.deleted = true;
                record.data = None;
                record.revision = uuid::Uuid::new_v4().to_string();
                record.updated_at = chrono::Utc::now().timestamp_millis();
            }
        }
        merged_clips.policy = Some(policy.clone());
        let skipped = local_clips.skipped + limit_clips(&mut merged_clips, &policy)?;
        let references = asset_references(&merged_clips)?;
        let mut images = BTreeMap::new();
        for (id, record) in &merged_clips.records {
            if local_clips
                .document
                .records
                .get(id)
                .is_some_and(|r| r.same_content(record))
            {
                continue;
            }
            if let Some(value) = &record.data {
                let clip: ClipData =
                    serde_json::from_value(value.clone()).map_err(|_| "剪切板记录格式异常")?;
                if let Some(hash) = clip.asset {
                    if !local_clips.images.contains_key(&hash) && !images.contains_key(&hash) {
                        remote.renew(&mut lease).await?;
                        images.insert(hash.clone(), remote.asset(&hash, clip.size_bytes).await?);
                    }
                }
            }
        }
        let mut clips_tag = clips_file.as_ref().map(|f| f.etag.clone());
        let pending_bytes: u64 = references
            .iter()
            .filter(|p| !inventory.iter().any(|e| &e.path == *p))
            .map(|p| {
                let hash = p.trim_start_matches("assets/").trim_end_matches(".png");
                local_clips.images.get(hash).map_or(0, |b| b.len() as u64)
            })
            .sum();
        let clip_storage = inventory
            .iter()
            .filter(|e| e.path == "clipboard.json" || e.path.starts_with("assets/"))
            .map(|e| e.size)
            .fold(0u64, u64::saturating_add);
        let final_bytes = encoded(&merged_clips)?;
        if clip_storage + pending_bytes + final_bytes.len() as u64 > policy.clipboard_mib * MIB {
            // 先发布不依赖待上传原图的索引，使旧图失去引用，再回收空间；本地记录不受影响。
            let mut staged = merged_clips.clone();
            staged.records.retain(|_, r| {
                r.data
                    .as_ref()
                    .and_then(|v| v.get("asset"))
                    .and_then(|v| v.as_str())
                    .is_none_or(|hash| {
                        inventory
                            .iter()
                            .any(|e| e.path == format!("assets/{hash}.png"))
                    })
            });
            let bytes = encoded(&staged)?;
            if bytes.len() as u64 > policy.clipboard_mib * MIB {
                return Err("剪切板索引已达到容量额度，本地内容保留".into());
            }
            budget(&inventory, bytes.len() as u64, &policy)?;
            remote.renew(&mut lease).await?;
            clips_tag = Some(
                remote
                    .put("clipboard.json", bytes.clone(), clips_tag.as_deref())
                    .await?,
            );
            clips = staged;
            inventory.retain(|e| e.path != "clipboard.json");
            inventory.push(InventoryEntry {
                path: "clipboard.json".into(),
                size: bytes.len() as u64,
                modified_at: chrono::Utc::now().timestamp_millis(),
            });
            cleanup(
                &remote,
                &mut lease,
                &{
                    let mut refs = asset_references(&clips)?;
                    refs.extend(note_references(&notes));
                    refs.extend(note_references(&merged_notes));
                    refs.extend(note_references(&backup_notes));
                    refs
                },
                &mut inventory,
            )
            .await?;
        }
        for path in &references {
            if inventory.iter().any(|e| &e.path == path) {
                continue;
            }
            let hash = path.trim_start_matches("assets/").trim_end_matches(".png");
            let bytes = local_clips.images.get(hash).ok_or("待上传的原图缺失")?;
            let footprint = inventory
                .iter()
                .filter(|e| e.path == "clipboard.json" || e.path.starts_with("assets/"))
                .map(|e| e.size)
                .fold(0u64, u64::saturating_add);
            if footprint + bytes.len() as u64 + final_bytes.len() as u64
                > policy.clipboard_mib * MIB
            {
                return Err("便签已同步；剪切板容量不足，待旧图回收后重试，本地原图保留".into());
            }
            budget(&inventory, bytes.len() as u64, &policy)?;
            remote.renew(&mut lease).await?;
            remote.put(path, bytes.clone(), None).await?;
            inventory.push(InventoryEntry {
                path: path.clone(),
                size: bytes.len() as u64,
                modified_at: chrono::Utc::now().timestamp_millis(),
            });
        }
        if !same_document(&merged_clips, &clips) || clips_file.is_none() {
            let asset_bytes: u64 = inventory
                .iter()
                .filter(|e| e.path.starts_with("assets/"))
                .map(|e| e.size)
                .fold(0u64, u64::saturating_add);
            if asset_bytes + final_bytes.len() as u64 > policy.clipboard_mib * MIB {
                return Err("便签已同步；剪切板需等待未引用原图回收后重试".into());
            }
            budget(&inventory, final_bytes.len() as u64, &policy)?;
            remote.renew(&mut lease).await?;
            remote
                .put("clipboard.json", final_bytes.clone(), clips_tag.as_deref())
                .await?;
        }
        inventory.retain(|e| e.path != "clipboard.json");
        inventory.push(InventoryEntry {
            path: "clipboard.json".into(),
            size: final_bytes.len() as u64,
            modified_at: chrono::Utc::now().timestamp_millis(),
        });
        store::apply(
            &db.pool,
            &scope,
            "clipboard",
            &local_clips,
            &merged_clips,
            &images,
        )
        .await?;
        let mut all_references = references;
        all_references.extend(note_references(&merged_notes));
        all_references.extend(note_references(if !same_document(&merged_notes, &notes) {
            &notes
        } else {
            &backup_notes
        }));
        cleanup(&remote, &mut lease, &all_references, &mut inventory).await?;
        db.set_setting(
            "webdav_sync_options",
            &serde_json::to_string(&settings).map_err(|_| "同步设置编码失败")?,
        )
        .await
        .map_err(|_| "云端容量策略保存失败")?;
        db.set_setting("webdav_policy_dirty", "false")
            .await
            .map_err(|_| "容量策略状态保存失败")?;
        let local_settings = app
            .state::<Arc<crate::settings_manager::SettingsManager>>()
            .get();
        crate::commands::enforce_clipboard_limits(
            &db.pool,
            local_settings.max_items,
            local_settings.auto_delete_days,
        )
        .await?;
        Ok(SyncReport {
            notes: merged_notes.records.values().filter(|r| !r.deleted).count(),
            clips: merged_clips.records.values().filter(|r| !r.deleted).count(),
            conflicts: note_conflicts + clip_conflicts,
            merged: auto_merged,
            skipped,
            used_bytes: used(&inventory),
            finished_at: chrono::Utc::now().to_rfc3339(),
        })
    }
    .await;
    remote.release(&lease).await;
    outcome
}

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<SyncReport, String> {
    run_sync(&app).await
}

async fn run_sync(app: &AppHandle) -> Result<SyncReport, String> {
    let manager = app.state::<Arc<SyncManager>>();
    let _guard = manager.enter()?;
    let credentials = manager.credentials()?;
    let _ = app.emit("sync-status-changed", ());
    let mut cancellation = manager.cancel.subscribe();
    let result = tokio::select! {
        result = execute(app, credentials) => result,
        _ = cancellation.changed() => Err("凭据已锁定，同步已取消；远端租约将在两分钟内释放".into()),
    };
    match &result {
        Ok(report) => {
            *manager.report.lock() = Some(report.clone());
            *manager.error.lock() = None;
            let _ = app.emit("sync-completed", report);
        }
        Err(error) => {
            *manager.error.lock() = Some(error.clone());
        }
    }
    let _ = app.emit("sync-status-changed", ());
    result
}

pub fn start(app: AppHandle) {
    for event in ["notes-changed", "clipboard-change"] {
        let handle = app.clone();
        app.listen(event, move |event| {
            if serde_json::from_str::<serde_json::Value>(event.payload())
                .ok()
                .and_then(|v| v.get("action").and_then(|a| a.as_str()).map(str::to_owned))
                .as_deref()
                == Some("sync")
            {
                return;
            }
            handle
                .state::<Arc<SyncManager>>()
                .dirty
                .store(true, Ordering::Relaxed);
        });
    }
    tauri::async_runtime::spawn(async move {
        let mut last_sync = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let manager = app.state::<Arc<SyncManager>>();
            let db = app.state::<Arc<Database>>();
            let Ok(settings) = options(&db).await else {
                continue;
            };
            if manager.credentials().is_err()
                || manager.busy.load(Ordering::Relaxed)
                || private_input_active()
            {
                continue;
            }
            let dirty = manager.dirty.swap(false, Ordering::Relaxed);
            if settings.enabled
                && settings.automatic
                && (dirty || last_sync.elapsed().as_secs() >= settings.interval_seconds)
            {
                let _ = run_sync(&app).await;
                last_sync = Instant::now();
            }
        }
    });
}
