import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBoard } from 'swarm-board-protocol';
import { Board, SwarmRunner, buildRoster, mapWithLimit, extractPosts, mockAdapter } from '../src/index.mjs';
import { DEMO_SCRIPT, inboxOf } from '../src/demo-script.mjs';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-'));
  return { dir, board: join(dir, 'board.jsonl'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const fence = (o) => '```post\n' + JSON.stringify(o) + '\n```';

// ---------- extractPosts ----------

test('extractPosts: ```post フェンスを拾う', () => {
  const { posts } = extractPosts('考えました。\n' + fence({ to: ['@verifier'], type: 'done', subject: 'できた' }));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].type, 'done');
  assert.deepEqual(posts[0].to, ['@verifier']);
});

test('extractPosts: 1 応答に複数の投稿を置ける', () => {
  const text = fence({ type: 'assign', task_id: 'T1', to: ['@worker-1'], subject: 'a' })
    + '\nそして\n'
    + fence({ type: 'assign', task_id: 'T2', to: ['@worker-2'], subject: 'b' });
  assert.equal(extractPosts(text).posts.length, 2);
});

test('extractPosts: ```json フェンスと素の JSON も拾う', () => {
  assert.equal(extractPosts('```json\n{"type":"note","subject":"a"}\n```').posts.length, 1);
  assert.equal(extractPosts('{"type":"note","subject":"裸"}').posts.length, 1);
});

test('extractPosts: 配列でまとめても拾う', () => {
  const text = '```post\n' + JSON.stringify([{ type: 'note', subject: 'a' }, { type: 'note', subject: 'b' }]) + '\n```';
  assert.equal(extractPosts(text).posts.length, 2);
});

test('extractPosts: 本文に { } が入っていても壊れない', () => {
  const { posts } = extractPosts(fence({ type: 'note', subject: 'コード', body: 'if (a) { b({x:1}) } // "}" も含む' }));
  assert.equal(posts.length, 1);
  assert.ok(posts[0].body.includes('{x:1}'));
});

test('extractPosts: 不正な投稿は捨てずに rejected で返す', () => {
  const r = extractPosts(fence({ type: 'gossip', subject: '噂話' }));
  assert.equal(r.posts.length, 0);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /type/);
});

test('extractPosts: subject が空の投稿は通さない', () => {
  assert.equal(extractPosts(fence({ type: 'note', subject: '   ' })).posts.length, 0);
});

test('extractPosts: verify_result は verdict がないと通さない', () => {
  assert.equal(extractPosts(fence({ type: 'verify_result', subject: 'ok', ref: 'p_0001' })).posts.length, 0);
  assert.equal(extractPosts(fence({ type: 'verify_result', subject: 'ok', ref: 'p_0001', verdict: 'pass' })).posts.length, 1);
});

test('extractPosts: 宛先の @ 抜けを補い、同一応答内の重複を畳む', () => {
  const { posts } = extractPosts(fence({ type: 'note', to: ['verifier'], subject: 'x' }) + fence({ type: 'note', to: ['@verifier'], subject: 'x' }));
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].to, ['@verifier']);
});

test('extractPosts: 何も無ければ空', () => {
  assert.deepEqual(extractPosts('特にありません').posts, []);
  assert.deepEqual(extractPosts('').posts, []);
});

// ---------- Board ----------

test('Board: 追記すると seq / id / ts が自動で付く', () => {
  const t = tmp();
  try {
    const b = new Board(t.board);
    const p = b.append({ from: '@human', to: [], type: 'note', subject: 'はじめ' });
    assert.equal(p.seq, 1);
    assert.equal(p.id, 'p_0001');
    assert.equal(b.length, 1);
    assert.ok(validateBoard(readFileSync(t.board, 'utf8')).ok);
  } finally { t.cleanup(); }
});

test('Board: broadcast は自分以外の全員の受信箱に入る', () => {
  const t = tmp();
  try {
    const b = new Board(t.board);
    b.append({ from: '@human', to: [], type: 'note', subject: '全員へ' });
    b.append({ from: '@coordinator', to: ['@worker-1'], type: 'assign', task_id: 'T1', subject: '個別' });
    assert.equal(b.inbox('@worker-1').length, 2);
    assert.equal(b.inbox('@worker-2').length, 1);
    assert.equal(b.inbox('@human').length, 0, '自分の投稿も、他人宛の個別投稿も未読に入らない');
    assert.equal(b.inbox('@worker-1', 1).length, 1, 'カーソルより後だけ返る');
  } finally { t.cleanup(); }
});

