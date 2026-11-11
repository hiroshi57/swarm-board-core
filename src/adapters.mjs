import { spawn } from 'node:child_process';

/**
 * エージェントのバックエンド。
 *
 * 1 つの adapter は「プロンプトを渡すとテキストとコストが返る」関数でしかない。
 * ここを差し替えるだけで Claude Code / Codex / Gemini CLI / 自前 API を切り替えられる。
 *
 * @typedef {(prompt: string, ctx: {agent: string, role: string, model?: string, cwd?: string, signal?: AbortSignal}) => Promise<{text: string, cost?: object}>} Adapter
 */

/** CLI を 1 回叩く汎用 adapter を作る */
export function cliAdapter({ command, args = [], stdinPrompt = true, parseCost, timeoutMs = 10 * 60 * 1000 }) {
  return async function run(prompt, ctx = {}) {
    const argv = args.map((a) => a.replaceAll('{prompt}', prompt).replaceAll('{model}', ctx.model ?? ''));
    const { stdout, stderr, code } = await exec(command, argv, {
      input: stdinPrompt ? prompt : undefined,
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal,
    });
    if (code !== 0) throw new Error(`${command} が終了コード ${code} で失敗しました: ${stderr.slice(0, 500)}`);
    return { text: stdout, cost: parseCost ? parseCost(stdout, stderr) : undefined };
  };
}

export const ADAPTERS = {
  /** Claude Code CLI（非対話） */
  claude: () => cliAdapter({
    command: 'claude',
    args: ['-p', '--output-format', 'text'],
    stdinPrompt: true,
  }),

  /** OpenAI Codex CLI */
  codex: () => cliAdapter({
    command: 'codex',
    args: ['exec', '--full-auto', '-'],
    stdinPrompt: true,
  }),

  /** Gemini CLI */
  gemini: () => cliAdapter({
    command: 'gemini',
    args: ['-p', '-'],
    stdinPrompt: true,
  }),

  /** Google Antigravity CLI */
  antigravity: () => cliAdapter({
    command: 'antigravity',
    args: ['run', '--headless', '-'],
    stdinPrompt: true,
  }),

  /**
   * ローカルの ollama。課金ゼロ・認証不要で群れを実際に走らせられる。
   * モデルは小さいのでプロトコル遵守率は落ちるが、
   * 「掲示板が成立するか」を実物で確かめるには十分で、何より無料。
   */
  ollama: (opts = {}) => ollamaAdapter(opts),

  /**
   * テストとデモ用。LLM を呼ばず、台本どおりに返す。
   * CI でランナーの挙動を決定論的に検証するために必要。
   */
  mock: (opts = {}) => mockAdapter(opts),
};

/** 名前から adapter を作る */
export function createAdapter(name, opts = {}) {
  const factory = ADAPTERS[name];
  if (!factory) throw new Error(`未知の adapter '${name}'（利用可能: ${Object.keys(ADAPTERS).join(', ')}）`);
  return factory(opts);
}

/**
 * ローカルの ollama HTTP API を叩く。
 *
 * 実行は手元で完結するので、課金も認証もなしに群れを動かせる。
 * 役割ごとにモデルを変えられる（modelFor が渡す ctx.model を優先する）。
 *
 * @param {object} o
 * @param {string} [o.host] 既定 http://127.0.0.1:11434
 * @param {string} [o.model] 既定 qwen2.5:7b-instruct
 * @param {number} [o.numPredict] 出力トークン上限
 * @param {number} [o.temperature]
 * @param {number} [o.seed] 固定すると再現性が上がる
 */
export function ollamaAdapter({
  host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  model = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct',
  numPredict = Number(process.env.OLLAMA_NUM_PREDICT || 700),
  temperature = 0.3,
  seed = 42,
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  return async function run(prompt, ctx = {}) {
    const useModel = ctx.model ?? model;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    ctx.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    let res;
    try {
      res = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: useModel,
          prompt,
          stream: false,
          options: { num_predict: numPredict, temperature, seed },
        }),
        signal: ac.signal,
      });
    } catch (e) {
      throw new Error(`ollama に接続できません（${host}）: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`ollama が ${res.status} を返しました: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return {
      text: String(data.response ?? ''),
      // ローカル実行なので金額は 0。トークン数は記録しておく
      cost: {
        model: useModel,
        input_tokens: Number(data.prompt_eval_count) || 0,
        output_tokens: Number(data.eval_count) || 0,
        usd: 0,
      },
    };
  };
}

/**
 * 台本つきモック。
 * script[agent] が配列なら呼ばれるたびに先頭から消費し、尽きたら fallback を返す。
 */
export function mockAdapter({ script = {}, fallback = '' , latencyMs = 0 } = {}) {
  const cursor = new Map();
  return async function run(prompt, ctx = {}) {
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    const agent = ctx.agent ?? '@unknown';
    const lines = script[agent];
    let text;
    if (typeof lines === 'function') {
      text = lines(prompt, ctx);
    } else if (Array.isArray(lines)) {
      const i = cursor.get(agent) ?? 0;
      text = i < lines.length ? lines[i] : fallback;
      cursor.set(agent, i + 1);
    } else {
      text = lines ?? fallback;
    }
    return {
      text: String(text ?? ''),
      cost: { model: 'mock', input_tokens: Math.ceil(prompt.length / 4), output_tokens: Math.ceil(String(text ?? '').length / 4), usd: 0 },
    };
  };
}

/** 子プロセスを 1 回実行する */
export function exec(command, args, { input, cwd, timeoutMs = 600000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, shell: process.platform === 'win32', windowsHide: true });
    } catch (e) {
      reject(new Error(`${command} を起動できません: ${e.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${command} が ${timeoutMs}ms でタイムアウトしました`));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error('中断されました'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`${command} を実行できません: ${e.message}（PATH に入っていますか）`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}
