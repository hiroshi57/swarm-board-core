import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { makePost, serializePost, parseBoard, validateBoard, summarize, roleOf } from 'swarm-board-protocol';

/**
 * 追記専用の掲示板。
 *
 * 状態はすべて 1 本の JSONL ファイルにある。プロセスが落ちても、
 * 同じパスで open し直せば続きから再開できる。
 */
export class Board {
  /** @param {string} path board.jsonl のパス */
  constructor(path) {
    this.path = path;
    this.posts = [];
    if (existsSync(path)) {
      const { posts, issues } = parseBoard(readFileSync(path, 'utf8'));
      if (issues.length > 0) {
        throw new Error(`既存のボードが壊れています: ${path}\n  ${issues.map((i) => `L${i.line} ${i.message}`).join('\n  ')}`);
      }
      this.posts = posts;
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
    }
  }

  get length() {
    return this.posts.length;
  }

  /** 次に割り当てられる seq */
  get nextSeq() {
    return this.posts.length + 1;
  }

  /**
   * Post を 1 件追記する。seq / id / ts は自動で埋まる。
   * @param {object} fields from / to / type / subject など
   * @returns {object} 追記された Post
   */
  append(fields) {
    const post = makePost(this.nextSeq, fields);
    const last = this.posts.at(-1);
    // ts の単調性を壊さない（同一ミリ秒の並行追記に備える）
    if (last && Date.parse(post.ts) < Date.parse(last.ts)) post.ts = last.ts;
    appendFileSync(this.path, serializePost(post) + '\n', 'utf8');
    this.posts.push({ ...post, __line: this.posts.length + 1 });
    return post;
  }

  /** seq より後の Post をすべて返す */
  since(seq) {
    return this.posts.filter((p) => p.seq > seq);
  }

  /**
   * あるエージェント宛の未読を返す。
   * 空配列の to（broadcast）は自分の投稿を除いて全員の受信箱に入る。
   */
  inbox(agent, sinceSeq = 0) {
    return this.posts.filter((p) => {
      if (p.seq <= sinceSeq) return false;
      if (p.from === agent) return false;
      const to = Array.isArray(p.to) ? p.to : [];
      return to.length === 0 || to.includes(agent);
    });
  }

  /** ボードに登場したエージェント名の一覧 */
  agents() {
    const set = new Set();
    for (const p of this.posts) {
      set.add(p.from);
      for (const t of Array.isArray(p.to) ? p.to : []) set.add(t);
    }
    return [...set];
  }

  /** 直近 n 件を、モデルに読ませる短いテキストに畳む */
  render(n = 40, { maxBody = 600 } = {}) {
    const slice = this.posts.slice(-n);
    return slice.map((p) => {
      const to = (Array.isArray(p.to) ? p.to : []).join(', ') || '全員';
      const head = `[${p.id}] ${p.from} → ${to} (${p.type}${p.task_id ? ` / ${p.task_id}` : ''}${p.verdict ? ` / ${p.verdict}` : ''}${p.ref ? ` / ref=${p.ref}` : ''})`;
      const body = p.body ? `\n${truncate(p.body, maxBody)}` : '';
      return `${head}\n${p.subject}${body}`;
    }).join('\n---\n');
  }

  /** ミッションが終わっていれば理由を返す。続行中なら null */
  terminalState() {
    for (const p of this.posts) {
      if (p.type === 'abort') return { reason: 'abort', post: p };
    }
    const last = [...this.posts].reverse().find(
      (p) => p.type === 'done' && roleOf(p.from) === 'coordinator' && (p.to ?? []).length === 0,
    );
    if (last) return { reason: 'done', post: last };
    return null;
  }

  stats() {
    return summarize(this.posts);
  }

  /** プロトコル違反がないか検査する */
  validate() {
    return validateBoard(readFileSync(this.path, 'utf8'));
  }
}

function truncate(s, n) {
  const str = String(s);
  return str.length <= n ? str : `${str.slice(0, n)}…（${str.length - n} 文字省略）`;
}
