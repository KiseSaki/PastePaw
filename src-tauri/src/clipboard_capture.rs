use std::{future::Future, time::Duration};

#[derive(Default)]
pub struct SavedCapture {
    last: Option<(u32, String)>,
}

impl SavedCapture {
    pub fn contains(&self, sequence: u32, hash: &str) -> bool {
        sequence != 0
            && self
                .last
                .as_ref()
                .is_some_and(|(saved_sequence, saved_hash)| {
                    *saved_sequence == sequence && saved_hash == hash
                })
    }

    pub fn commit(&mut self, sequence: u32, hash: String) {
        self.last = Some((sequence, hash));
    }
}

// 应用可能尚未释放剪切板或完成延迟渲染；等待重试时，新通知或隐私暂停会取消旧读取。
pub async fn read_with_retry<T, F, Fut, C>(
    mut read: F,
    current: C,
    delays: &[Duration],
) -> Option<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
    C: Fn() -> bool,
{
    for attempt in 0..=delays.len() {
        if !current() {
            return None;
        }
        if let Some(content) = read().await {
            return current().then_some(content);
        }
        if let Some(delay) = delays.get(attempt) {
            tokio::time::sleep(*delay).await;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[tokio::test]
    async fn busy_or_delayed_text_is_retried_and_exhaustion_is_bounded() {
        let attempts = AtomicUsize::new(0);
        let result = read_with_retry(
            || async {
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                (n == 2).then_some("剪切的新内容")
            },
            || true,
            &[Duration::ZERO; 4],
        )
        .await;
        assert_eq!(result, Some("剪切的新内容"));
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        let attempts = AtomicUsize::new(0);
        let result = read_with_retry(
            || async {
                attempts.fetch_add(1, Ordering::SeqCst);
                None::<String>
            },
            || true,
            &[Duration::ZERO; 4],
        )
        .await;
        assert!(result.is_none());
        assert_eq!(attempts.load(Ordering::SeqCst), 5);
    }

    #[tokio::test]
    async fn new_change_or_privacy_pause_cancels_stale_reads() {
        let current = AtomicBool::new(true);
        let attempts = AtomicUsize::new(0);
        let result = read_with_retry(
            || async {
                attempts.fetch_add(1, Ordering::SeqCst);
                current.store(false, Ordering::SeqCst);
                Some("旧应用内容")
            },
            || current.load(Ordering::SeqCst),
            &[Duration::ZERO; 4],
        )
        .await;
        assert!(result.is_none());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn only_committed_sequence_is_deduplicated_and_new_copy_can_bump_existing_text() {
        let mut saved = SavedCapture::default();
        assert!(!saved.contains(8, "相同正文"));
        // 过滤、读取失败或数据库失败不会调用提交，因此重试仍可保存。
        assert!(!saved.contains(8, "相同正文"));
        saved.commit(8, "相同正文".into());
        assert!(saved.contains(8, "相同正文"));
        assert!(!saved.contains(9, "相同正文"));
        assert!(!saved.contains(8, "不同正文"));
        assert!(!saved.contains(0, "相同正文"));
    }
}