test('Board: 同じパスで開き直すと続きから再開できる', () => {
  const t = tmp();
  try {
    const a = new Board(t.board);
    a.append({ from: '@human', to: [], type: 'note', subject: '1' });
    a.append({ from: '@coordinator', to: [], type: 'note', subject: '2' });
    const b = new Board(t.board);
    assert.equal(b.length, 2);
    assert.equal(b.nextSeq, 3);
    b.append({ from: '@human', to: [], type: 'note', subject: '3' });
    assert.ok(b.validate().ok);
  } finally { t.cleanup(); }
});

test('Board: 壊れたボードを開こうとすると理由つきで落ちる', () => {
  const t = tmp();
  try {
    const b = new Board(t.board);
    b.append({ from: '@human', to: [], type: 'note', subject: '1' });
    appendFileSync(t.board, '{こわれた\n');
    assert.throws(() => new Board(t.board), /壊れています/);
  } finally { t.cleanup(); }
});

test('Board: terminalState は coordinator の全員宛 done だけを終了とみなす', () => {
  const t = tmp();
  try {
    const b = new Board(t.board);
    b.append({ from: '@human', to: [], type: 'note', subject: 'start' });
    b.append({ from: '@worker-1', to: ['@verifier'], type: 'done', subject: 'worker の done' });
    assert.equal(b.terminalState(), null, 'worker の done では終わらない');
    b.append({ from: '@coordinator', to: ['@human'], type: 'done', subject: '宛先つき done' });
    assert.equal(b.terminalState(), null, '全員宛でない done では終わらない');
    b.append({ from: '@coordinator', to: [], type: 'done', subject: '完了' });
    assert.equal(b.terminalState().reason, 'done');
  } finally { t.cleanup(); }
});

test('Board: abort は done より優先される', () => {
  const t = tmp();
  try {
    const b = new Board(t.board);
    b.append({ from: '@human', to: [], type: 'abort', subject: 'やめ' });
    b.append({ from: '@coordinator', to: [], type: 'done', subject: '完了' });
    assert.equal(b.terminalState().reason, 'abort');
  } finally { t.cleanup(); }
});

test('Board: render は長い body を省略する', () => {
  const t = tmp();
  try {
    const b = new Board(t.board);
    b.append({ from: '@human', to: [], type: 'note', subject: 's', body: 'あ'.repeat(2000) });
    const text = b.render(10, { maxBody: 100 });
    assert.ok(text.includes('文字省略'));
    assert.ok(text.length < 400);
  } finally { t.cleanup(); }
});

// ---------- roster / 並行制御 ----------

test('buildRoster: verifier が 1 体なら @verifier、複数なら連番', () => {
  assert.deepEqual(buildRoster(2, 1).map((a) => a.name), ['@coordinator', '@worker-1', '@worker-2', '@verifier']);
  assert.deepEqual(buildRoster(1, 2).map((a) => a.name), ['@coordinator', '@worker-1', '@verifier-1', '@verifier-2']);
});

test('mapWithLimit: 同時実行数を超えない', async () => {
  let running = 0, peak = 0;
  const out = await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14], '結果は入力順に揃う');
  assert.ok(peak <= 3, `同時実行は 3 以下のはずが ${peak}`);
});

// ---------- SwarmRunner ----------

test('SwarmRunner: mock 台本で記事どおりの流れが最後まで通る', async () => {
  const t = tmp();
  try {
    const r = new SwarmRunner({
      mission: 'アクセスログ集計ツールを作る',
      adapter: mockAdapter({ script: DEMO_SCRIPT }),
      boardPath: t.board,
      workers: 2,
      verifiers: 1,
    });
    const result = await r.run();

    assert.equal(result.reason, 'done');
    assert.equal(result.valid, true, JSON.stringify(result.violations));
    assert.deepEqual(result.violations, []);

    const s = result.stats;
    assert.equal(s.byType.assign, 3, 'coordinator が 3 件割り当てる');
    assert.equal(s.verdicts.needs_changes, 1, '1 件は差し戻される');
    assert.equal(s.verdicts.pass, 2);
    // 記事と同じ「worker → verifier」の受け渡しが立っている
    assert.ok(s.edges.some((e) => e.from === '@worker-1' && e.to === '@verifier'));
    assert.ok(s.edges.some((e) => e.from === '@worker-2' && e.to === '@verifier'));
  } finally { t.cleanup(); }
});

