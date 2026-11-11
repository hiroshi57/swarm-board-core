/**
 * mock adapter 用の台本。LLM を一切呼ばずに、記事と同じ協調パターンを再現する。
 *
 * - coordinator が分解して 2 体の worker と 1 体の verifier に割り当てる
 * - worker は done を verifier に渡す
 * - verifier が 1 件を needs_changes で差し戻す
 * - 修正が pass したら coordinator が全員宛の done を出して終了
 *
 * CI で「ランナーがプロトコルを守ったボードを作れるか」を決定論的に確かめるために使う。
 */

const post = (o) => '```post\n' + JSON.stringify(o) + '\n```';

/** プロンプトから「あなた宛の未読」節だけを取り出す */
export function inboxOf(prompt) {
  const m = /# あなた宛の未読\n\n([\s\S]*?)(?:\n\n# |$)/.exec(prompt);
  return m ? m[1] : '';
}

/** プロンプトから「掲示板（直近）」節だけを取り出す */
export function boardOf(prompt) {
  const m = /# 掲示板（直近）\n\n([\s\S]*?)(?:\n\n# あなた宛|$)/.exec(prompt);
  return m ? m[1] : '';
}

/** 未読のうち、条件に合う最初の投稿 id を返す */
function refFor(inbox, needle) {
  for (const chunk of inbox.split('\n---\n')) {
    if (chunk.includes(needle)) {
      const m = /\[(p_\d+)\]/.exec(chunk);
      if (m) return m[1];
    }
  }
  return null;
}

export const DEMO_SCRIPT = {
  '@coordinator': (prompt) => {
    const board = boardOf(prompt);
    const passes = (board.match(/verify_result[^)]*\/ pass/g) ?? []).length;

    if (!board.includes('assign')) {
      return [
        post({
          to: ['@worker-1'], type: 'assign', task_id: 'T1', ref: 'p_0001',
          subject: '集計ロジックの実装',
          body: '7 種類の集計を実装する。完了の判定基準: ユニットテストが全通過し、タイムゾーンを尊重すること。',
        }),
        post({
          to: ['@worker-2'], type: 'assign', task_id: 'T2', ref: 'p_0001',
          subject: 'ログパーサとテストデータ',
          body: 'combined / common 両形式のパーサと、攻撃を含むサンプルログ 500 行。判定基準: 全行パース成功、誤検知率 5% 未満。',
        }),
        post({
          to: ['@verifier'], type: 'assign', task_id: 'T3', ref: 'p_0001',
          subject: '受入基準の検証',
          body: 'T1 / T2 の done を受けて検証する。主張を鵜呑みにせず、確かめ方まで見ること。',
        }),
      ].join('\n');
    }

    if (passes >= 2) {
      return post({
        to: [], type: 'done',
        subject: 'ミッション完了',
        body: 'T1 / T2 とも verifier の pass を得た。人間の入力は 1 回のみ。',
      });
    }
    return '';
  },

  '@worker-1': (prompt) => {
    const inbox = inboxOf(prompt);
    const fixRef = refFor(inbox, 'needs_changes');
    if (fixRef) {
      return post({
        to: ['@verifier'], type: 'done', task_id: 'T1', ref: fixRef,
        subject: 'タイムゾーンを修正し、回帰テストを追加した',
        body: 'ログのオフセットを尊重するようにした。+09:00 / UTC / -05:00 の 3 ケースで回帰テストを追加し、計 15 件が通過。',
        artifacts: [{ path: 'src/aggregate.mjs', kind: 'file' }],
      });
    }
    const assignRef = refFor(inbox, 'assign');
    if (assignRef) {
      return post({
        to: ['@verifier'], type: 'done', task_id: 'T1', ref: assignRef,
        subject: '7 集計を実装し、ユニットテスト 12 件が通過した',
        body: 'しきい値は設定ファイルに外出しした。確かめ方: 固定データ 200 行に対して期待値を手計算し、12 ケースで突き合わせた。',
        artifacts: [{ path: 'src/aggregate.mjs', kind: 'file' }],
      });
    }
    return '';
  },

  '@worker-2': (prompt) => {
    const inbox = inboxOf(prompt);
    const assignRef = refFor(inbox, 'assign');
    if (assignRef) {
      return post({
        to: ['@verifier'], type: 'done', task_id: 'T2', ref: assignRef,
        subject: 'パーサとサンプルログ 500 行を用意した',
        body: 'combined / common を自動判別。確かめ方: 500 行すべてパースし、既知の攻撃 19 件を手作業でラベル付けして突き合わせた。誤検知率 2.1%。',
        artifacts: [{ path: 'src/parse.mjs', kind: 'file' }, { path: 'test/fixtures/access.log', kind: 'file' }],
      });
    }
    return '';
  },

  '@verifier': (prompt) => {
    const inbox = inboxOf(prompt);
    const out = [];
    for (const chunk of inbox.split('\n---\n')) {
      if (!chunk.includes('(done')) continue;
      const id = /\[(p_\d+)\]/.exec(chunk)?.[1];
      if (!id) continue;
      if (chunk.includes('@worker-2')) {
        out.push(post({
          to: ['@worker-2', '@coordinator'], type: 'verify_result', task_id: 'T3', ref: id, verdict: 'pass',
          subject: 'パーサとサンプルログは基準を満たす',
          body: '根拠: 500 行を再パースして件数一致を確認。誤検知率 2.1% は基準の 5% 未満。',
        }));
      } else if (chunk.includes('タイムゾーンを修正')) {
        out.push(post({
          to: ['@coordinator'], type: 'verify_result', task_id: 'T3', ref: id, verdict: 'pass',
          subject: '修正を確認、全基準を満たす',
          body: '根拠: 3 タイムゾーンそれぞれで深夜帯の総当たりを検知できることを再実行で確認した。',
        }));
      } else {
        out.push(post({
          to: ['@worker-1', '@coordinator'], type: 'verify_result', task_id: 'T3', ref: id, verdict: 'needs_changes',
          subject: '時間帯別集計がタイムゾーンを無視している',
          body: '根拠: ログは +09:00 だが UTC として集計していた。深夜帯の総当たり検知が 9 時間ずれる。他 6 集計は基準を満たす。',
        }));
      }
    }
    return out.join('\n');
  },
};
