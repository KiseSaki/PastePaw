use super::{protocol::*, vault::Credentials};
use crate::models::{Clip, Note};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::Digest;
use sqlx::{Row, SqlitePool};
use std::collections::BTreeMap;

pub struct Capture {
    pub document: Document,
    pub checks: BTreeMap<String, String>,
    pub images: BTreeMap<String, Vec<u8>>,
    pub skipped: usize,
}

fn db_error(_: sqlx::Error) -> String {
    "同步数据库操作失败".into()
}

pub async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let columns = sqlx::query("PRAGMA table_info(folders)")
        .fetch_all(pool)
        .await?;
    if !columns.iter().any(|r| r.get::<String, _>("name") == "uuid") {
        sqlx::query("ALTER TABLE folders ADD COLUMN uuid TEXT")
            .execute(pool)
            .await?;
    }
    sqlx::raw_sql(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_uuid ON folders(uuid);
        CREATE TABLE IF NOT EXISTS sync_clip_aliases(space_id TEXT NOT NULL,remote_uuid TEXT NOT NULL,local_uuid TEXT NOT NULL,PRIMARY KEY(space_id,remote_uuid),UNIQUE(space_id,local_uuid));
        CREATE TABLE IF NOT EXISTS sync_tombstones(kind TEXT NOT NULL, uuid TEXT NOT NULL, deleted_at INTEGER NOT NULL, PRIMARY KEY(kind,uuid));
        CREATE TRIGGER IF NOT EXISTS sync_folder_uuid AFTER INSERT ON folders WHEN NEW.uuid IS NULL BEGIN
          UPDATE folders SET uuid=lower(hex(randomblob(16))) WHERE id=NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS sync_note_delete AFTER DELETE ON notes BEGIN
          INSERT OR REPLACE INTO sync_tombstones VALUES('notes',OLD.uuid,CAST(strftime('%s','now') AS INTEGER)*1000);
        END;
        CREATE TRIGGER IF NOT EXISTS sync_note_restore AFTER INSERT ON notes BEGIN
          DELETE FROM sync_tombstones WHERE kind='notes' AND uuid=NEW.uuid;
        END;
        CREATE TRIGGER IF NOT EXISTS sync_clip_delete AFTER UPDATE OF is_deleted ON clips WHEN NEW.is_deleted=1 AND OLD.is_deleted=0 BEGIN
          INSERT OR REPLACE INTO sync_tombstones VALUES('clipboard',NEW.uuid,CAST(strftime('%s','now') AS INTEGER)*1000);
        END;
        CREATE TRIGGER IF NOT EXISTS sync_clip_restore AFTER UPDATE OF is_deleted ON clips WHEN NEW.is_deleted=0 AND OLD.is_deleted=1 BEGIN
          DELETE FROM sync_tombstones WHERE kind='clipboard' AND uuid=NEW.uuid;
        END;"
    ).execute(pool).await?;
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM folders WHERE uuid IS NULL")
        .fetch_all(pool)
        .await?;
    for id in ids {
        sqlx::query("UPDATE folders SET uuid=? WHERE id=? AND uuid IS NULL")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn mark_clip_deleted(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("INSERT OR REPLACE INTO sync_tombstones VALUES('clipboard',?,?)")
        .bind(id)
        .bind(chrono::Utc::now().timestamp_millis())
        .execute(pool)
        .await
        .map_err(db_error)?;
    Ok(())
}

pub async fn baseline(
    pool: &SqlitePool,
    scope: &str,
    kind: &str,
    space: &str,
) -> Result<Document, String> {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
        .bind(format!("sync-base-{scope}-{kind}"))
        .fetch_optional(pool)
        .await
        .map_err(db_error)?;
    match value {
        Some(value) => {
            let document: Document =
                serde_json::from_str(&value).map_err(|_| "同步基线损坏，请先备份本地数据")?;
            document.validate()?;
            Ok(document)
        }
        None => Ok(Document::new(space.into())),
    }
}

fn note_data(note: &Note) -> NoteData {
    NoteData {
        title: note.title.clone(),
        content: note.content.clone(),
        color: note.color.clone(),
        is_pinned: note.is_pinned,
        is_completed: note.is_completed,
        created_at: note.created_at.to_rfc3339(),
        updated_at: note.updated_at.to_rfc3339(),
    }
}

fn clip_check(clip: &Clip) -> String {
    digest(
        serde_json::json!([
            clip.uuid,
            clip.clip_type,
            clip.content_hash,
            clip.text_preview,
            clip.folder_id,
            clip.is_pinned,
            clip.metadata,
            clip.created_at,
            clip.is_deleted,
            clip.source_app
        ])
        .to_string()
        .as_bytes(),
    )
}

fn local_record(id: &str, data: Option<Value>, at: i64, base: &Document) -> Record {
    if let Some(before) = base.records.get(id) {
        if before.data == data {
            return before.clone();
        }
    }
    let seed = format!(
        "{id}:{}:{}",
        base.records
            .get(id)
            .map(|r| r.revision.as_str())
            .unwrap_or("new"),
        data.as_ref().map(Value::to_string).unwrap_or_default()
    );
    let hash = sha2::Sha256::digest(seed.as_bytes());
    Record {
        revision: uuid::Uuid::from_bytes(hash[..16].try_into().unwrap()).to_string(),
        deleted: data.is_none(),
        updated_at: at,
        data,
    }
}

pub async fn capture(
    pool: &SqlitePool,
    kind: &str,
    base: &Document,
    policy: &CloudPolicy,
    credentials: &Credentials,
) -> Result<Capture, String> {
    let mut tx = pool.begin().await.map_err(db_error)?;
    let mut document = Document::new(base.space_id.clone());
    let mut checks = BTreeMap::new();
    let mut images = BTreeMap::new();
    let mut skipped = 0;
    let aliases: Vec<(String, String)> =
        sqlx::query_as("SELECT local_uuid,remote_uuid FROM sync_clip_aliases WHERE space_id=?")
            .bind(&base.space_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(db_error)?;
    let aliases: BTreeMap<String, String> = aliases.into_iter().collect();
    if kind == "notes" {
        let estimate: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(length(CAST(content AS BLOB))+length(CAST(title AS BLOB))+512),0) FROM notes")
            .fetch_one(&mut *tx).await.map_err(db_error)?;
        if estimate > MAX_DOCUMENT as i64 {
            return Err("便签总量超过单次索引上限 32 MiB，已暂停同步，本地内容保留".into());
        }
        let notes: Vec<Note> = sqlx::query_as("SELECT * FROM notes")
            .fetch_all(&mut *tx)
            .await
            .map_err(db_error)?;
        for note in notes {
            let data = serde_json::to_value(note_data(&note)).map_err(|_| "便签编码失败")?;
            checks.insert(note.uuid.clone(), digest(data.to_string().as_bytes()));
            document.records.insert(
                note.uuid.clone(),
                local_record(
                    &note.uuid,
                    Some(data),
                    note.updated_at.timestamp_millis(),
                    base,
                ),
            );
        }
        // 缺失便签代表主动删除；剪切板缺失可能是本地容量淘汰，不能据此传播删除。
        for (id, record) in &base.records {
            if !record.deleted && !document.records.contains_key(id) {
                document.records.insert(
                    id.clone(),
                    local_record(id, None, chrono::Utc::now().timestamp_millis(), base),
                );
            }
        }
    } else {
        let folders = sqlx::query("SELECT id,uuid,name,icon,color FROM folders")
            .fetch_all(&mut *tx)
            .await
            .map_err(db_error)?;
        let mut folder_ids = BTreeMap::new();
        for row in folders {
            let id: String = row.try_get("uuid").map_err(db_error)?;
            folder_ids.insert(row.get::<i64, _>("id"), id.clone());
            document.folders.insert(
                id,
                FolderData {
                    name: row.get("name"),
                    icon: row.get("icon"),
                    color: row.get("color"),
                },
            );
        }
        let clips: Vec<Clip> = sqlx::query_as(
            "SELECT * FROM clips WHERE is_deleted=0 ORDER BY created_at DESC,uuid LIMIT ?",
        )
        .bind(policy.max_clips as i64)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_error)?;
        // 并发检查覆盖所有本地记录，保证云端更新能刷新本地同步范围外的同 UUID 记录。
        let rows = sqlx::query("SELECT uuid,clip_type,content_hash,text_preview,folder_id,is_pinned,metadata,created_at,is_deleted,source_app FROM clips WHERE is_deleted=0")
            .fetch_all(&mut *tx).await.map_err(db_error)?;
        for row in rows {
            let id: String = row.get("uuid");
            let fingerprint = digest(
                serde_json::json!([
                    id,
                    row.get::<String, _>("clip_type"),
                    row.get::<String, _>("content_hash"),
                    row.get::<String, _>("text_preview"),
                    row.get::<Option<i64>, _>("folder_id"),
                    row.get::<bool, _>("is_pinned"),
                    row.get::<Option<String>, _>("metadata"),
                    row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                    row.get::<bool, _>("is_deleted"),
                    row.get::<Option<String>, _>("source_app")
                ])
                .to_string()
                .as_bytes(),
            );
            checks.insert(id, fingerprint);
        }
        for clip in clips {
            let remote_id = aliases.get(&clip.uuid).unwrap_or(&clip.uuid).clone();
            if clip.clip_type == "text"
                && credentials.is_sensitive_text(&String::from_utf8_lossy(&clip.content))
            {
                skipped += 1;
                continue;
            }
            let mut data = ClipData {
                clip_type: clip.clip_type.clone(),
                content: STANDARD.encode(&clip.content),
                content_hash: clip.content_hash.clone(),
                preview: clip.text_preview.clone(),
                folder_uuid: clip.folder_id.and_then(|id| folder_ids.get(&id).cloned()),
                is_pinned: clip.is_pinned,
                metadata: clip.metadata.clone(),
                created_at: clip.created_at.to_rfc3339(),
                asset: None,
                size_bytes: clip.content.len() as u64,
                source_app: clip.source_app.clone(),
            };
            if clip.clip_type == "image" {
                if !policy.sync_images {
                    skipped += 1;
                    continue;
                }
                if let Some(previous) = base
                    .records
                    .get(&remote_id)
                    .and_then(|r| r.data.as_ref())
                    .and_then(|v| serde_json::from_value::<ClipData>(v.clone()).ok())
                    .filter(|previous| {
                        previous.content_hash == clip.content_hash
                            && previous.asset.as_deref().is_some_and(valid_asset)
                            && previous.size_bytes <= policy.image_mib * MIB
                    })
                {
                    data.asset = previous.asset;
                    data.size_bytes = previous.size_bytes;
                    data.content.clear();
                    let value = serde_json::to_value(data).map_err(|_| "剪切板编码失败")?;
                    document.records.insert(
                        remote_id.clone(),
                        local_record(
                            &remote_id,
                            Some(value),
                            clip.created_at.timestamp_millis(),
                            base,
                        ),
                    );
                    continue;
                }
                let row: Option<(Vec<u8>, Option<String>)> = sqlx::query_as(
                    "SELECT full_content,file_path FROM clip_images WHERE clip_uuid=?",
                )
                .bind(&clip.uuid)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db_error)?;
                let Some((mut full, path)) = row else {
                    skipped += 1;
                    continue;
                };
                if full.is_empty() {
                    if let Some(path) = path {
                        let allowed = dirs::data_dir()
                            .ok_or("无法定位本地图片目录")?
                            .join("PastePaw")
                            .join("images");
                        let actual = std::fs::canonicalize(&path).map_err(|_| "本地原图不存在")?;
                        let allowed =
                            std::fs::canonicalize(allowed).map_err(|_| "本地图片目录不存在")?;
                        if !actual.starts_with(allowed) {
                            return Err("本地图片路径超出允许目录".into());
                        }
                        if std::fs::metadata(&actual)
                            .map_err(|_| "无法读取图片大小")?
                            .len()
                            > policy.image_mib * MIB
                        {
                            skipped += 1;
                            continue;
                        }
                        full = std::fs::read(actual).map_err(|_| "读取本地原图失败")?;
                    }
                }
                if full.is_empty() || full.len() as u64 > policy.image_mib * MIB {
                    skipped += 1;
                    continue;
                }
                let hash = digest(&full);
                data.asset = Some(hash.clone());
                data.content.clear();
                data.size_bytes = full.len() as u64;
                images.insert(hash, full);
            } else if clip.clip_type != "text" {
                skipped += 1;
                continue;
            }
            checks.insert(clip.uuid.clone(), clip_check(&clip));
            let value = serde_json::to_value(data).map_err(|_| "剪切板编码失败")?;
            document.records.insert(
                remote_id.clone(),
                local_record(
                    &remote_id,
                    Some(value),
                    clip.created_at.timestamp_millis(),
                    base,
                ),
            );
        }
    }
    let tombstones: Vec<(String, i64)> =
        sqlx::query_as("SELECT uuid,deleted_at FROM sync_tombstones WHERE kind=?")
            .bind(kind)
            .fetch_all(&mut *tx)
            .await
            .map_err(db_error)?;
    for (id, at) in tombstones {
        if checks.contains_key(&id) {
            continue;
        }
        let id = if kind == "clipboard" {
            aliases.get(&id).unwrap_or(&id).clone()
        } else {
            id
        };
        document
            .records
            .entry(id.clone())
            .or_insert_with(|| local_record(&id, None, at, base));
    }
    tx.commit().await.map_err(db_error)?;
    Ok(Capture {
        document,
        checks,
        images,
        skipped,
    })
}