test('SwarmRunner: 同じ入力なら同じボードになる（再現性）', async () => {
  const run = async () => {
    const t = tmp();
    try {
      const r = new SwarmRunner({
        mission: '同じミッション', adapter: mockAdapter({ script: DEMO_SCRIPT }), boardPath: t.board, workers: 2,
      });
      await r.run();
      return r.board.posts.map((p) => `${p.from}|${p.type}|${p.subject}`).join('\n');
    } finally { t.cleanup(); }
  };
  assert.equal(await run(), await run());
});

test('SwarmRunner: worker が assign を出そうとしても掲示板に載らない', async () => {
  const t = tmp();
  try {
    const blocked = [];
    const r = new SwarmRunner({
      mission: 'm',
      adapter: mockAdapter({ script: { '@worker-1': [fence({ type: 'assign', task_id: 'X', to: ['@worker-2'], subject: '勝手に割当' })] } }),
      boardPath: t.board, workers: 2, maxRounds: 3,
    });
    r.on('blocked-post', (e) => blocked.push(e));
    const result = await r.run();
    assert.equal(blocked.length, 1);
    assert.match(blocked[0].why, /assign/);
    assert.equal(result.stats.byType.assign, undefined, 'assign は 1 件も載っていない');
    assert.ok(result.valid, '却下したので最終的なボードはプロトコルを満たす');
  } finally { t.cleanup(); }
});

test('SwarmRunner: 自分の投稿を自分で検証しようとしても載らない', async () => {
  const t = tmp();
  try {
    const blocked = [];
    const r = new SwarmRunner({
      mission: 'm',
      adapter: mockAdapter({
        script: {
          // 1 ターンのうちに自作自演する: p_0002 を自分で投稿し、それを自分で合格にする
          '@verifier': [
            fence({ type: 'progress', to: [], subject: '自分でやってみた' })
            + fence({ type: 'verify_result', to: [], ref: 'p_0002', verdict: 'pass', subject: '自分で合格' }),
          ],
        },
      }),
      boardPath: t.board, workers: 1, maxRounds: 3,
    });
    r.on('blocked-post', (e) => blocked.push(e));
    await r.run();
    assert.ok(blocked.some((b) => /自分で検証/.test(b.why)));
  } finally { t.cleanup(); }
});

test('SwarmRunner: 掲示板に秘密を書こうとした投稿は却下される', async () => {
  const t = tmp();
  try {
    const leaked = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const blocked = [];
    const r = new SwarmRunner({
      mission: 'm',
      adapter: mockAdapter({ script: { '@worker-1': [fence({ type: 'progress', to: [], subject: '接続した', body: `key=${leaked}` })] } }),
      boardPath: t.board, workers: 1, maxRounds: 3,
    });
    r.on('blocked-post', (e) => blocked.push(e));
    await r.run();
    assert.equal(blocked.length, 1);
    assert.match(blocked[0].why, /秘密情報/);
    assert.ok(!readFileSync(t.board, 'utf8').includes(leaked), '秘密はボードに 1 文字も残らない');
  } finally { t.cleanup(); }
});

test('SwarmRunner: worker の done に verifier 宛が無ければ補われる', async () => {
  const t = tmp();
  try {
    const r = new SwarmRunner({
      mission: 'm',
      adapter: mockAdapter({ script: { '@worker-1': fence({ type: 'done', to: ['@coordinator'], subject: 'できた' }) } }),
      boardPath: t.board, workers: 1, maxRounds: 2,
    });
    await r.run();
    const done = r.board.posts.find((p) => p.type === 'done' && p.from === '@worker-1');
    assert.ok(done.to.includes('@verifier'));
    assert.ok(r.board.validate().ok);
  } finally { t.cleanup(); }
});

