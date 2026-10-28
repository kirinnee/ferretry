/**
 * Fake credentials in each harness's on-disk shape, a PTY screen reader, and a Codex app-server
 * client. Every token is an obvious fake (`FAKE`, `ROTATED<n>`), unsigned, and never leaves loopback.
 */
import { writeFile } from 'node:fs/promises';

const HOUR_MS = 3_600_000;

/** Claude's `.credentials.json` document. `expired` puts `expiresAt` an hour in the past. */
export function claudeCredential(options: { expired: boolean; tag?: string }): string {
  const tag = options.tag ?? 'FAKE';
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat01-${tag}`,
      refreshToken: `sk-ant-ort01-${tag}`,
      expiresAt: Date.now() + (options.expired ? -HOUR_MS : 24 * HOUR_MS),
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  });
}

/** What Claude's token endpoint answers for the n-th refresh. */
export function claudeTokenAnswer(n: number): { body: Record<string, unknown>; refreshToken: string } {
  const refreshToken = `sk-ant-ort01-ROTATED${n}`;
  return {
    refreshToken,
    body: {
      access_token: `sk-ant-oat01-ROTATED${n}`,
      refresh_token: refreshToken,
      expires_in: 28_800,
      scope: 'user:inference user:profile',
      token_type: 'Bearer',
    },
  };
}

export async function readClaudeRefreshToken(file: string): Promise<string | undefined> {
  const document = JSON.parse(await Bun.file(file).text()) as { claudeAiOauth?: { refreshToken?: string } };
  return document.claudeAiOauth?.refreshToken;
}

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An unsigned JWT carrying the claims Codex parses out of an id token. */
function fakeJwt(expiresInSeconds: number, tag: string): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
    exp,
    iat: exp - 3600,
    email: 'contract@example.invalid',
    tag,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'pro',
      chatgpt_account_id: 'acct-fake',
      chatgpt_user_id: 'user-fake',
    },
  })}.unsigned`;
}

/** Codex's `auth.json`. `expired` also ages `last_refresh` past Codex's eight-day horizon. */
export async function writeCodexAuth(file: string, options: { expired: boolean }): Promise<void> {
  const lifetime = options.expired ? -600 : 86_400;
  await writeFile(
    file,
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: fakeJwt(lifetime, 'FAKE'),
        access_token: fakeJwt(lifetime, 'FAKE'),
        refresh_token: 'rt-FAKE',
        account_id: 'acct-fake',
      },
      last_refresh: new Date(Date.now() - (options.expired ? 9 * 24 * HOUR_MS : 0)).toISOString(),
    }),
    { mode: 0o600 },
  );
}

export function codexTokenAnswer(n: number): { body: Record<string, unknown>; refreshToken: string } {
  const refreshToken = `rt-ROTATED${n}`;
  return {
    refreshToken,
    body: {
      id_token: fakeJwt(3600, `ROTATED${n}`),
      access_token: fakeJwt(3600, `ROTATED${n}`),
      refresh_token: refreshToken,
    },
  };
}

export interface CodexAuthDocument {
  readonly tokens: { readonly access_token: string; readonly refresh_token: string };
  readonly last_refresh: string;
}

export async function readCodexAuth(file: string): Promise<CodexAuthDocument> {
  return JSON.parse(await Bun.file(file).text()) as CodexAuthDocument;
}

/** Terminal output with escape sequences dropped and whitespace collapsed, so a screen reads as words. */
function plainScreen(raw: string): string {
  // ESC and BEL become printable markers first, so the patterns below hold no control characters.
  return raw
    .replaceAll(String.fromCharCode(27), '␁')
    .replaceAll(String.fromCharCode(7), '␇')
    .replace(/␁\][^␇␁]*(␇|␁\\)/g, ' ')
    .replace(/␁\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ')
    .replace(/␁[()][0-9A-Za-z]/g, ' ')
    .replace(/␁[=>78]/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Accumulates a pseudo-terminal's bytes as text. ONE decoder in streaming mode: a PTY delivers output
 * in arbitrary chunks, and a box-drawing character such as `│` is
 * three bytes, so decoding each chunk on its own turns a split character into U+FFFD and corrupts
 * the very row a test is reading.
 */
export function terminalTranscript(): { feed(bytes: Uint8Array): void; text(): string } {
  const decoder = new TextDecoder();
  let raw = '';
  return {
    feed: bytes => {
      raw += decoder.decode(bytes, { stream: true });
    },
    text: () => raw,
  };
}

/**
 * Start `command` in a pseudo-terminal and wait until one of `settled` matches the screen or the
 * budget runs out. The process is killed either way: a launch screen is the measurement, and a
 * session that got further would only be waiting on the dead network.
 */
export async function screenOf(
  command: readonly string[],
  options: {
    env: Record<string, string>;
    cwd: string;
    settled: readonly RegExp[];
    timeoutMs?: number;
    cols?: number;
    /** Typed once the screen settles — a slash command, say — and then waited for in turn. */
    afterwards?: { readonly type: string; readonly settled: readonly RegExp[] };
  },
): Promise<string> {
  const transcript = terminalTranscript();
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.cols ?? 120,
      rows: 40,
      data(_terminal, bytes) {
        transcript.feed(bytes);
      },
    },
  });
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  const settle = async (settled: readonly RegExp[]) => {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (Date.now() < deadline && !exited && !settled.some(pattern => pattern.test(plainScreen(transcript.text())))) {
      await Bun.sleep(200);
    }
    // A frame often arrives in pieces; one more beat lets the rest of the settled screen land.
    await Bun.sleep(750);
  };
  await settle(options.settled);
  if (options.afterwards !== undefined && !exited) {
    // One key at a time, as a person types: a TUI reading a burst as a paste would not open its menu.
    for (const key of options.afterwards.type) {
      child.terminal?.write(key);
      await Bun.sleep(60);
    }
    await Bun.sleep(500);
    child.terminal?.write('\r');
    await settle(options.afterwards.settled);
  }
  child.kill('SIGKILL');
  await child.exited;
  child.terminal?.close();
  return plainScreen(transcript.text());
}

export interface AppServer {
  /** Send one request and wait for the response with the same id. */
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

/** `codex app-server` over stdio JSON-RPC, already past `initialize`. */
export async function startAppServer(
  bin: string,
  options: { env: Record<string, string>; cwd: string },
): Promise<AppServer> {
  const child = Bun.spawn([bin, 'app-server'], {
    cwd: options.cwd,
    env: options.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const responses = new Map<number, Record<string, unknown>>();
  let buffered = '';
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk);
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (line === '') continue;
        try {
          const message = JSON.parse(line) as { id?: unknown };
          if (typeof message.id === 'number') responses.set(message.id, message as Record<string, unknown>);
        } catch {
          // Not JSON-RPC: a log line. Ignored rather than read, the same as the product does.
        }
      }
    }
  })();
  let next = 0;
  const request = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    next++;
    const id = next;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    await child.stdin.flush();
    const deadline = Date.now() + 30_000;
    while (!responses.has(id)) {
      if (Date.now() > deadline) throw new Error(`codex app-server never answered ${method}`);
      await Bun.sleep(50);
    }
    return responses.get(id) ?? {};
  };
  await request('initialize', {
    clientInfo: { name: 'fy-contract', title: 'Ferretry contract guard', version: '0.0.0' },
    capabilities: {},
  });
  return {
    request,
    stop: async () => {
      child.kill('SIGKILL');
      await child.exited;
    },
  };
}