pub async fn apply(
    pool: &SqlitePool,
    scope: &str,
    kind: &str,
    capture: &Capture,
    merged: &Document,
    images: &BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(db_error)?;
    let baseline_key = format!("sync-base-{scope}-{kind}");
    let previous: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
        .bind(&baseline_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    let previous: Document = match previous {
        Some(value) => serde_json::from_str(&value).map_err(|_| "同步基线损坏")?,
        None => Document::new(merged.space_id.clone()),
    };
    let mut next_base = merged.clone();
    let mut folder_ids = BTreeMap::new();
    if kind == "clipboard" {
        for (id, folder) in &merged.folders {
            let current: Option<(String, Option<String>, Option<String>)> =
                sqlx::query_as("SELECT name,icon,color FROM folders WHERE uuid=?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(db_error)?;
            let current = current.map(|(name, icon, color)| FolderData { name, icon, color });
            if current.as_ref() == capture.document.folders.get(id) {
                sqlx::query("INSERT INTO folders(uuid,name,icon,color,is_system) VALUES(?,?,?,?,0) ON CONFLICT(uuid) DO UPDATE SET name=excluded.name,icon=excluded.icon,color=excluded.color")
                .bind(id).bind(&folder.name).bind(&folder.icon).bind(&folder.color).execute(&mut *tx).await.map_err(db_error)?;
            } else if let Some(before) = previous.folders.get(id) {
                next_base.folders.insert(id.clone(), before.clone());
            } else {
                next_base.folders.remove(id);
            }
            let local: Option<i64> = sqlx::query_scalar("SELECT id FROM folders WHERE uuid=?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db_error)?;
            if let Some(local) = local {
                folder_ids.insert(id.clone(), local);
            }
        }
    }
    for (id, record) in &merged.records {
        if kind == "notes" {
            let current: Option<Note> = sqlx::query_as("SELECT * FROM notes WHERE uuid=?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db_error)?;
            let fingerprint = current.as_ref().map(|n| {
                digest(
                    serde_json::to_value(note_data(n))
                        .unwrap()
                        .to_string()
                        .as_bytes(),
                )
            });
            if fingerprint.as_ref() != capture.checks.get(id) || super::note_pending(id) {
                // 编辑期间保留旧基线，下一轮才能识别两边同时修改并保留冲突副本。
                if let Some(before) = previous.records.get(id) {
                    next_base.records.insert(id.clone(), before.clone());
                } else {
                    next_base.records.remove(id);
                }
                continue;
            }
            if current.is_some()
                && capture
                    .document
                    .records
                    .get(id)
                    .is_some_and(|r| r.same_content(record))
            {
                continue;
            }
            if let Some(value) = &record.data {
                let data: NoteData =
                    serde_json::from_value(value.clone()).map_err(|_| "远端便签内容异常")?;
                let created = chrono::DateTime::parse_from_rfc3339(&data.created_at)
                    .map_err(|_| "便签创建时间无效")?
                    .with_timezone(&chrono::Utc);
                let updated = chrono::DateTime::parse_from_rfc3339(&data.updated_at)
                    .map_err(|_| "便签更新时间无效")?
                    .with_timezone(&chrono::Utc);
                sqlx::query("INSERT INTO notes(uuid,title,content,color,is_pinned,is_completed,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(uuid) DO UPDATE SET title=excluded.title,content=excluded.content,color=excluded.color,is_pinned=excluded.is_pinned,is_completed=excluded.is_completed,updated_at=excluded.updated_at")
                    .bind(id).bind(data.title).bind(data.content).bind(data.color).bind(data.is_pinned).bind(data.is_completed).bind(created).bind(updated)
                    .execute(&mut *tx).await.map_err(db_error)?;
                sqlx::query("DELETE FROM sync_tombstones WHERE kind='notes' AND uuid=?")
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_error)?;
            } else {
                sqlx::query("DELETE FROM notes WHERE uuid=?")
                    .bind(id)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_error)?;
            }
        } else {
            let alias: Option<String> = sqlx::query_scalar(
                "SELECT local_uuid FROM sync_clip_aliases WHERE space_id=? AND remote_uuid=?",
            )
            .bind(&merged.space_id)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
            let mut local_id = alias.unwrap_or_else(|| id.clone());
            let mut current: Option<Clip> = sqlx::query_as("SELECT * FROM clips WHERE uuid=?")
                .bind(&local_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db_error)?;
            if current.is_none() {
                if let Some(value) = &record.data {
                    let data: ClipData =
                        serde_json::from_value(value.clone()).map_err(|_| "远端剪切板内容异常")?;
                    current = sqlx::query_as("SELECT * FROM clips WHERE content_hash=? AND clip_type=? AND is_deleted=0 ORDER BY created_at DESC LIMIT 1")
                        .bind(data.content_hash).bind(data.clip_type).fetch_optional(&mut *tx).await.map_err(db_error)?;
                    local_id = current
                        .as_ref()
                        .map(|c| c.uuid.clone())
                        .unwrap_or_else(|| id.clone());
                }
            }
            if current.is_none()
                && !capture.document.records.contains_key(id)
                && previous
                    .records
                    .get(id)
                    .is_some_and(|r| r.same_content(record))
            {
                continue;
            }
            // 不覆盖网络请求期间发生的复制、置顶、分组或删除操作。
            if current
                .as_ref()
                .filter(|c| !c.is_deleted)
                .map(clip_check)
                .as_ref()
                != capture.checks.get(&local_id)
            {
                if let Some(before) = previous.records.get(id) {
                    next_base.records.insert(id.clone(), before.clone());
                } else {
                    next_base.records.remove(id);
                }
                continue;
            }
            sqlx::query("INSERT OR REPLACE INTO sync_clip_aliases(space_id,remote_uuid,local_uuid) VALUES(?,?,?)")
                .bind(&merged.space_id).bind(id).bind(&local_id).execute(&mut *tx).await.map_err(db_error)?;
            if capture
                .document
                .records
                .get(id)
                .is_some_and(|r| r.same_content(record))
                && current.is_some()
            {
                continue;
            }
            if let Some(value) = &record.data {
                let data: ClipData =
                    serde_json::from_value(value.clone()).map_err(|_| "远端剪切板内容异常")?;
                if data.clip_type != "text" && data.clip_type != "image" {
                    return Err("不支持的远端剪切板类型".into());
                }
                let created = chrono::DateTime::parse_from_rfc3339(&data.created_at)
                    .map_err(|_| "剪切板时间无效")?
                    .with_timezone(&chrono::Utc);
                let mut content = STANDARD
                    .decode(&data.content)
                    .map_err(|_| "剪切板内容编码无效")?;
                let image_bytes = if data.clip_type == "image" {
                    let hash = data.asset.as_ref().ok_or("图片缺少原图标识")?;
                    let full = images
                        .get(hash)
                        .or_else(|| capture.images.get(hash))
                        .ok_or("同步原图缺失")?;
                    if full.len() as u64 != data.size_bytes || digest(full) != *hash {
                        return Err("同步原图校验失败".into());
                    }
                    let mut cursor = std::io::Cursor::new(Vec::new());
                    let mut reader = image::io::Reader::new(std::io::Cursor::new(full))
                        .with_guessed_format()
                        .map_err(|_| "原图格式无效")?;
                    let mut limits = image::io::Limits::default();
                    limits.max_image_width = Some(16384);
                    limits.max_image_height = Some(16384);
                    limits.max_alloc = Some(128 * MIB);
                    reader.limits(limits);
                    reader
                        .decode()
                        .map_err(|_| "原图格式无效或解码大小超过限制")?
                        .thumbnail(320, 320)
                        .write_to(&mut cursor, image::ImageOutputFormat::Png)
                        .map_err(|_| "图片缩略图生成失败")?;
                    content = cursor.into_inner();
                    Some(full)
                } else {
                    if content.len() as u64 != data.size_bytes
                        || digest(&content) != data.content_hash
                    {
                        return Err("剪切板文本校验失败".into());
                    }
                    std::str::from_utf8(&content).map_err(|_| "剪切板文本不是 UTF-8")?;
                    None
                };
                let folder_id = data
                    .folder_uuid
                    .as_ref()
                    .and_then(|f| folder_ids.get(f))
                    .copied();
                sqlx::query("INSERT INTO clips(uuid,clip_type,content,text_preview,content_hash,folder_id,is_deleted,is_thumbnail,is_pinned,metadata,created_at,last_accessed,source_app) VALUES(?,?,?,?,?,?,0,?,?,?,?,?,?) ON CONFLICT(uuid) DO UPDATE SET clip_type=excluded.clip_type,content_hash=excluded.content_hash,content=excluded.content,text_preview=excluded.text_preview,folder_id=excluded.folder_id,is_deleted=0,is_thumbnail=excluded.is_thumbnail,is_pinned=excluded.is_pinned,metadata=excluded.metadata,created_at=excluded.created_at,source_app=excluded.source_app")
                    .bind(&local_id).bind(&data.clip_type).bind(content).bind(data.preview).bind(data.content_hash).bind(folder_id)
                    .bind(image_bytes.is_some()).bind(data.is_pinned).bind(data.metadata).bind(created).bind(created).bind(data.source_app)
                    .execute(&mut *tx).await.map_err(db_error)?;
                if let Some(full) = image_bytes {
                    sqlx::query("INSERT INTO clip_images(clip_uuid,full_content,storage_kind,mime_type) VALUES(?,?,'db','image/png') ON CONFLICT(clip_uuid) DO UPDATE SET full_content=excluded.full_content,file_path=NULL,file_size=NULL,storage_kind='db'")
                        .bind(&local_id).bind(full).execute(&mut *tx).await.map_err(db_error)?;
                }
                sqlx::query("DELETE FROM sync_tombstones WHERE kind='clipboard' AND uuid=?")
                    .bind(&local_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_error)?;
            } else {
                sqlx::query("UPDATE clips SET is_deleted=1 WHERE uuid=?")
                    .bind(&local_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_error)?;
            }
        }
    }
    let value = serde_json::to_string(&next_base).map_err(|_| "同步基线编码失败")?;
    sqlx::query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(baseline_key).bind(value).execute(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(())
}

pub async fn scrub(
    pool: &SqlitePool,
    credentials: &Credentials,
    unlock: &str,
) -> Result<(), String> {
    let clips: Vec<Clip> =
        sqlx::query_as("SELECT * FROM clips WHERE is_deleted=0 AND clip_type='text'")
            .fetch_all(pool)
            .await
            .map_err(db_error)?;
    for clip in clips {
        let text = String::from_utf8_lossy(&clip.content);
        if credentials.is_sensitive_text(&text) || (!unlock.is_empty() && text.contains(unlock)) {
            mark_clip_deleted(pool, &clip.uuid).await?;
            sqlx::query("DELETE FROM clips WHERE uuid=?")
                .bind(clip.uuid)
                .execute(pool)
                .await
                .map_err(db_error)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    #[tokio::test]
    async fn migration_and_note_conflicts_survive_local_concurrent_edits() {
        let db = Database {
            pool: SqlitePool::connect("sqlite::memory:").await.unwrap(),
        };
        db.migrate().await.unwrap();
        migrate(&db.pool).await.unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO notes(uuid,title,content) VALUES(?,'标题','原始')")
            .bind(&id)
            .execute(&db.pool)
            .await
            .unwrap();
        let base = Document::new(uuid::Uuid::new_v4().to_string());
        let credentials = Credentials {
            profile_id: uuid::Uuid::new_v4().to_string(),
            endpoint: "https://example.invalid/".into(),
            directory: "pastepaw".into(),
            username: "fixture-user".into(),
            password: "fixture-password".into(),
        };
        let captured = capture(
            &db.pool,
            "notes",
            &base,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        let mut remote = captured.document.clone();
        remote.records.get_mut(&id).unwrap().data.as_mut().unwrap()["content"] =
            serde_json::json!("远端");
        sqlx::query("UPDATE notes SET content='请求期间本地编辑' WHERE uuid=?")
            .bind(&id)
            .execute(&db.pool)
            .await
            .unwrap();
        apply(
            &db.pool,
            "fixture",
            "notes",
            &captured,
            &remote,
            &BTreeMap::new(),
        )
        .await
        .unwrap();
        let text: String = sqlx::query_scalar("SELECT content FROM notes WHERE uuid=?")
            .bind(&id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(text, "请求期间本地编辑");
        sqlx::query("DELETE FROM notes WHERE uuid=?")
            .bind(&id)
            .execute(&db.pool)
            .await
            .unwrap();
        let captured = capture(
            &db.pool,
            "notes",
            &remote,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        assert!(captured.document.records[&id].deleted);
    }

    #[tokio::test]
    async fn local_clip_eviction_does_not_propagate_but_manual_deletion_does() {
        let db = Database {
            pool: SqlitePool::connect("sqlite::memory:").await.unwrap(),
        };
        db.migrate().await.unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let text = b"clipboard fixture";
        sqlx::query("INSERT INTO clips(uuid,clip_type,content,text_preview,content_hash) VALUES(?,'text',?,'fixture',?)")
            .bind(&id).bind(text.as_slice()).bind(digest(text)).execute(&db.pool).await.unwrap();
        let credentials = Credentials {
            profile_id: uuid::Uuid::new_v4().to_string(),
            endpoint: "https://example.invalid/".into(),
            directory: "pastepaw".into(),
            username: "fixture-user".into(),
            password: "fixture-password".into(),
        };
        let base = Document::new(uuid::Uuid::new_v4().to_string());
        let first = capture(
            &db.pool,
            "clipboard",
            &base,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        sqlx::query("DELETE FROM clips WHERE uuid=?")
            .bind(&id)
            .execute(&db.pool)
            .await
            .unwrap();
        let evicted = capture(
            &db.pool,
            "clipboard",
            &first.document,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        assert!(!evicted.document.records.contains_key(&id));
        assert!(
            !merge(&first.document, &evicted.document, &first.document, false)
                .0
                .records[&id]
                .deleted
        );
        mark_clip_deleted(&db.pool, &id).await.unwrap();
        let manual = capture(
            &db.pool,
            "clipboard",
            &first.document,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        assert!(
            merge(&first.document, &manual.document, &first.document, false)
                .0
                .records[&id]
                .deleted
        );
    }

    #[tokio::test]
    async fn editing_during_sync_keeps_old_baseline_for_next_conflict_merge() {
        let db = Database {
            pool: SqlitePool::connect("sqlite::memory:").await.unwrap(),
        };
        db.migrate().await.unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO notes(uuid,title,content) VALUES(?,'fixture','original')")
            .bind(&id)
            .execute(&db.pool)
            .await
            .unwrap();
        let credentials = Credentials {
            profile_id: uuid::Uuid::new_v4().to_string(),
            endpoint: "https://example.invalid/".into(),
            directory: "pastepaw".into(),
            username: "fixture-user".into(),
            password: "fixture-password".into(),
        };
        let empty = Document::new(uuid::Uuid::new_v4().to_string());
        let captured = capture(
            &db.pool,
            "notes",
            &empty,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        apply(
            &db.pool,
            "fixture",
            "notes",
            &captured,
            &captured.document,
            &BTreeMap::new(),
        )
        .await
        .unwrap();
        let mut remote = captured.document.clone();
        remote.records.get_mut(&id).unwrap().revision = uuid::Uuid::new_v4().to_string();
        remote.records.get_mut(&id).unwrap().data.as_mut().unwrap()["content"] =
            serde_json::json!("remote edit");
        sqlx::query("UPDATE notes SET content='local edit' WHERE uuid=?")
            .bind(&id)
            .execute(&db.pool)
            .await
            .unwrap();
        apply(
            &db.pool,
            "fixture",
            "notes",
            &captured,
            &remote,
            &BTreeMap::new(),
        )
        .await
        .unwrap();
        let base = baseline(&db.pool, "fixture", "notes", &empty.space_id)
            .await
            .unwrap();
        assert_eq!(
            base.records[&id].data.as_ref().unwrap()["content"],
            "original"
        );
        let local = capture(
            &db.pool,
            "notes",
            &base,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        let (merged, conflicts) = merge(&base, &local.document, &remote, true);
        assert_eq!(conflicts, 1);
        assert_eq!(merged.records.len(), 2);
        assert!(merged.records.values().any(|r| r
            .data
            .as_ref()
            .is_some_and(|d| d["content"] == "local edit")));
    }

    #[tokio::test]
    async fn duplicate_clip_from_another_device_reuses_local_row_and_deletion_alias() {
        let db = Database {
            pool: SqlitePool::connect("sqlite::memory:").await.unwrap(),
        };
        db.migrate().await.unwrap();
        let local_id = uuid::Uuid::new_v4().to_string();
        let remote_id = uuid::Uuid::new_v4().to_string();
        let bytes = b"same text";
        sqlx::query("INSERT INTO clips(uuid,clip_type,content,text_preview,content_hash) VALUES(?,'text',?,'same text',?)")
            .bind(&local_id).bind(bytes.as_slice()).bind(digest(bytes)).execute(&db.pool).await.unwrap();
        let credentials = Credentials {
            profile_id: uuid::Uuid::new_v4().to_string(),
            endpoint: "https://example.invalid/".into(),
            directory: "pastepaw".into(),
            username: "fixture-user".into(),
            password: "fixture-password".into(),
        };
        let empty = Document::new(uuid::Uuid::new_v4().to_string());
        let captured = capture(
            &db.pool,
            "clipboard",
            &empty,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        let mut remote = captured.document.clone();
        let record = remote.records.remove(&local_id).unwrap();
        remote.records.insert(remote_id.clone(), record);
        apply(
            &db.pool,
            "fixture",
            "clipboard",
            &captured,
            &remote,
            &BTreeMap::new(),
        )
        .await
        .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM clips")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let again = capture(
            &db.pool,
            "clipboard",
            &remote,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        assert!(again.document.records.contains_key(&remote_id));
        assert!(!again.document.records.contains_key(&local_id));
        sqlx::query("UPDATE clips SET is_deleted=1 WHERE uuid=?")
            .bind(&local_id)
            .execute(&db.pool)
            .await
            .unwrap();
        let deleted = capture(
            &db.pool,
            "clipboard",
            &remote,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        assert!(deleted.document.records[&remote_id].deleted);
    }

    #[tokio::test]
    async fn imported_image_keeps_original_and_does_not_reimport_after_local_eviction() {
        let db = Database {
            pool: SqlitePool::connect("sqlite::memory:").await.unwrap(),
        };
        db.migrate().await.unwrap();
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            4,
            4,
            image::Rgba([10, 20, 30, 255]),
        ))
        .write_to(&mut cursor, image::ImageOutputFormat::Png)
        .unwrap();
        let bytes = cursor.into_inner();
        let hash = digest(&bytes);
        let id = uuid::Uuid::new_v4().to_string();
        let mut remote = Document::new(uuid::Uuid::new_v4().to_string());
        let data = ClipData {
            clip_type: "image".into(),
            content: String::new(),
            content_hash: hash.clone(),
            preview: "[Image]".into(),
            folder_uuid: None,
            is_pinned: false,
            metadata: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            asset: Some(hash.clone()),
            size_bytes: bytes.len() as u64,
            source_app: Some("fixture editor".into()),
        };
        remote.records.insert(
            id.clone(),
            Record::new(Some(serde_json::to_value(data).unwrap())),
        );
        let credentials = Credentials {
            profile_id: uuid::Uuid::new_v4().to_string(),
            endpoint: "https://example.invalid/".into(),
            directory: "pastepaw".into(),
            username: "fixture-user".into(),
            password: "fixture-password".into(),
        };
        let empty = Document::new(remote.space_id.clone());
        let captured = capture(
            &db.pool,
            "clipboard",
            &empty,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        let mut images = BTreeMap::new();
        images.insert(hash.clone(), bytes.clone());
        apply(
            &db.pool,
            "fixture",
            "clipboard",
            &captured,
            &remote,
            &images,
        )
        .await
        .unwrap();
        let full: Vec<u8> =
            sqlx::query_scalar("SELECT full_content FROM clip_images WHERE clip_uuid=?")
                .bind(&id)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(full, bytes);
        let captured = capture(
            &db.pool,
            "clipboard",
            &remote,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        assert!(captured.images.is_empty());
        sqlx::query("DELETE FROM clip_images WHERE clip_uuid=?")
            .bind(&id)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM clips WHERE uuid=?")
            .bind(&id)
            .execute(&db.pool)
            .await
            .unwrap();
        let evicted = capture(
            &db.pool,
            "clipboard",
            &remote,
            &CloudPolicy::default(),
            &credentials,
        )
        .await
        .unwrap();
        apply(
            &db.pool,
            "fixture",
            "clipboard",
            &evicted,
            &remote,
            &BTreeMap::new(),
        )
        .await
        .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM clips")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
