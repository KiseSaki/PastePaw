use super::protocol::{digest, Record};
use serde_json::{Map, Value};

#[derive(Clone, PartialEq)]
struct Edit {
    from: usize,
    to: usize,
    text: Vec<String>,
}
fn tokens(html: &str) -> Vec<String> {
    let mut result = Vec::new();
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let from = i;
        if bytes[i] == b'<' {
            let mut quote = 0;
            i += 1;
            while i < bytes.len() {
                let c = bytes[i];
                i += 1;
                if quote != 0 {
                    if c == quote {
                        quote = 0;
                    }
                } else if c == b'\'' || c == b'"' {
                    quote = c;
                } else if c == b'>' {
                    break;
                }
            }
        } else if bytes[i] == b'&'
            && html[i..].find(';').is_some_and(|end| {
                end < 16
                    && html[i + 1..i + end]
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '#')
            })
        {
            i += html[i..].find(';').unwrap() + 1;
        } else {
            i += html[i..].chars().next().unwrap().len_utf8();
        }
        result.push(html[from..i].to_owned());
    }
    result
}
fn valid(tokens: &[String]) -> bool {
    let allowed = [
        "p",
        "div",
        "span",
        "label",
        "input",
        "ul",
        "ol",
        "li",
        "blockquote",
        "pre",
        "code",
        "a",
        "strong",
        "b",
        "em",
        "i",
        "u",
        "s",
        "del",
        "strike",
        "mark",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "br",
        "img",
        "table",
        "tbody",
        "thead",
        "tfoot",
        "tr",
        "th",
        "td",
        "colgroup",
        "col",
    ];
    let mut stack = Vec::new();
    for token in tokens {
        if !token.starts_with('<') {
            continue;
        }
        if !token.ends_with('>') {
            return false;
        }
        let closing = token.starts_with("</");
        let rest = &token[if closing { 2 } else { 1 }..];
        let name: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_lowercase();
        if !allowed.contains(&name.as_str()) {
            return false;
        }
        if closing {
            if stack.pop().as_ref() != Some(&name) {
                return false;
            }
        } else if !["input", "hr", "br", "img", "col"].contains(&name.as_str())
            && !token.ends_with("/>")
        {
            stack.push(name);
        }
    }
    stack.is_empty()
}
fn edits(before: &[String], after: &[String]) -> Vec<Edit> {
    let mut prefix = 0;
    let mut suffix = 0;
    while prefix < before.len() && prefix < after.len() && before[prefix] == after[prefix] {
        prefix += 1;
    }
    while suffix < before.len() - prefix
        && suffix < after.len() - prefix
        && before[before.len() - 1 - suffix] == after[after.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let a = &before[prefix..before.len() - suffix];
    let b = &after[prefix..after.len() - suffix];
    if a.is_empty() && b.is_empty() {
        return Vec::new();
    }
    if (a.len() + 1).saturating_mul(b.len() + 1) > 1_000_000 {
        return vec![Edit {
            from: prefix,
            to: before.len() - suffix,
            text: b.to_vec(),
        }];
    }
    let width = b.len() + 1;
    let mut scores = vec![0u32; (a.len() + 1) * width];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            scores[i * width + j] = if a[i] == b[j] {
                scores[(i + 1) * width + j + 1] + 1
            } else {
                scores[(i + 1) * width + j].max(scores[i * width + j + 1])
            };
        }
    }
    let mut result = Vec::new();
    let (mut i, mut j) = (0, 0);
    let mut pending: Option<Edit> = None;
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            if let Some(edit) = pending.take() {
                result.push(edit);
            }
            i += 1;
            j += 1;
        } else {
            let edit = pending.get_or_insert_with(|| Edit {
                from: prefix + i,
                to: prefix + i,
                text: Vec::new(),
            });
            if i < a.len()
                && (j == b.len() || scores[(i + 1) * width + j] >= scores[i * width + j + 1])
            {
                i += 1;
                edit.to = prefix + i;
            } else {
                edit.text.push(b[j].clone());
                j += 1;
            }
        }
    }
    if let Some(edit) = pending {
        result.push(edit);
    }
    result
}
pub fn merge_content(base: &str, local: &str, remote: &str) -> Option<String> {
    if local == remote || remote == base {
        return Some(local.into());
    }
    if local == base {
        return Some(remote.into());
    }
    if [base, local, remote].iter().any(|s| s.len() > 200_000) {
        return None;
    }
    let original = tokens(base);
    let a = edits(&original, &tokens(local));
    let b = edits(&original, &tokens(remote));
    let mut changes = a.clone();
    for other in b {
        let mut duplicate = false;
        for one in &a {
            if one == &other {
                duplicate = true;
                break;
            }
            let overlap = if one.from == one.to || other.from == other.to {
                one.from <= other.to && other.from <= one.to
            } else {
                one.from < other.to && other.from < one.to
            };
            if overlap {
                return None;
            }
        }
        if !duplicate {
            changes.push(other);
        }
    }
    changes.sort_by(|a, b| b.from.cmp(&a.from).then(b.to.cmp(&a.to)));
    let mut merged = original;
    for edit in changes {
        merged.splice(edit.from..edit.to, edit.text);
    }
    valid(&merged).then(|| merged.concat())
}
pub fn merge_data(base: &Value, local: &Value, remote: &Value) -> Option<Value> {
    let (before, a, b) = (base.as_object()?, local.as_object()?, remote.as_object()?);
    let keys: std::collections::BTreeSet<_> =
        before.keys().chain(a.keys()).chain(b.keys()).collect();
    let mut result = Map::new();
    for key in keys {
        let (old, one, two) = (before.get(key), a.get(key), b.get(key));
        let value = if key == "updated_at" {
            Value::String(one?.as_str()?.max(two?.as_str()?).to_owned())
        } else if one == two || two == old {
            one.cloned()?
        } else if one == old {
            two.cloned()?
        } else if key == "content" {
            Value::String(merge_content(
                old?.as_str()?,
                one?.as_str()?,
                two?.as_str()?,
            )?)
        } else {
            return None;
        };
        result.insert(key.clone(), value);
    }
    Some(Value::Object(result))
}
pub fn revision_id(seed: &str) -> String {
    let hash = sha2::Sha256::digest(seed.as_bytes());
    uuid::Uuid::from_bytes(hash[..16].try_into().unwrap()).to_string()
}
use sha2::Digest;
pub fn merge_record(base: &Record, local: &Record, remote: &Record) -> Option<Record> {
    let data = merge_data(
        base.data.as_ref()?,
        local.data.as_ref()?,
        remote.data.as_ref()?,
    )?;
    let mut revisions = [&local.revision, &remote.revision];
    revisions.sort();
    let revision = revision_id(&format!(
        "merge:{}:{}:{}:{}",
        base.revision, revisions[0], revisions[1], data
    ));
    Some(Record {
        revision,
        deleted: false,
        updated_at: local.updated_at.max(remote.updated_at),
        data: Some(data),
    })
}
pub fn fingerprint(data: &Value) -> String {
    digest(data.to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_body_cases_are_symmetric() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../shared/merge-fixtures.json")).unwrap();
        for case in cases {
            let text = |key: &str| case[key].as_str().unwrap();
            let expected = case["expected"].as_str().map(str::to_owned);
            assert_eq!(
                merge_content(text("base"), text("local"), text("remote")),
                expected,
                "{}",
                case["name"]
            );
            assert_eq!(
                merge_content(text("base"), text("remote"), text("local")),
                expected,
                "{}",
                case["name"]
            );
        }
    }
    #[test]
    fn independent_fields_merge_and_large_overlapping_bodies_do_not() {
        let base = serde_json::json!({"title":"甲","content":"<p>乙</p>"});
        let one = serde_json::json!({"title":"新甲","content":"<p>乙</p>"});
        let two = serde_json::json!({"title":"甲","content":"<p>新乙</p>"});
        assert_eq!(
            merge_data(&base, &one, &two),
            Some(serde_json::json!({"title":"新甲","content":"<p>新乙</p>"}))
        );
        let large = "字".repeat(100_000);
        assert!(merge_content(&large, &format!("甲{large}"), &format!("乙{large}")).is_none());
    }
}
