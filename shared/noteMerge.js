// 两端执行同样的三方比较；相同输入必须得到相同结果，不能用设备时间决定正文胜负。
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const equal = (a, b) => stableJson(a) === stableJson(b);
export function htmlTokens(html) {
  const tokens = [];
  for (let i = 0; i < html.length; ) {
    const from = i;
    if (html[i] === '<') {
      let quote = '';
      for (i++; i < html.length; i++) {
        const c = html[i];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') {
          i++;
          break;
        }
      }
    } else if (
      html[i] === '&' &&
      /^&[a-z0-9#]*;/i.test(html.slice(i)) &&
      html.slice(i).match(/^&[a-z0-9#]*;/i)[0].length <= 16
    ) {
      i += html.slice(i).match(/^&[a-z0-9#]*;/i)[0].length;
    } else i += String.fromCodePoint(html.codePointAt(i)).length;
    tokens.push(html.slice(from, i));
  }
  return tokens;
}
export function validStructure(tokens) {
  const stack = [];
  const allowed = new Set(
    'p div span label input ul ol li blockquote pre code a strong b em i u s del strike mark h1 h2 h3 h4 h5 h6 hr br img table tbody thead tfoot tr th td colgroup col'.split(
      ' '
    )
  );
  const voids = new Set(['input', 'hr', 'br', 'img', 'col']);
  for (const token of tokens) {
    if (!token.startsWith('<')) continue;
    const match = token.match(/^<(\/)?([a-z][a-z0-9]*)\b[\s\S]*>$/i);
    if (!match || !allowed.has(match[2].toLowerCase())) return false;
    const name = match[2].toLowerCase();
    if (match[1]) {
      if (stack.pop() !== name) return false;
    } else if (!voids.has(name) && !token.endsWith('/>')) stack.push(name);
  }
  return stack.length === 0;
}
function edits(before, after) {
  let prefix = 0,
    suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  const a = before.slice(prefix, before.length - suffix),
    b = after.slice(prefix, after.length - suffix);
  if (!a.length && !b.length) return [];
  if ((a.length + 1) * (b.length + 1) > 1_000_000)
    return [{ from: prefix, to: before.length - suffix, text: b }];
  const width = b.length + 1,
    scores = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      scores[i * width + j] =
        a[i] === b[j]
          ? scores[(i + 1) * width + j + 1] + 1
          : Math.max(scores[(i + 1) * width + j], scores[i * width + j + 1]);
  const result = [];
  let i = 0,
    j = 0,
    pending = null;
  const flush = () => {
    if (pending) {
      result.push(pending);
      pending = null;
    }
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else {
      pending ||= { from: prefix + i, to: prefix + i, text: [] };
      if (
        i < a.length &&
        (j === b.length || scores[(i + 1) * width + j] >= scores[i * width + j + 1])
      )
        pending.to = prefix + ++i;
      else pending.text.push(b[j++]);
    }
  }
  flush();
  return result;
}
export function mergeContent(base, local, remote) {
  if (local === remote || remote === base) return local;
  if (local === base) return remote;
  if (
    [base, local, remote].some(
      (s) => typeof s !== 'string' || new TextEncoder().encode(s).length > 200_000
    )
  )
    return null;
  const original = htmlTokens(base),
    a = edits(original, htmlTokens(local)),
    b = edits(original, htmlTokens(remote));
  const changes = [...a];
  for (const other of b) {
    let duplicate = false;
    for (const one of a) {
      if (equal(one, other)) {
        duplicate = true;
        break;
      }
      const insert = one.from === one.to || other.from === other.to;
      if (
        insert
          ? one.from <= other.to && other.from <= one.to
          : one.from < other.to && other.from < one.to
      )
        return null;
    }
    if (!duplicate) changes.push(other);
  }
  changes.sort((a, b) => b.from - a.from || b.to - a.to);
  let merged = [...original];
  for (const change of changes)
    merged = merged.slice(0, change.from).concat(change.text, merged.slice(change.to));
  return validStructure(merged) ? merged.join('') : null;
}
export function mergeNoteData(base, local, remote) {
  if (!base || !local || !remote) return null;
  const merged = {};
  for (const key of [
    ...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]),
  ].sort()) {
    if (key === 'updated_at') {
      merged[key] = [local[key], remote[key]].sort().at(-1);
      continue;
    }
    const a = local[key],
      b = remote[key],
      before = base[key];
    if (equal(a, b) || equal(b, before)) merged[key] = a;
    else if (equal(a, before)) merged[key] = b;
    else if (key === 'content') {
      const body = mergeContent(before, a, b);
      if (body === null) return null;
      merged[key] = body;
    } else return null;
  }
  return merged;
}
export async function digest(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export async function revisionId(seed) {
  const h = await digest(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
export async function mergedRecord(base, local, remote) {
  const data = mergeNoteData(base?.data, local?.data, remote?.data);
  if (!data) return null;
  const revision = await revisionId(
    `merge:${base.revision}:${[local.revision, remote.revision].sort().join(':')}:${stableJson(data)}`
  );
  return {
    revision,
    deleted: false,
    updated_at: Math.max(local.updated_at, remote.updated_at),
    data,
  };
}
