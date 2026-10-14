use super::{note_merge::fingerprint, protocol::NoteConflict, SyncManager};
use crate::{database::Database, models::Note};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::{collections::BTreeMap, sync::Arc};
use tauri::{AppHandle, Emitter, Manager};

pub async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("CREATE TABLE IF NOT EXISTS sync_note_conflicts(space_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(space_id,id))").execute(pool).await?;
    Ok(())
}
pub async fn local(
    pool: &SqlitePool,
    space: &str,
) -> Result<BTreeMap<String, NoteConflict>, String> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id,data FROM sync_note_conflicts WHERE space_id=?")
            .bind(space)
            .fetch_all(pool)
            .await
            .map_err(|_| "冲突索引读取失败")?;
    rows.into_iter()
        .map(|(id, text)| Ok((id, serde_json::from_str(&text).map_err(|_| "冲突索引损坏")?)))
        .collect()
}
#[derive(Serialize)]
pub struct Snapshot {
    pub id: String,
    pub title: String,
    pub content: String,
    pub deleted: bool,
    pub fingerprint: String,
}
#[derive(Serialize)]
pub struct ConflictView {
    pub id: String,
    pub space_id: String,
    pub source: String,
    pub original: Snapshot,
    pub other: Snapshot,
    pub base_content: Option<String>,
}
async fn snapshot(pool: &SqlitePool, id: &str) -> Result<Snapshot, String> {
    let note: Option<Note> = sqlx::query_as("SELECT * FROM notes WHERE uuid=?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|_| "便签读取失败")?;
    Ok(match note {
        Some(note) => {
            let data =
                serde_json::to_value(super::store::note_data(&note)).map_err(|_| "便签编码失败")?;
            Snapshot {
                id: id.into(),
                title: note.title,
                content: note.content,
                deleted: false,
                fingerprint: fingerprint(&data),
            }
        }
        None => Snapshot {
            id: id.into(),
            title: "已删除".into(),
            content: String::new(),
            deleted: true,
            fingerprint: fingerprint(&serde_json::Value::Null),
        },
    })
}
#[tauri::command]
pub async fn get_note_conflicts(app: AppHandle) -> Result<Vec<ConflictView>, String> {
    let db = app.state::<Arc<Database>>();
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT space_id,id,data FROM sync_note_conflicts ORDER BY rowid DESC")
            .fetch_all(&db.pool)
            .await
            .map_err(|_| "冲突索引读取失败")?;
    let mut result = Vec::new();
    for (space, id, text) in rows {
        let conflict: NoteConflict = serde_json::from_str(&text).map_err(|_| "冲突索引损坏")?;
        if conflict.resolved {
            continue;
        }
        result.push(ConflictView {
            id,
            space_id: space,
            source: conflict.source,
            original: snapshot(&db.pool, &conflict.original_uuid).await?,
            other: snapshot(&db.pool, &conflict.copy_uuid).await?,
            base_content: conflict
                .base
                .as_ref()
                .and_then(|v| v.get("content"))
                .and_then(|v| v.as_str())
                .map(str::to_owned),
        });
    }
    Ok(result)
}
#[derive(Deserialize)]
pub struct Resolution {
    pub space_id: String,
    pub id: String,
    pub original_fingerprint: String,
    pub other_fingerprint: String,
    pub choice: String,
    pub title: Option<String>,
    pub content: Option<String>,
}
pub async fn resolve(pool: &SqlitePool, input: Resolution) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|_| "冲突处理失败")?;
    let text: String =
        sqlx::query_scalar("SELECT data FROM sync_note_conflicts WHERE space_id=? AND id=?")
            .bind(&input.space_id)
            .bind(&input.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| "冲突读取失败")?
            .ok_or("冲突不存在")?;
    let mut conflict: NoteConflict = serde_json::from_str(&text).map_err(|_| "冲突索引损坏")?;
    if conflict.resolved {
        return Err("此冲突已经处理，请刷新列表".into());
    }
    if super::note_pending(&conflict.original_uuid) || super::note_pending(&conflict.copy_uuid) {
        return Err("便签正在保存，请稍后重试".into());
    }
    let notes: Vec<Note> = sqlx::query_as("SELECT * FROM notes WHERE uuid=? OR uuid=?")
        .bind(&conflict.original_uuid)
        .bind(&conflict.copy_uuid)
        .fetch_all(&mut *tx)
        .await
        .map_err(|_| "便签读取失败")?;
    let original = notes.iter().find(|n| n.uuid == conflict.original_uuid);
    let other = notes.iter().find(|n| n.uuid == conflict.copy_uuid);
    let fp = |note: Option<&Note>| {
        fingerprint(
            &note
                .map(|n| serde_json::to_value(super::store::note_data(n)).unwrap())
                .unwrap_or(serde_json::Value::Null),
        )
    };
    if fp(original) != input.original_fingerprint || fp(other) != input.other_fingerprint {
        return Err("便签已经发生变化，请重新比较后处理".into());
    }
    match input.choice.as_str() {
        "keep_original" => {}
        "keep_other" if other.is_none() => {
            sqlx::query("DELETE FROM notes WHERE uuid=?")
                .bind(&conflict.original_uuid)
                .execute(&mut *tx)
                .await
                .map_err(|_| "便签删除失败")?;
        }
        "keep_other" | "merge" => {
            let from = if input.choice == "keep_other" {
                other
            } else {
                original.or(other)
            }
            .ok_or("没有可保留的正文")?;
            let mut data = super::store::note_data(from);
            if input.choice == "merge" {
                data.title = input.title.ok_or("请填写合并标题")?;
                data.content = input.content.ok_or("请填写合并正文")?;
                if data.content.len() > 32 * 1024 * 1024 {
                    return Err("合并正文过大".into());
                }
            } else if data.title == format!("{}（同步冲突）", conflict.other_title) {
                data.title = conflict.other_title.clone();
            }
            for hash in crate::note_assets::references(&data.content) {
                let present: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM note_assets WHERE hash=?")
                        .bind(hash)
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(|_| "附件读取失败")?;
                if present != 1 {
                    return Err("合并内容包含缺失附件，请先完成同步".into());
                }
            }
            data.updated_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            sqlx::query("INSERT INTO notes(uuid,title,content,color,is_pinned,is_completed,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(uuid) DO UPDATE SET title=excluded.title,content=excluded.content,color=excluded.color,is_pinned=excluded.is_pinned,is_completed=excluded.is_completed,updated_at=excluded.updated_at")
                .bind(&conflict.original_uuid).bind(data.title).bind(data.content).bind(data.color).bind(data.is_pinned).bind(data.is_completed).bind(chrono::DateTime::parse_from_rfc3339(&data.created_at).map_err(|_| "便签时间异常")?.with_timezone(&chrono::Utc)).bind(chrono::Utc::now()).execute(&mut *tx).await.map_err(|_| "合并便签保存失败")?;
        }
        "keep_both" => {
            if let Some(copy) = other {
                if copy.title == format!("{}（同步冲突）", conflict.other_title) {
                    sqlx::query(
                        "UPDATE notes SET title=?,updated_at=CURRENT_TIMESTAMP WHERE uuid=?",
                    )
                    .bind(format!("{}（保留副本）", conflict.other_title))
                    .bind(&conflict.copy_uuid)
                    .execute(&mut *tx)
                    .await
                    .map_err(|_| "副本保存失败")?;
                }
            }
        }
        _ => return Err("冲突处理方式无效".into()),
    }
    if input.choice != "keep_both" {
        sqlx::query("DELETE FROM notes WHERE uuid=?")
            .bind(&conflict.copy_uuid)
            .execute(&mut *tx)
            .await
            .map_err(|_| "冲突副本处理失败")?;
    }
    conflict.resolved = true;
    conflict.resolution_revision = Some(uuid::Uuid::new_v4().to_string());
    conflict.base = None;
    sqlx::query("UPDATE sync_note_conflicts SET data=? WHERE space_id=? AND id=?")
        .bind(serde_json::to_string(&conflict).map_err(|_| "冲突编码失败")?)
        .bind(&input.space_id)
        .bind(&input.id)
        .execute(&mut *tx)
        .await
        .map_err(|_| "冲突状态保存失败")?;
    tx.commit().await.map_err(|_| "冲突保存失败")?;
    Ok(())
}
#[tauri::command]
pub async fn resolve_note_conflict(app: AppHandle, resolution: Resolution) -> Result<(), String> {
    let manager = app.state::<Arc<SyncManager>>();
    let _guard = manager.enter()?;
    let db = app.state::<Arc<Database>>();
    resolve(&db.pool, resolution).await?;
    let _ = app.emit(
        "notes-changed",
        serde_json::json!({"action":"conflict-resolved"}),
    );
    let _ = app.emit(
        "sync-completed",
        serde_json::json!({"action":"conflict-resolved"}),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stale_resolution_is_refused_and_success_persists_until_next_sync() {
        let db = Database {
            pool: SqlitePool::connect("sqlite::memory:").await.unwrap(),
        };
        db.migrate().await.unwrap();
        let root = uuid::Uuid::new_v4().to_string();
        let copy = uuid::Uuid::new_v4().to_string();
        let space = uuid::Uuid::new_v4().to_string();
        for (id, title, content) in [
            (&root, "主版本", "<p>电脑</p>"),
            (&copy, "手机（同步冲突）", "<p>手机</p>"),
        ] {
            sqlx::query("INSERT INTO notes(uuid,title,content) VALUES(?,?,?)")
                .bind(id)
                .bind(title)
                .bind(content)
                .execute(&db.pool)
                .await
                .unwrap();
        }
        let conflict = NoteConflict {
            original_uuid: root.clone(),
            copy_uuid: copy.clone(),
            revisions: vec![
                uuid::Uuid::new_v4().to_string(),
                uuid::Uuid::new_v4().to_string(),
            ],
            other_title: "手机".into(),
            base: None,
            source: "siyuan".into(),
            resolved: false,
            resolution_revision: None,
        };
        sqlx::query("INSERT INTO sync_note_conflicts VALUES(?,?,?)")
            .bind(&space)
            .bind(&copy)
            .bind(serde_json::to_string(&conflict).unwrap())
            .execute(&db.pool)
            .await
            .unwrap();
        let main = snapshot(&db.pool, &root).await.unwrap();
        let other = snapshot(&db.pool, &copy).await.unwrap();
        let input = |fp: String| Resolution {
            space_id: space.clone(),
            id: copy.clone(),
            original_fingerprint: fp,
            other_fingerprint: other.fingerprint.clone(),
            choice: "keep_other".into(),
            title: None,
            content: None,
        };
        assert!(resolve(&db.pool, input("过期指纹".into()))
            .await
            .unwrap_err()
            .contains("发生变化"));
        assert!(!local(&db.pool, &space).await.unwrap()[&copy].resolved);
        resolve(&db.pool, input(main.fingerprint)).await.unwrap();
        let now = snapshot(&db.pool, &root).await.unwrap();
        assert_eq!(now.content, "<p>手机</p>");
        assert_eq!(now.title, "手机");
        assert!(snapshot(&db.pool, &copy).await.unwrap().deleted);
        let registry = local(&db.pool, &space).await.unwrap();
        assert!(registry[&copy].resolved);
        assert!(registry[&copy].resolution_revision.is_some());
        let tombstone: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_tombstones WHERE uuid=?")
                .bind(copy)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(tombstone, 1);
    }
}
