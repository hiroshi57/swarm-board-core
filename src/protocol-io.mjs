import { POST_TYPES, VERDICTS } from 'swarm-board-protocol';

/**
 * エージェントの出力から投稿を取り出す。
 *
 * 期待する形式（1 回の応答に複数置ける）:
 *
 * ```post
 * {"to":["@verifier"],"type":"done","subject":"...","body":"..."}
 * ```
 *
 * LLM は囲い方を間違えるので、```post / ```json / 素の JSON オブジェクトの
 * いずれでも拾う。拾えなかったテキストは rejected として返し、捨てずに記録する。
 */
export function extractPosts(text) {
  const src = String(text ?? '');
  const posts = [];
  const rejected = [];
  const seen = new Set();

  const fence = /```(?:post|json)?\s*\n([\s\S]*?)\n?```/g;
  let m;
  while ((m = fence.exec(src)) !== null) {
    consume(m[1], m.index);
  }

  // フェンスが 1 つも無い場合だけ、素の JSON オブジェクトを探す
  if (posts.length === 0 && rejected.length === 0) {
    for (const chunk of scanBareObjects(src)) consume(chunk.text, chunk.index);
  }

  function consume(raw, index) {
    const trimmed = raw.trim();
    if (trimmed === '') return;
    // 1 つのフェンスに複数の JSON が並ぶことがある
    const chunks = trimmed.startsWith('[') ? tryArray(trimmed) : [...scanBareObjects(trimmed)].map((c) => c.text);
    if (chunks.length === 0) {
      rejected.push({ index, raw: trimmed, reason: 'JSON として読めません' });
      return;
    }
    for (const c of chunks) {
      let obj;
      try {
        obj = JSON.parse(c);
      } catch (e) {
        rejected.push({ index, raw: c, reason: `JSON として読めません: ${e.message}` });
        continue;
      }
      const err = shapeError(obj);
      if (err) {
        rejected.push({ index, raw: c, reason: err });
        continue;
      }
      const key = JSON.stringify([obj.type, obj.subject, obj.ref ?? null, obj.task_id ?? null]);
      if (seen.has(key)) continue; // 同一応答内の重複投稿は 1 件に畳む
      seen.add(key);
      posts.push(normalize(obj));
    }
  }

  return { posts, rejected };
}

function tryArray(text) {
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr.map((o) => JSON.stringify(o)) : [];
  } catch {
    return [];
  }
}

/** 文字列中のバランスの取れた {...} を、文字列リテラルを考慮して切り出す */
function* scanBareObjects(text) {
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        yield { text: text.slice(start, i + 1), index: start };
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
}

function shapeError(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 'オブジェクトではありません';
  if (!POST_TYPES.includes(obj.type)) return `type が不正です: ${JSON.stringify(obj.type)}`;
  if (typeof obj.subject !== 'string' || obj.subject.trim() === '') return 'subject が空です';
  if (obj.to !== undefined && !Array.isArray(obj.to)) return 'to が配列ではありません';
  if (obj.type === 'verify_result' && !VERDICTS.includes(obj.verdict)) return `verify_result の verdict が不正です: ${JSON.stringify(obj.verdict)}`;
  return null;
}

function normalize(obj) {
  const to = (Array.isArray(obj.to) ? obj.to : [])
    .filter((x) => typeof x === 'string')
    .map((x) => (x.startsWith('@') ? x : `@${x}`));
  const out = { type: obj.type, to, subject: String(obj.subject).slice(0, 120) };
  if (obj.body) out.body = String(obj.body);
  if (obj.task_id) out.task_id = String(obj.task_id);
  if (obj.ref) out.ref = String(obj.ref);
  if (obj.verdict) out.verdict = obj.verdict;
  if (Array.isArray(obj.artifacts)) {
    out.artifacts = obj.artifacts
      .filter((a) => a && typeof a.path === 'string')
      .map((a) => ({ path: a.path, ...(a.kind ? { kind: a.kind } : {}), ...(a.sha256 ? { sha256: a.sha256 } : {}) }));
  }
  if (obj.meta && typeof obj.meta === 'object') out.meta = obj.meta;
  return out;
}
