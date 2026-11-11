import { EventEmitter } from 'node:events';
import { roleOf, findSecrets } from 'swarm-board-protocol';
import { Board } from './board.mjs';
import { buildPrompt } from './prompts.mjs';
import { extractPosts } from './protocol-io.mjs';

const DEFAULTS = {
  workers: 2,
  verifiers: 1,
  maxRounds: 12,
  concurrency: 4,
  boardWindow: 40,
  budgetUsd: Infinity,
  modelFor: () => undefined,
};

/**
 * 掲示板を軸にした swarm ランナー。
 *
 * 1 ラウンドで「未読のあるエージェントを並行に 1 ターンずつ動かし、
 * その出力から取り出した投稿を掲示板に追記する」。
 * coordinator が全員宛の done を出すか、上限・予算に達すると止まる。
 */
export class SwarmRunner extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.mission
   * @param {Function} o.adapter プロンプト→{text,cost}
   * @param {string} o.boardPath
   */
  constructor(o) {
    super();
    if (!o?.mission || typeof o.mission !== 'string') throw new TypeError('mission は必須です');
    if (typeof o.adapter !== 'function') throw new TypeError('adapter は関数である必要があります');
    if (!o.boardPath) throw new TypeError('boardPath は必須です');

    this.opts = { ...DEFAULTS, ...o };
    if (this.opts.workers < 1) throw new RangeError('workers は 1 以上が必要です');
    if (this.opts.verifiers < 1) throw new RangeError('verifiers は 1 以上が必要です（検証なしの swarm は許可しない）');

    this.board = new Board(o.boardPath);
    this.roster = buildRoster(this.opts.workers, this.opts.verifiers);
    this.cursor = new Map(this.roster.map((a) => [a.name, 0]));
    this.spentUsd = 0;
    this.aborted = false;
  }

  abort() {
    this.aborted = true;
  }

  /** ミッションを最後まで走らせる */
  async run() {
    const { mission, maxRounds } = this.opts;

    if (this.board.length === 0) {
      this.board.append({ from: '@human', to: [], type: 'note', subject: 'ミッション開始', body: mission, meta: { round: 0 } });
      this.emit('post', this.board.posts.at(-1));
    }

    let round = 0;
    let stop = this.board.terminalState();

    while (!stop && round < maxRounds && !this.aborted) {
      round++;
      this.emit('round', { round, maxRounds });

      const active = this.roster.filter((a) => this.board.inbox(a.name, this.cursor.get(a.name)).length > 0);
      if (active.length === 0) {
        stop = { reason: 'idle', post: null };
        break;
      }

      const turns = await mapWithLimit(active, this.opts.concurrency, (a) => this.#turn(a, round));

      // 追記の順序は roster 順に固定する。並行実行でもボードは再現可能になる
      for (const t of turns) {
        if (t.error) {
          this.emit('agent-error', t);
          continue;
        }
        for (const fields of t.posts) {
          const post = this.#appendChecked(t.agent, fields, t.cost, round);
          if (post) this.emit('post', post);
        }
      }

      if (this.spentUsd > this.opts.budgetUsd) {
        this.board.append({
          from: '@human', to: [], type: 'abort',
          subject: '予算上限に達したため中断',
          body: `上限 $${this.opts.budgetUsd} に対して $${this.spentUsd.toFixed(4)} を消費しました。`,
          meta: { round },
        });
        stop = { reason: 'budget', post: this.board.posts.at(-1) };
        break;
      }

      stop = this.board.terminalState();
    }

    if (!stop && this.aborted) {
      this.board.append({ from: '@human', to: [], type: 'abort', subject: '外部から中断されました' });
      stop = { reason: 'aborted', post: this.board.posts.at(-1) };
    }
    if (!stop) stop = { reason: 'max_rounds', post: null };

    const validation = this.board.validate();
    const result = {
      reason: stop.reason,
      rounds: round,
      posts: this.board.length,
      stats: this.board.stats(),
      spentUsd: Number(this.spentUsd.toFixed(4)),
      boardPath: this.board.path,
      valid: validation.ok,
      violations: validation.errors,
    };
    this.emit('end', result);
    return result;
  }

  /** エージェント 1 体の 1 ターン */
  async #turn(agentSpec, round) {
    const { name, role } = agentSpec;
    const sinceSeq = this.cursor.get(name);
    const inbox = this.board.inbox(name, sinceSeq);
    const prompt = buildPrompt({
      agent: name,
      role,
      mission: this.opts.mission,
      roster: this.roster.map((a) => `- ${a.name} (${a.role})`),
      boardText: this.board.render(this.opts.boardWindow),
      inboxText: inbox.map((p) => {
        const tags = [p.type, p.task_id, p.verdict, p.ref ? `ref=${p.ref}` : null].filter(Boolean).join(' / ');
        return `[${p.id}] ${p.from} (${tags}): ${p.subject}${p.body ? `\n${p.body}` : ''}`;
      }).join('\n---\n'),
      round,
      maxRounds: this.opts.maxRounds,
      extra: this.opts.extra,
    });

    // 未読は、読ませた時点で消費する（失敗しても同じ文脈を無限に再送しない）
    this.cursor.set(name, this.board.nextSeq - 1);

    this.emit('turn', { agent: name, role, round, inbox: inbox.length });
    try {
      const { text, cost } = await this.opts.adapter(prompt, { agent: name, role, model: this.opts.modelFor(role), cwd: this.opts.cwd });
      const { posts, rejected } = extractPosts(text);
      for (const r of rejected) this.emit('rejected', { agent: name, ...r });
      return { agent: name, role, posts, cost, raw: text };
    } catch (e) {
      return { agent: name, role, posts: [], error: e.message };
    }
  }

  /**
   * 投稿を掲示板に載せる前に、役割の権限と秘密混入を検査する。
   * 違反は捨てずに note として記録する（黙って消すと原因が追えなくなる）。
   */
  #appendChecked(agent, fields, cost, round) {
    const role = roleOf(agent);
    const reject = (why) => {
      this.emit('blocked-post', { agent, why, fields });
      this.board.append({
        from: '@human', to: [agent], type: 'note',
        subject: `投稿を却下: ${why}`,
        body: `${agent} の ${fields.type} を掲示板に載せませんでした。理由: ${why}`,
        ...(round ? { meta: { round } } : {}),
      });
      return null;
    };

    if ((fields.type === 'assign' || fields.type === 'abort') && !['coordinator', 'human'].includes(role)) {
      return reject(`${role} は '${fields.type}' を出せません`);
    }
    if (fields.type === 'verify_result' && role !== 'verifier') {
      return reject('verifier 以外は合否を出せません');
    }
    if (fields.type === 'verify_result' && fields.ref) {
      const target = this.board.posts.find((p) => p.id === fields.ref);
      if (target && target.from === agent) return reject('自分の投稿を自分で検証しています');
    }
    if (fields.type === 'done' && role === 'worker') {
      const to = fields.to?.length ? fields.to : [];
      if (!to.some((x) => roleOf(x) === 'verifier')) {
        const v = this.roster.find((a) => a.role === 'verifier');
        fields = { ...fields, to: [...to, v.name] }; // 宛先漏れは却下せず補う
      }
    }
    for (const field of ['subject', 'body']) {
      const hits = findSecrets(fields[field]);
      if (hits.length > 0) return reject(`${field} に秘密情報（${hits[0].label}）が含まれています`);
    }
    if (fields.ref && !this.board.posts.some((p) => p.id === fields.ref)) {
      delete fields.ref; // 存在しない参照は落とす。投稿自体は通す
    }

    const totalCost = cost ? { ...cost } : undefined;
    if (totalCost?.usd) this.spentUsd += Number(totalCost.usd) || 0;
    // ラウンドを投稿に残す。あとからビューアや分析器が並行度を正確に復元できる
    const meta = { ...(fields.meta ?? {}), ...(round ? { round } : {}) };
    return this.board.append({
      ...fields,
      from: agent,
      ...(Object.keys(meta).length ? { meta } : {}),
      ...(totalCost ? { cost: totalCost } : {}),
    });
  }
}

export function buildRoster(workers, verifiers) {
  const roster = [{ name: '@coordinator', role: 'coordinator' }];
  for (let i = 1; i <= workers; i++) roster.push({ name: `@worker-${i}`, role: 'worker' });
  if (verifiers === 1) roster.push({ name: '@verifier', role: 'verifier' });
  else for (let i = 1; i <= verifiers; i++) roster.push({ name: `@verifier-${i}`, role: 'verifier' });
  return roster;
}

/** 同時実行数を絞って map する */
export async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}
