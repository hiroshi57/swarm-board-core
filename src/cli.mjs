#!/usr/bin/env node
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SwarmRunner } from './runner.mjs';
import { createAdapter } from './adapters.mjs';
import { Board } from './board.mjs';
import { DEMO_SCRIPT } from './demo-script.mjs';

const HELP = `
swarm — 掲示板で協調するマルチエージェント・ランナー

使い方:
  swarm run    --mission "<やること>" [オプション]
  swarm show   <board.jsonl>
  swarm replay <board.jsonl>

run のオプション:
  --mission <text>    ミッション本文（--mission-file と排他）
  --mission-file <p>  ミッションをファイルから読む
  --adapter <name>    claude | codex | gemini | antigravity | mock  （既定: claude）
  --workers <n>       worker の数                                   （既定: 2）
  --verifiers <n>     verifier の数（0 は不可）                     （既定: 1）
  --max-rounds <n>    ラウンド上限                                  （既定: 12）
  --concurrency <n>   同時に動かす数                                （既定: 4）
  --budget <usd>      コスト上限。超えたら abort を書いて止める     （既定: 無制限）
  --out <dir>         出力先ディレクトリ                            （既定: runs/<時刻>）
  --cwd <dir>         エージェントの作業ディレクトリ
  --resume <board>    既存の board.jsonl の続きから再開
  --quiet             ログを抑える
`.trim();

const argv = process.argv.slice(2);
const cmd = argv[0];

function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const flag = (name) => argv.includes(`--${name}`);
const num = (name, fallback) => {
  const v = opt(name, null);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`--${name} は数値である必要があります: ${v}`);
    process.exit(2);
  }
  return n;
};

if (!cmd || flag('help') || cmd === 'help') {
  console.log(HELP);
  process.exit(cmd ? 0 : 2);
}

if (cmd === 'show' || cmd === 'replay') {
  const file = argv[1];
  if (!file) {
    console.error(`使い方: swarm ${cmd} <board.jsonl>`);
    process.exit(2);
  }
  const board = new Board(file);
  if (cmd === 'show') {
    const s = board.stats();
    console.log(`${board.length} posts / ${s.agents.length} agents / $${s.cost.usd}`);
    console.log('\nエージェント:');
    for (const a of s.agents) console.log(`  ${a.name.padEnd(14)} ${a.role.padEnd(12)} 送信 ${String(a.sent).padStart(3)}  受信 ${String(a.received).padStart(3)}  $${a.usd.toFixed(3)}`);
    console.log('\n受け渡し:');
    for (const e of s.edges.sort((x, y) => y.count - x.count)) console.log(`  ${e.from} → ${e.to}  ×${e.count}`);
    const v = board.validate();
    console.log(`\nプロトコル検証: ${v.ok ? 'PASS' : 'FAIL'}`);
    for (const e of v.errors) console.log(`  ERROR L${e.line} [${e.rule}] ${e.message}`);
  } else {
    for (const p of board.posts) {
      const to = (p.to ?? []).join(', ') || '全員';
      console.log(`\n[${p.id}] ${p.ts}  ${p.from} → ${to}  (${p.type}${p.verdict ? `/${p.verdict}` : ''})`);
      console.log(`  ${p.subject}`);
      if (p.body) console.log(p.body.split('\n').map((l) => `    ${l}`).join('\n'));
    }
  }
  process.exit(0);
}

if (cmd !== 'run') {
  console.error(`未知のコマンド '${cmd}'\n\n${HELP}`);
  process.exit(2);
}

const missionFile = opt('mission-file', null);
const mission = missionFile ? readFileSync(missionFile, 'utf8') : opt('mission', null);
if (!mission) {
  console.error('--mission か --mission-file が必要です');
  process.exit(2);
}

const adapterName = opt('adapter', 'claude');
const outDir = opt('out', join('runs', new Date().toISOString().replace(/[:.]/g, '-')));
mkdirSync(outDir, { recursive: true });
const boardPath = opt('resume', join(outDir, 'board.jsonl'));
const quiet = flag('quiet');

const adapter = createAdapter(adapterName, adapterName === 'mock' ? { script: DEMO_SCRIPT, fallback: '' } : {});

const runner = new SwarmRunner({
  mission,
  adapter,
  boardPath,
  workers: num('workers', 2),
  verifiers: num('verifiers', 1),
  maxRounds: num('max-rounds', 12),
  concurrency: num('concurrency', 4),
  budgetUsd: num('budget', Infinity),
  cwd: opt('cwd', undefined),
});

if (!quiet) {
  runner.on('round', ({ round, maxRounds }) => console.error(`\n── ラウンド ${round}/${maxRounds} ──`));
  runner.on('turn', ({ agent, inbox }) => console.error(`  ${agent} 起動（未読 ${inbox}）`));
  runner.on('post', (p) => console.error(`  ${p.id} ${p.from} → ${(p.to ?? []).join(',') || '全員'} [${p.type}${p.verdict ? `/${p.verdict}` : ''}] ${p.subject}`));
  runner.on('blocked-post', ({ agent, why }) => console.error(`  ! ${agent} の投稿を却下: ${why}`));
  runner.on('agent-error', ({ agent, error }) => console.error(`  × ${agent}: ${error}`));
  runner.on('rejected', ({ agent, reason }) => console.error(`  ? ${agent} の出力を投稿として読めません: ${reason}`));
}

process.on('SIGINT', () => {
  console.error('\n中断します…');
  runner.abort();
});

const result = await runner.run();
console.error(`\n終了: ${result.reason} / ${result.rounds} ラウンド / ${result.posts} 投稿 / $${result.spentUsd}`);
console.error(`掲示板: ${result.boardPath}`);
if (!result.valid) {
  console.error('プロトコル違反:');
  for (const e of result.violations) console.error(`  L${e.line} [${e.rule}] ${e.message}`);
}
console.log(JSON.stringify({ ...result, violations: result.violations.length }, null, 2));
process.exit(result.reason === 'done' && result.valid ? 0 : 1);
