import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, ollamaAdapter, ADAPTERS } from '../src/index.mjs';

test('ADAPTERS に主要なバックエンドが揃っている', () => {
  for (const k of ['claude', 'codex', 'gemini', 'antigravity', 'ollama', 'mock']) {
    assert.ok(typeof ADAPTERS[k] === 'function', `${k} が無い`);
    assert.ok(typeof createAdapter(k, {}) === 'function', `${k} を作れない`);
  }
});

test('未知の adapter は利用可能な一覧つきで落とす', () => {
  assert.throws(() => createAdapter('そんなものはない'), /利用可能/);
});

test('ollama adapter は接続できないとき、どこに繋ごうとしたかを言う', async () => {
  const a = ollamaAdapter({ host: 'http://127.0.0.1:1', timeoutMs: 2000 });
  await assert.rejects(() => a('ping', { agent: '@worker-1' }), /ollama に接続できません.*127\.0\.0\.1:1/s);
});

test('ollama adapter は HTTP エラーを本文つきで返す', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => { res.writeHead(500); res.end('model not found'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const a = ollamaAdapter({ host: `http://127.0.0.1:${port}` });
    await assert.rejects(() => a('ping', {}), /ollama が 500 を返しました.*model not found/s);
  } finally { server.close(); }
});

test('ollama adapter は応答からトークン数を拾い、金額は 0 にする', async () => {
  const { createServer } = await import('node:http');
  let received = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'こんにちは', prompt_eval_count: 123, eval_count: 45 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const a = ollamaAdapter({ host: `http://127.0.0.1:${port}`, model: 'm1' });
    const out = await a('プロンプト', { agent: '@worker-1', model: 'm2' });
    assert.equal(out.text, 'こんにちは');
    assert.deepEqual(out.cost, { model: 'm2', input_tokens: 123, output_tokens: 45, usd: 0 });
    assert.equal(received.model, 'm2', 'ctx.model（役割別モデル）が優先される');
    assert.equal(received.stream, false);
    assert.equal(received.prompt, 'プロンプト');
  } finally { server.close(); }
});
