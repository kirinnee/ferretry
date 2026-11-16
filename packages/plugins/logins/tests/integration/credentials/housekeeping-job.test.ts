/**
 * The housekeeping worker's job, on the kernel's REAL `credentials` root over a temporary FY_HOME and a scripted fetch:
 * the sign-in is read through the root's fences, its token is sent as one header to its provider's one URL and nowhere
 * else, and what comes back is facts. Fake tokens only; no network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchPort, RootName, RootsPort } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor } from '@ferretry/kernel/host';
import { answerHousekeeping, signalClock } from '../../../daemon/adapters/credentials/housekeeping-job.ts';
import type { HousekeepingRequest } from '../../../daemon/lib/credentials/housekeeping-protocol.ts';
import { relativeRoot } from '../../support/housekeeping.ts';

const NOW = Date.parse('2026-10-16T09:00:00Z');
const TOKEN = 'oauth-access-TESTONLY-housekeeping';
const REFRESH = 'refresh-TESTONLY-housekeeping';
const CODEX_TOKEN = 'codex-access-TESTONLY-housekeeping';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const fyHome = await mkdtemp(join(tmpdir(), 'logins-housekeeping-'));
  homes.push(fyHome);
  const base = join(fyHome, 'state', 'logins', 'credentials');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const roots: RootsPort = rootsPortFor(
    nodeFs(() => 'fixture'),
    { home: fyHome, plugin: 'logins', worktrees: `${fyHome}-worktrees` },
    ['credentials'] as readonly RootName[],
    () => undefined,
  );
  const root = roots.root('credentials');
  const put = async (path: string, text: string) => {
    await mkdir(join(base, path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(join(base, path), text, { mode: 0o600 });
  };
  return { base, root, put };
}

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}
const scripted = (answer: () => Response | Promise<Response>): { port: FetchPort; seen: Seen[] } => {
  const seen: Seen[] = [];
  return {
    seen,
    port: {
      request: async (url, init) => {
        seen.push({ url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
        return await answer();
      },
    },
  };
};

const jwt = (claims: unknown) => `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
const claudeBlob = JSON.stringify({
  claudeAiOauth: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: NOW + 3_600_000 },
});
const codexBlob = JSON.stringify({
  tokens: {
    access_token: CODEX_TOKEN,
    refresh_token: REFRESH,
    id_token: jwt({ email: 'codex@example.test' }),
    account_id: 'fixture-account',
  },
});
const job = (harness: 'claude' | 'codex', file: string, id = 1): HousekeepingRequest => ({
  type: 'job',
  id,
  job: { kind: 'credential.active', harness, file, nowMs: NOW },
});
const usage = () => new Response('{"five_hour":{"utilization":12,"resets_at":null}}', { status: 200 });
const NO_GRANTS = () => {
  throw new Error('a probe needs no grant');
};

describe('a Claude sign-in read', () => {
  test('is read through the root, sent as one bearer header to the usage URL, and answered as facts', async () => {
    const f = await fixture();
    await f.put('claude/.credentials.json', claudeBlob);
    const fetched = scripted(usage);

    const answer = await answerHousekeeping(
      () => ({ root: relativeRoot(f.root), fetch: fetched.port, clock: signalClock }),
      job('claude', 'claude/.credentials.json'),
    );

    expect(fetched.seen.map(s => [s.url, s.method, s.headers.get('authorization')])).toEqual([
      ['https://api.anthropic.com/api/oauth/usage', 'GET', `Bearer ${TOKEN}`],
    ]);
    if (!('value' in answer)) throw new Error('no value');
    expect(answer).toMatchObject({ type: 'result', id: 1, ok: true });
    expect(answer.value.result).toMatchObject({ ok: true, credentialSignal: 'accepted' });
    expect(answer.value.local.fingerprint).toHaveLength(32);
    const wire = JSON.stringify(answer);
    expect(wire.includes(TOKEN) || wire.includes(REFRESH) || wire.includes('claudeAiOauth')).toBe(false);
  });

  test('that is absent asks nothing of the provider and says it was never signed in', async () => {
    const f = await fixture();
    await mkdir(join(f.base, 'claude'));
    const fetched = scripted(usage);

    const answer = await answerHousekeeping(
      () => ({ root: relativeRoot(f.root), fetch: fetched.port, clock: signalClock }),
      job('claude', 'claude/.credentials.json'),
    );

    expect(fetched.seen).toEqual([]);
    if (!('value' in answer)) throw new Error('no value');
    expect(answer.value.result.credentialSignal).toBe('absent');
  });

  test('whose transport failure quotes the token comes back without it', async () => {
    const f = await fixture();
    await f.put('claude/.credentials.json', claudeBlob);
    const fetched = scripted(() => {
      throw new Error(`socket closed while sending Bearer ${TOKEN}`);
    });

    const answer = await answerHousekeeping(
      () => ({ root: relativeRoot(f.root), fetch: fetched.port, clock: signalClock }),
      job('claude', 'claude/.credentials.json'),
    );

    expect(JSON.stringify(answer).includes(TOKEN)).toBe(false);
    if (!('value' in answer)) throw new Error('no value');
    expect(answer.value.result.credentialSignal).toBe('inconclusive');
  });
});

describe('a Codex sign-in read', () => {
  test('sends the access token and account id to the usage URL and answers facts', async () => {
    const f = await fixture();
    await f.put('codex/auth.json', codexBlob);
    const fetched = scripted(() => new Response('{"rate_limit":{}}', { status: 200 }));

    const answer = await answerHousekeeping(
      () => ({ root: relativeRoot(f.root), fetch: fetched.port, clock: signalClock }),
      job('codex', 'codex/auth.json'),
    );

    expect(fetched.seen.map(s => [s.url, s.headers.get('authorization'), s.headers.get('chatgpt-account-id')])).toEqual(
      [['https://chatgpt.com/backend-api/wham/usage', `Bearer ${CODEX_TOKEN}`, 'fixture-account']],
    );
    if (!('value' in answer)) throw new Error('no value');
    expect(answer.value.local.codex).toMatchObject({ state: 'tokens', email: 'codex@example.test' });
    const wire = JSON.stringify(answer);
    expect(wire.includes(CODEX_TOKEN) || wire.includes(REFRESH)).toBe(false);
  });
});

describe('a job that cannot be answered', () => {
  test('is answered with a fixed word, and nothing the read threw (a path outside the root included)', async () => {
    const f = await fixture();
    await f.put('claude/.credentials.json', claudeBlob);
    const fetched = scripted(usage);
    const quoting = {
      ...relativeRoot(f.root),
      readText: async () => {
        throw new Error(`cannot read ${TOKEN}`);
      },
    };

    const failed = await answerHousekeeping(
      () => ({ root: quoting, fetch: fetched.port, clock: signalClock }),
      job('claude', 'claude/.credentials.json', 7),
    );
    const outside = await answerHousekeeping(
      () => ({ root: relativeRoot(f.root), fetch: fetched.port, clock: signalClock }),
      job('claude', '../../another-plugin/credentials/claude/.credentials.json', 8),
    );

    expect(failed).toEqual({ type: 'result', id: 7, ok: false, failure: 'internal' });
    expect(outside).toEqual({ type: 'result', id: 8, ok: false, failure: 'internal' });
    expect(fetched.seen).toEqual([]);
  });

  test('is answered the same when the thread was started with no grant at all', async () => {
    expect(await answerHousekeeping(NO_GRANTS, job('claude', 'x', 3))).toEqual({
      type: 'result',
      id: 3,
      ok: false,
      failure: 'internal',
    });
  });
});

describe('the probe `fyd --check` sends', () => {
  test('is answered without touching a grant', async () => {
    expect(await answerHousekeeping(NO_GRANTS, { probe: true })).toEqual({ probe: true });
  });
});

describe('the worker clock', () => {
  test('fires after its delay, and a cancelled timer never fires', async () => {
    let fired = 0;
    signalClock.after(5 as never, () => {
      fired += 1;
    });
    const cancel = signalClock.after(5 as never, () => {
      fired += 10;
    });
    cancel();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(fired).toBe(1);
  });
});
