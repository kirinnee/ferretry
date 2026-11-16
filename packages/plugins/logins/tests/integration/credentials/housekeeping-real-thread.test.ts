/**
 * S175 on a REAL worker thread, through the kernel's REAL grant service: the housekeeping client starts the real worker
 * program with `workersFor(bunWorkers(), …)`, whose `credentials` root is the kernel's own root over a temporary FY_HOME
 * and whose fetch is `restrictFetch` over the Logins manifest's hosts and a scripted base. The sign-in is read and the
 * Bearer header sent only by the worker's code; the Bearer reaches the (scripted) network only there, and what comes
 * back to the daemon is facts. The kernel serves the worker's read and request on main (declared as a GAP in
 * `ports-pending.json`), so this proves what the worker does with the grants, not that the blob never meets main's
 * heap. Fixture credentials only; no network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchPort, RootName } from '@ferretry/kernel/contract';
import {
  bunWorkers,
  hostPermitted,
  nodeFs,
  restrictFetch,
  rootsPortFor,
  systemClock,
  workersFor,
} from '@ferretry/kernel/host';
import { HOUSEKEEPING_FAILED, housekeepingClient } from '../../../daemon/adapters/credentials/housekeeping-client.ts';
import manifest from '../../../manifest.ts';

const TOKEN = 'oauth-access-TESTONLY-real-thread';
const REFRESH = 'refresh-TESTONLY-real-thread';

const homes: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const fyHome = await mkdtemp(join(tmpdir(), 'logins-real-thread-'));
  homes.push(fyHome);
  const base = join(fyHome, 'state', 'logins', 'credentials');
  await mkdir(join(base, 'claude'), { recursive: true, mode: 0o700 });
  await writeFile(
    join(base, 'claude', '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000 },
    }),
    { mode: 0o600 },
  );
  const roots = rootsPortFor(
    nodeFs(() => 'fixture'),
    { home: fyHome, plugin: 'logins', worktrees: `${fyHome}-worktrees` },
    ['credentials'] as readonly RootName[],
    () => undefined,
  );
  const seen: Array<{ url: string; method: string; authorization: string | null }> = [];
  const scripted: FetchPort = {
    request: async (url, init) => {
      seen.push({
        url: String(url),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response('{"five_hour":{"utilization":12,"resets_at":null}}', { status: 200 });
    },
  };
  const declared = manifest.permissions.network;
  const workers = workersFor(bunWorkers(), () => undefined, {
    plugin: 'logins',
    roots,
    fetch: restrictFetch('logins', declared, scripted),
    declaresNetwork: declared.length > 0,
    mayReach: (hostname, host) =>
      hostPermitted(declared, () => ({ programs: [], hosts: [] }), hostname, undefined, host),
  });
  const client = housekeepingClient({ workers, clock: systemClock() });
  stops.push(client.stop);
  return { client, seen };
}

describe('S175 the real worker thread, granted by the real kernel service', () => {
  test('reads the sign-in, makes ONE usage GET with the Bearer only there, and answers facts only', async () => {
    const f = await fixture();

    const answer = await f.client.activeUsage('claude', 'claude/.credentials.json');

    expect(f.seen).toEqual([
      { url: 'https://api.anthropic.com/api/oauth/usage', method: 'GET', authorization: `Bearer ${TOKEN}` },
    ]);
    expect(answer.result).toMatchObject({ ok: true, credentialSignal: 'accepted' });
    expect(answer.local.fingerprint).toHaveLength(32);
    const wire = JSON.stringify(answer);
    expect(wire.includes(TOKEN) || wire.includes(REFRESH) || wire.includes('claudeAiOauth')).toBe(false);
  });

  test('a path that climbs out of the root is refused: the fixed sentence, and nothing is sent anywhere', async () => {
    const f = await fixture();

    const failure = await f.client.activeUsage('claude', '../../../../etc/hostname').then(
      () => 'resolved',
      (error: Error) => error.message,
    );

    expect(failure).toBe(HOUSEKEEPING_FAILED);
    expect(failure).toBe('the sign-in read could not be completed');
    expect(f.seen).toEqual([]);
  });
});
