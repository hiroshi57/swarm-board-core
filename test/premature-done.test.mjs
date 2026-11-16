import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwarmRunner, mockAdapter } from '../src/index.mjs';
import { DEMO_SCRIPT } from '../src/demo-script.mjs';

const fence = (o) => '```post\n' + JSON.stringify(o) + '\n```';
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-pd-'));
  return { board: join(dir, 'board.jsonl'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('合格がひとつも無いのに coordinator が done を出しても終了しない', async () => {
  const t = tmp();
  try {
    const blocked = [];
    const r = new SwarmRunner({
      mission: 'm',
      adapter: mockAdapter({
        script: { '@coordinator': [fence({ type: 'done', to: [], subject: 'ミッション開始' })] },
      }),
      boardPath: t.board, workers: 1, maxRounds: 3,
    });
    r.on('blocked-post', (e) => blocked.push(e));
    const result = await r.run();

    assert.ok(blocked.some((b) => /pass がひとつも無い/.test(b.why)));
    assert.notEqual(result.reason, 'done', '偽の完了で成功扱いにしない');
    assert.ok(r.board.posts.every((p) => !(p.type === 'done' && p.from === '@coordinator')), '偽の done はボードに残らない');
    assert.ok(r.board.validate().ok);
  } finally { t.cleanup(); }
});

test('verifier の pass があれば coordinator の done は通る', async () => {
  const t = tmp();
  try {
    const r = new SwarmRunner({
      mission: 'アクセスログ集計ツールを作る',
      adapter: mockAdapter({ script: DEMO_SCRIPT }),
      boardPath: t.board, workers: 2, verifiers: 1,
    });
    const result = await r.run();
    assert.equal(result.reason, 'done');
    assert.ok(result.stats.verdicts.pass >= 1);
  } finally { t.cleanup(); }
});

test('宛先つきの done は終了判定に使われないので制限もしない', async () => {
  const t = tmp();
  try {
    const blocked = [];
    const r = new SwarmRunner({
      mission: 'm',
      adapter: mockAdapter({ script: { '@coordinator': [fence({ type: 'done', to: ['@human'], subject: '報告' })] } }),
      boardPath: t.board, workers: 1, maxRounds: 2,
    });
    r.on('blocked-post', (e) => blocked.push(e));
    await r.run();
    assert.equal(blocked.length, 0);
  } finally { t.cleanup(); }
});
