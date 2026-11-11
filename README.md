# swarm-board-core

**coordinator / worker / verifier を掲示板越しに走らせるマルチエージェント・ランナー。**

人間の入力は 1 回。あとは coordinator が仕事を分解して worker に配り、
worker は成果を verifier に渡し、verifier が合否を返す。
やりとりはすべて追記専用の `board.jsonl` に残る。

バックエンドは差し替え式で、Claude Code / Codex / Gemini CLI / Antigravity のどれでも動く。
LLM を呼ばない `mock` も同梱しているので、CI で挙動を決定論的に検証できる。

プロトコルは [swarm-board-protocol](https://github.com/hiroshi57/swarm-board-protocol) に分離してある。

## 動かす

LLM なしのデモ（30 秒、課金ゼロ）:

```bash
npm install && npm run demo
```

```
── ラウンド 1/12 ──
  @coordinator 起動（未読 1）
  @worker-1 起動（未読 1）
  @worker-2 起動（未読 1）
  @verifier 起動（未読 1）
  p_0002 @coordinator → @worker-1 [assign] 集計ロジックの実装
  p_0003 @coordinator → @worker-2 [assign] ログパーサとテストデータ
  p_0004 @coordinator → @verifier [assign] 受入基準の検証

── ラウンド 2/12 ──
  p_0005 @worker-1 → @verifier [done] 7 集計を実装し、ユニットテスト 12 件が通過した
  p_0006 @worker-2 → @verifier [done] パーサとサンプルログ 500 行を用意した

── ラウンド 3/12 ──
  p_0007 @verifier → @worker-1,@coordinator [verify_result/needs_changes] 時間帯別集計がタイムゾーンを無視している
  p_0008 @verifier → @worker-2,@coordinator [verify_result/pass] パーサとサンプルログは基準を満たす

── ラウンド 4/12 ──
  p_0009 @worker-1 → @verifier [done] タイムゾーンを修正し、回帰テストを追加した

── ラウンド 5/12 ──
  p_0010 @verifier → @coordinator [verify_result/pass] 修正を確認、全基準を満たす

── ラウンド 6/12 ──
  p_0011 @coordinator → 全員 [done] ミッション完了

終了: done / 6 ラウンド / 11 投稿 / $0
```

本物のモデルで動かす:

```bash
node src/cli.mjs run \
  --mission "nginx のアクセスログから攻撃を検知する集計ツールを作る" \
  --adapter claude --workers 4 --verifiers 2 \
  --budget 5.00 --cwd ../my-project
```

終わったボードを読む:

```bash
node src/cli.mjs show   runs/<id>/board.jsonl   # 誰が誰に何回渡したか + プロトコル検証
node src/cli.mjs replay runs/<id>/board.jsonl   # 全発言を時系列で
```

## 1 ラウンドで起きること

```
掲示板を読む → 未読のあるエージェントだけを並行起動 → 各自の出力から投稿を抽出
      ↑                                                          ↓
      └──────────────── 権限と秘密をチェックして追記 ←───────────┘
```

- **未読のある者しか動かない。** 全員を毎回起動すると台数に比例して課金が増えるだけで、
  言うことがない者は言うことがない
- **並行に動かすが、追記順は roster 順に固定する。** 同じ台本なら同じボードになる（テストで担保）
- **未読は読ませた時点で消費する。** 失敗しても同じ文脈を無限に再送しない

## 掲示板に載る前のチェック

ランナーは、エージェントの出力をそのまま信じない。

| 検査 | 挙動 |
|------|------|
| worker が `assign` / `abort` を出した | **却下**し、理由を `note` として掲示板に残す |
| verifier 以外が `verify_result` を出した | **却下** |
| 自分の投稿を自分で検証した | **却下** |
| `done` に verifier 宛が無い | 宛先を**補う**（却下はしない） |
| 本文に API キー等が混ざった | **却下**。秘密は 1 文字もボードに書かれない |
| 存在しない `ref` | `ref` だけ落として投稿は通す |

却下したものを黙って捨てると原因が追えなくなるので、必ず掲示板に記録が残る。

## 止まる条件

| reason | いつ |
|--------|------|
| `done` | coordinator が**全員宛**の `done` を出した（＝全タスクが `pass`） |
| `abort` | coordinator か human が中断した |
| `budget` | `--budget` を超えた。abort を書いてから止まる |
| `idle` | 誰にも未読が無くなった（＝全員が黙った） |
| `max_rounds` | ラウンド上限 |

## ライブラリとして使う

```js
import { SwarmRunner, createAdapter } from 'swarm-board-core';

const runner = new SwarmRunner({
  mission: '2万ページの title / description を LLMO 観点で書き直す',
  adapter: createAdapter('claude'),
  boardPath: 'runs/llmo/board.jsonl',
  workers: 8,
  verifiers: 2,
  budgetUsd: 40,
  modelFor: (role) => (role === 'worker' ? 'claude-sonnet-5' : 'claude-opus-5'),
});

runner.on('post', (p) => console.log(p.id, p.from, p.subject));
const result = await runner.run();  // { reason, rounds, posts, stats, spentUsd, valid }
```

`modelFor` で役割ごとにモデルを変えられる。記事の `/swarm` が worker に Argon、
coordinator と verifier に Carbon を割り当てていたのと同じ考え方で、
**手を動かす役は安いモデル、判断と検証は高いモデル**にするとコストが大きく下がる。

## adapter を足す

```js
const myAdapter = async (prompt, ctx) => {
  const res = await myLLM(prompt, { model: ctx.model });
  return { text: res.text, cost: { model: ctx.model, input_tokens: res.in, output_tokens: res.out, usd: res.usd } };
};
```

`{text, cost}` を返す関数であれば何でもよい。

## 開発

```bash
npm test   # 32 件
```

## 関連リポジトリ

| リポジトリ | 役割 |
|-----------|------|
| [swarm-board-protocol](https://github.com/hiroshi57/swarm-board-protocol) | 掲示板の仕様と検証器 |
| `swarm-board-core` | **（これ）** ランナー |
| [swarm-board-viewer](https://github.com/hiroshi57/swarm-board-viewer) | 掲示板と関係グラフの 1 ファイル HTML ビューア |
| [swarm-cost-governor](https://github.com/hiroshi57/swarm-cost-governor) | 台数 × トークンの予算ガード |
| [swarm-usecase-100](https://github.com/hiroshi57/swarm-usecase-100) | 100 ユースケースと実現可能性の評価 |

## ライセンス

MIT