test('SwarmRunner: 予算を超えると abort を書いて止まる', async () => {
  const t = tmp();
  try {
    const costly = async () => ({
      text: fence({ type: 'progress', to: [], subject: '作業中' }),
      cost: { model: 'x', input_tokens: 1000, output_tokens: 1000, usd: 1.5 },
    });
    const r = new SwarmRunner({ mission: 'm', adapter: costly, boardPath: t.board, workers: 2, budgetUsd: 2, maxRounds: 10 });
    const result = await r.run();
    assert.equal(result.reason, 'budget');
    assert.ok(result.spentUsd > 2);
    assert.equal(r.board.posts.at(-1).type, 'abort');
    assert.ok(r.board.validate().ok);
  } finally { t.cleanup(); }
});

test('SwarmRunner: 誰も発言しなくなれば idle で止まる', async () => {
  const t = tmp();
  try {
    const r = new SwarmRunner({ mission: 'm', adapter: async () => ({ text: '' }), boardPath: t.board, workers: 2, maxRounds: 10 });
    const result = await r.run();
    assert.equal(result.reason, 'idle');
    assert.equal(result.rounds, 2, '1 ラウンド目で全員が沈黙 → 2 ラウンド目に未読なしで停止');
  } finally { t.cleanup(); }
});

test('SwarmRunner: adapter が落ちても群れ全体は止まらない', async () => {
  const t = tmp();
  try {
    const errors = [];
    const adapter = async (_p, ctx) => {
      if (ctx.agent === '@worker-1') throw new Error('CLI が見つかりません');
      return { text: fence({ type: 'progress', to: [], subject: `${ctx.agent} は動いている` }) };
    };
    const r = new SwarmRunner({ mission: 'm', adapter, boardPath: t.board, workers: 2, maxRounds: 2 });
    r.on('agent-error', (e) => errors.push(e));
    const result = await r.run();
    assert.ok(errors.length > 0);
    assert.ok(result.posts > 1, '他のエージェントの投稿は残る');
  } finally { t.cleanup(); }
});

test('SwarmRunner: 検証役ゼロの群れは作れない', () => {
  const t = tmp();
  try {
    assert.throws(() => new SwarmRunner({ mission: 'm', adapter: async () => ({ text: '' }), boardPath: t.board, verifiers: 0 }), RangeError);
    assert.throws(() => new SwarmRunner({ mission: 'm', adapter: async () => ({ text: '' }), boardPath: t.board, workers: 0 }), RangeError);
    assert.throws(() => new SwarmRunner({ adapter: async () => ({ text: '' }), boardPath: t.board }), TypeError);
    assert.throws(() => new SwarmRunner({ mission: 'm', adapter: 'claude', boardPath: t.board }), TypeError);
  } finally { t.cleanup(); }
});

test('SwarmRunner: 中断すると abort が記録される', async () => {
  const t = tmp();
  try {
    const r = new SwarmRunner({
      mission: 'm',
      adapter: async () => { r.abort(); return { text: fence({ type: 'progress', to: [], subject: '途中' }) }; },
      boardPath: t.board, workers: 1, maxRounds: 10,
    });
    const result = await r.run();
    assert.equal(result.reason, 'aborted');
    assert.equal(r.board.posts.at(-1).type, 'abort');
  } finally { t.cleanup(); }
});

test('SwarmRunner: 途中のボードから再開できる', async () => {
  const t = tmp();
  try {
    const opts = { mission: 'アクセスログ集計ツールを作る', boardPath: t.board, workers: 2 };
    const first = new SwarmRunner({ ...opts, adapter: mockAdapter({ script: DEMO_SCRIPT }), maxRounds: 2 });
    const a = await first.run();
    assert.equal(a.reason, 'max_rounds');

    const second = new SwarmRunner({ ...opts, adapter: mockAdapter({ script: DEMO_SCRIPT }), maxRounds: 10 });
    assert.ok(second.board.length === a.posts, '既存のボードを引き継いでいる');
    const b = await second.run();
    assert.equal(b.reason, 'done');
    assert.ok(b.posts > a.posts);
    assert.ok(b.valid);
  } finally { t.cleanup(); }
});

test('inboxOf はプロンプトから未読節だけを取り出す', () => {
  const prompt = '# 掲示板（直近）\n\nボード本文\n\n# あなた宛の未読\n\n[p_0002] @coordinator (assign): やって\n\n# いま\n\nラウンド 1';
  assert.match(inboxOf(prompt), /p_0002/);
  assert.ok(!inboxOf(prompt).includes('ボード本文'));
});
