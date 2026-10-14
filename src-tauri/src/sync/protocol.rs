use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const MIB: u64 = 1024 * 1024;
pub const MAX_DOCUMENT: u64 = 32 * MIB;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct CloudPolicy {
    pub max_clips: usize,
    pub clipboard_mib: u64,
    pub image_mib: u64,
    pub total_mib: u64,
    pub sync_images: bool,
}

impl Default for CloudPolicy {
    fn default() -> Self {
        Self {
            max_clips: 100,
            clipboard_mib: 200,
            image_mib: 5,
            total_mib: 500,
            sync_images: true,
        }
    }
}

impl CloudPolicy {
    pub fn validate(&self) -> Result<(), String> {
        if self.max_clips > 10_000
            || !(1..=10_240).contains(&self.clipboard_mib)
            || !(1..=20).contains(&self.image_mib)
            || !(10..=102_400).contains(&self.total_mib)
            || self.clipboard_mib >= self.total_mib
        {
            return Err("容量设置无效：剪切板额度须小于总额度，单图上限为 1–20 MiB".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct SyncOptions {
    pub enabled: bool,
    pub automatic: bool,
    pub interval_seconds: u64,
    pub lock_after_minutes: u64,
    pub policy: CloudPolicy,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            enabled: false,
            automatic: true,
            interval_seconds: 60,
            lock_after_minutes: 30,
            policy: CloudPolicy::default(),
        }
    }
}

impl SyncOptions {
    pub fn validate(&self) -> Result<(), String> {
        self.policy.validate()?;
        if !(30..=3600).contains(&self.interval_seconds)
            || !(5..=240).contains(&self.lock_after_minutes)
        {
            return Err("同步间隔应为 30–3600 秒，解锁有效期应为 5–240 分钟".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Record {
    pub revision: String,
    pub deleted: bool,
    pub updated_at: i64,
    pub data: Option<Value>,
}

impl Record {
    #[cfg(test)]
    pub fn new(data: Option<Value>) -> Self {
        Self {
            revision: Uuid::new_v4().to_string(),
            deleted: data.is_none(),
            updated_at: chrono::Utc::now().timestamp_millis(),
            data,
        }
    }
    pub fn same_content(&self, other: &Self) -> bool {
        self.deleted == other.deleted && self.data == other.data
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FolderData {
    pub name: String,
    pub icon: Option<String>,
    pub color: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Document {
    pub schema_version: u32,
    pub space_id: String,
    pub generation: u64,
    pub records: BTreeMap<String, Record>,
    #[serde(default)]
    pub folders: BTreeMap<String, FolderData>,
    #[serde(default)]
    pub policy: Option<CloudPolicy>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub note_assets: BTreeMap<String, crate::note_assets::Asset>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub note_conflicts: BTreeMap<String, NoteConflict>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct NoteConflict {
    pub original_uuid: String,
    pub copy_uuid: String,
    pub revisions: Vec<String>,
    pub other_title: String,
    pub base: Option<Value>,
    pub source: String,
    pub resolved: bool,
    pub resolution_revision: Option<String>,
}

impl Document {
    pub fn new(space_id: String) -> Self {
        Self {
            schema_version: 1,
            space_id,
            generation: 0,
            records: BTreeMap::new(),
            folders: BTreeMap::new(),
            policy: None,
            note_assets: BTreeMap::new(),
            note_conflicts: BTreeMap::new(),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.schema_version, 1..=3)
            || Uuid::parse_str(&self.space_id).is_err()
            || self.records.len() > 100_000
            || self.generation >= u64::MAX - 1
        {
            return Err("远端同步格式不受支持或数据过大".into());
        }
        for (id, r) in &self.records {
            if Uuid::parse_str(id).is_err()
                || Uuid::parse_str(&r.revision).is_err()
                || r.deleted != r.data.is_none()
            {
                return Err("远端记录结构异常".into());
            }
        }
        for id in self.folders.keys() {
            if Uuid::parse_str(id).is_err() {
                return Err("远端分组标识异常".into());
            }
        }
        if let Some(policy) = &self.policy {
            policy.validate()?;
        }
        for (hash, asset) in &self.note_assets {
            asset.validate()?;
            if hash != &asset.hash || self.schema_version < 2 {
                return Err("便签附件索引版本或标识不一致".into());
            }
        }
        if self.note_conflicts.len() > 100_000 {
            return Err("冲突记录过多".into());
        }
        for (id, conflict) in &self.note_conflicts {
            if self.schema_version != 3
                || id != &conflict.copy_uuid
                || conflict.original_uuid == conflict.copy_uuid
                || [id.as_str(), conflict.original_uuid.as_str()]
                    .iter()
                    .any(|s| Uuid::parse_str(s).is_err())
                || conflict.revisions.len() != 2
                || conflict
                    .revisions
                    .iter()
                    .any(|r| Uuid::parse_str(r).is_err())
                || !["device", "siyuan"].contains(&conflict.source.as_str())
                || conflict
                    .resolution_revision
                    .as_ref()
                    .is_some_and(|r| Uuid::parse_str(r).is_err())
            {
                return Err("冲突记录结构异常".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct NoteData {
    pub title: String,
    pub content: String,
    pub color: Option<String>,
    pub is_pinned: bool,
    pub is_completed: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ClipData {
    pub clip_type: String,
    pub content: String,
    pub content_hash: String,
    pub preview: String,
    pub folder_uuid: Option<String>,
    pub is_pinned: bool,
    pub metadata: Option<String>,
    pub created_at: String,
    pub asset: Option<String>,
    pub size_bytes: u64,
    #[serde(default)]
    pub source_app: Option<String>,
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn valid_asset(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

// 以同步基线判断双方修改；冲突副本的 ID 可重复计算，重试不会不断产生副本。
pub fn merge_detailed(
    base: &Document,
    local: &Document,
    remote: &Document,
    notes: bool,
) -> (Document, usize, usize) {
    let mut result = remote.clone();
    let mut conflicts = 0;
    let mut auto_merged = 0;
    for (id, conflict) in &local.note_conflicts {
        if !result.note_conflicts.get(id).is_some_and(|c| c.resolved) {
            result.note_conflicts.insert(id.clone(), conflict.clone());
        }
    }
    for (id, entry) in &local.records {
        let before = base.records.get(id);
        let theirs = remote.records.get(id);
        if before.is_some_and(|b| b.same_content(entry)) {
            continue;
        }
        if notes
            && result
                .note_conflicts
                .values()
                .any(|c| c.original_uuid == *id && c.revisions.contains(&entry.revision))
        {
            // 已保存或已处理过的旧版本不能因断网重试或离线设备再次产生同一冲突。
            continue;
        }
        if theirs.is_none() || theirs == before || theirs.is_some_and(|r| r.same_content(entry)) {
            result.records.insert(id.clone(), entry.clone());
            continue;
        }
        let theirs = theirs.unwrap();
        if notes {
            if let Some(merged) =
                before.and_then(|b| super::note_merge::merge_record(b, entry, theirs))
            {
                result.records.insert(id.clone(), merged);
                auto_merged += 1;
                continue;
            }
        }
        conflicts += 1;
        if notes {
            {
                let mut revisions = vec![entry.revision.clone(), theirs.revision.clone()];
                revisions.sort();
                let conflict_id = super::note_merge::revision_id(&format!(
                    "conflict:{id}:{}:{}",
                    revisions[0], revisions[1]
                ));
                let title = entry
                    .data
                    .as_ref()
                    .or_else(|| before.and_then(|b| b.data.as_ref()))
                    .or(theirs.data.as_ref())
                    .and_then(|d| d.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or("便签")
                    .to_owned();
                result.note_conflicts.insert(
                    conflict_id.clone(),
                    NoteConflict {
                        original_uuid: id.clone(),
                        copy_uuid: conflict_id.clone(),
                        revisions,
                        other_title: title.clone(),
                        base: before.and_then(|b| b.data.clone()),
                        source: "device".into(),
                        resolved: false,
                        resolution_revision: None,
                    },
                );
                let mut copy = entry.clone();
                if let Some(obj) = copy.data.as_mut().and_then(Value::as_object_mut) {
                    obj.insert(
                        "title".into(),
                        Value::String(format!("{title}（同步冲突）")),
                    );
                }
                result.records.insert(conflict_id, copy);
            }
        } else if entry.updated_at > theirs.updated_at
            || (entry.updated_at == theirs.updated_at && entry.revision > theirs.revision)
        {
            result.records.insert(id.clone(), entry.clone());
        }
    }
    for (id, folder) in &local.folders {
        if base.folders.get(id) != Some(folder) {
            result.folders.insert(id.clone(), folder.clone());
        }
    }
    result.generation = remote.generation + 1;
    if notes {
        result.schema_version = 3;
        result.note_assets.extend(local.note_assets.clone());
        let refs: std::collections::BTreeSet<String> = result
            .records
            .values()
            .filter_map(|r| r.data.as_ref())
            .filter_map(|data| data.get("content").and_then(Value::as_str))
            .flat_map(crate::note_assets::references)
            .collect();
        result.note_assets.retain(|hash, _| refs.contains(hash));
    }
    (result, conflicts, auto_merged)
}

#[cfg(test)]
pub fn merge(
    base: &Document,
    local: &Document,
    remote: &Document,
    notes: bool,
) -> (Document, usize) {
    let (doc, conflicts, _) = merge_detailed(base, local, remote, notes);
    (doc, conflicts)
}

pub fn limit_clips(document: &mut Document, policy: &CloudPolicy) -> Result<usize, String> {
    let mut candidates = Vec::new();
    for (id, record) in &document.records {
        if let Some(value) = &record.data {
            let clip: ClipData =
                serde_json::from_value(value.clone()).map_err(|_| "远端剪切板记录异常")?;
            candidates.push((id.clone(), clip));
        }
    }
    candidates.sort_by(|a, b| {
        b.1.created_at
            .cmp(&a.1.created_at)
            .then_with(|| a.0.cmp(&b.0))
    });
    let mut keep = std::collections::HashSet::new();
    let mut seen = std::collections::HashSet::new();
    let mut assets = std::collections::HashSet::new();
    let mut minimum = document.clone();
    minimum.records.retain(|_, record| record.deleted);
    minimum.folders.clear();
    minimum.policy = Some(policy.clone());
    let mut bytes = serde_json::to_vec(&minimum)
        .map_err(|_| "剪切板索引编码失败")?
        .len() as u64;
    if bytes > policy.clipboard_mib * MIB {
        return Err("剪切板删除标记已达到额度，请备份并迁移同步空间".into());
    }
    let mut folders = std::collections::HashSet::new();
    let mut skipped = 0;
    for (id, clip) in candidates {
        if clip.clip_type == "image"
            && (!policy.sync_images || clip.size_bytes > policy.image_mib * MIB)
        {
            skipped += 1;
            continue;
        }
        let key = format!(
            "{}:{}",
            clip.clip_type,
            clip.asset.as_deref().unwrap_or(&clip.content_hash)
        );
        if seen.contains(&key) {
            continue;
        }
        let metadata = serde_json::to_vec(document.records.get(&id).unwrap())
            .map_err(|_| "剪切板编码失败")?
            .len() as u64
            + id.len() as u64
            + 4;
        let folder_size = match &clip.folder_uuid {
            Some(id) if !folders.contains(id) => document
                .folders
                .get(id)
                .map(|folder| {
                    serde_json::to_vec(folder).map(|bytes| bytes.len() as u64 + id.len() as u64 + 4)
                })
                .transpose()
                .map_err(|_| "分组编码失败")?
                .unwrap_or(0),
            _ => 0,
        };
        let asset_size = clip
            .asset
            .as_ref()
            .filter(|a| !assets.contains(*a))
            .map_or(0, |_| clip.size_bytes);
        let cost = metadata + asset_size + folder_size;
        if keep.len() >= policy.max_clips || bytes + cost > policy.clipboard_mib * MIB {
            skipped += 1;
            continue;
        }
        bytes += cost;
        keep.insert(id);
        seen.insert(key);
        if let Some(folder) = clip.folder_uuid {
            folders.insert(folder);
        }
        if let Some(asset) = clip.asset {
            assets.insert(asset);
        }
    }
    document
        .records
        .retain(|id, r| r.deleted || keep.contains(id));
    let used_folders: std::collections::HashSet<String> = document
        .records
        .values()
        .filter_map(|r| r.data.as_ref())
        .filter_map(|v| {
            v.get("folder_uuid")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    document.folders.retain(|id, _| used_folders.contains(id));
    Ok(skipped)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolved_conflicts_survive_stale_devices_and_do_not_reappear() {
        let id = Uuid::new_v4().to_string();
        let mut base = Document::new(Uuid::new_v4().to_string());
        base.records.insert(
            id.clone(),
            Record::new(Some(
                serde_json::json!({"title":"原始","content":"<p>原文</p>"}),
            )),
        );
        let mut local = base.clone();
        local.records.insert(
            id.clone(),
            Record::new(Some(
                serde_json::json!({"title":"原始","content":"<p>本地</p>"}),
            )),
        );
        let mut remote = base.clone();
        remote.records.insert(
            id.clone(),
            Record::new(Some(
                serde_json::json!({"title":"原始","content":"<p>远端</p>"}),
            )),
        );
        let (mut resolved, count, _) = merge_detailed(&base, &local, &remote, true);
        assert_eq!(count, 1);
        let copy = resolved.note_conflicts.keys().next().unwrap().clone();
        resolved.note_conflicts.get_mut(&copy).unwrap().resolved = true;
        resolved
            .note_conflicts
            .get_mut(&copy)
            .unwrap()
            .resolution_revision = Some(Uuid::new_v4().to_string());
        resolved.records.insert(copy, Record::new(None));
        resolved.records.insert(
            id.clone(),
            Record::new(Some(
                serde_json::json!({"title":"原始","content":"<p>手工合并</p>"}),
            )),
        );
        let (again, count, _) = merge_detailed(&base, &local, &resolved, true);
        assert_eq!(count, 0);
        assert_eq!(again.records, resolved.records);
        assert_eq!(again.note_conflicts, resolved.note_conflicts);
        let mut stale = local.clone();
        stale.note_conflicts = remote.note_conflicts.clone();
        assert_eq!(
            merge_detailed(&base, &stale, &resolved, true)
                .0
                .note_conflicts,
            resolved.note_conflicts
        );
    }
    #[test]
    fn local_delete_and_remote_edit_preserve_deletion_as_a_resolvable_version() {
        let id = Uuid::new_v4().to_string();
        let mut base = Document::new(Uuid::new_v4().to_string());
        base.records.insert(
            id.clone(),
            Record::new(Some(
                serde_json::json!({"title":"原始","content":"<p>原文</p>"}),
            )),
        );
        let mut local = base.clone();
        local.records.insert(id.clone(), Record::new(None));
        let mut remote = base.clone();
        remote.records.insert(
            id.clone(),
            Record::new(Some(
                serde_json::json!({"title":"原始","content":"<p>编辑后</p>"}),
            )),
        );
        let (doc, count, _) = merge_detailed(&base, &local, &remote, true);
        assert_eq!(count, 1);
        let conflict = doc.note_conflicts.values().next().unwrap();
        assert!(doc.records[&conflict.copy_uuid].deleted);
        assert_eq!(doc.records[&id], remote.records[&id]);
        doc.validate().unwrap();
    }
    #[test]
    fn simultaneous_note_edits_and_delete_preserve_content() {
        let id = Uuid::new_v4().to_string();
        let mut base = Document::new(Uuid::new_v4().to_string());
        base.records.insert(
            id.clone(),
            Record::new(Some(
                serde_json::json!({"title":"原始","content":"original"}),
            )),
        );
        let mut local = base.clone();
        local.records.insert(
            id.clone(),
            Record::new(Some(serde_json::json!({"title":"本地","content":"local"}))),
        );
        let mut remote = base.clone();
        remote.records.insert(id.clone(), Record::new(None));
        let (merged, conflicts) = merge(&base, &local, &remote, true);
        assert_eq!(conflicts, 1);
        assert!(merged.records[&id].deleted);
        assert!(merged
            .records
            .values()
            .any(|r| r.data.as_ref().is_some_and(|d| d["content"] == "local")));
        assert_eq!(
            merge(&base, &local, &remote, true).0.records,
            merged.records
        );
    }
    #[test]
    fn capacity_is_global_and_zero_disables_clipboard() {
        let mut doc = Document::new(Uuid::new_v4().to_string());
        for i in 0..3 {
            let clip = ClipData {
                clip_type: "text".into(),
                content: "eA==".into(),
                content_hash: i.to_string(),
                preview: "x".into(),
                folder_uuid: None,
                is_pinned: false,
                metadata: None,
                created_at: format!("2026-10-{:02}T00:00:00Z", i + 1),
                asset: None,
                size_bytes: 1,
                source_app: None,
            };
            doc.records.insert(
                Uuid::new_v4().to_string(),
                Record::new(Some(serde_json::to_value(clip).unwrap())),
            );
        }
        let mut policy = CloudPolicy {
            max_clips: 1,
            ..Default::default()
        };
        limit_clips(&mut doc, &policy).unwrap();
        assert_eq!(doc.records.len(), 1);
        policy.max_clips = 0;
        limit_clips(&mut doc, &policy).unwrap();
        assert!(doc.records.is_empty());
    }
}
