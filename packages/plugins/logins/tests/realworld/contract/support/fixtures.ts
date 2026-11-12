/**
 * Fake Codex credentials in Codex's on-disk shape, and a Codex app-server client (ported from v4's
 * `fleet/tests/contract/support/fixtures.ts`, Codex half). Every token is an obvious fake (`FAKE`, `ROTATED<n>`), unsigned,
 * and never leaves loopback.
 */
import { writeFile } from 'node:fs/promises';

const HOUR_MS = 3_600_000;
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

export interface AppServer {
  /** Send one request and wait for the response with the same id. */
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

/** `codex app-server` over stdio JSON-RPC, already past `initialize`. */
export async function startAppServer(
  bin: string,
  options: {
    env: Record<string, string>;
    cwd: string;
    /** Config overrides placed before the subcommand, as the production renewal passes them (`-c key=value`). */
    flags?: readonly string[];
  },
): Promise<AppServer> {
  const child = Bun.spawn([bin, ...(options.flags ?? []), 'app-server'], {
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
