/**
 * Parity rows J-0042, J-0087, J-0157, J-0223, J-0224, J-0226, J-0232, J-0233, J-0234: the reads and timers Logins keeps.
 *
 * J-0096 (v4's watched fleet-manifest read, cached until the file-event hub said it changed) is the kernel config
 * service's now: it serves the answer of the last reload and its file watcher lets go of it, proved in the kernel's
 * host-config service test. Logins adds no cache on top, which the read test below pins.
 *
 * J-0232 J-0233 J-0234 (v4's fleet-reading service: a timer, a watch on each store file and a watch on each attributed
 * rollout) are kept by two other means, because the 5.0 kernel has no file-event hub for a plugin: one kernel job runs
 * the Codex passive pass on an interval, and what the watches saved is saved by reading only what moved (a rollout's
 * stamp) and by never keeping a store's facts (so a changed store is simply seen at the next read). What Logins' watch does do
 * is announce a file that moved in effect (`logins.changed`), proved in tests/unit/daemon/config-watch.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { milliseconds } from '@ferretry/std';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { OwnedLoginStore, type OwnedLoginRoot } from '../../../daemon/adapters/credentials/owned-store.ts';
import { harnessLoginTimer } from '../../../daemon/adapters/harness-login/login-child.ts';
import {
  HARNESS_LOGIN_IDLE_MINUTES,
  HARNESS_LOGIN_SHUTDOWN_GRACE_MS,
  HARNESS_LOGIN_WINDOW_MINUTES,
} from '../../../daemon/lib/harness-login/service.ts';
import { LoginChanged, LoginListSchema } from '../../../contract/index.ts';
import { CREDENTIAL_LIST_FRESH_MS } from '../../../daemon/lib/credentials/credentials-service.ts';
import daemon from '../../../daemon/index.ts';
import { CODEX_PASSIVE_USAGE_JOB } from '../../../daemon/index.ts';
import { emptyVault } from '../../support/fake-vault.ts';

describe('the jobs and timers Logins keeps', () => {
  test('J-0042 J-0087 the models read runs once after start as a kernel job and never throws when the network is down', async () => {
    const host = await testHost({
      plugins: [daemon],
      fakes: { vault: emptyVault() },
      fetch: async () => {
        throw new Error('offline');
      },
    });
    try {
      expect(host.jobIds()).toContain('logins.models-refresh');
      await host.runJob('logins.models-refresh');
    } finally {
      await host.stop();
    }
  });

  test('Logins keeps no read cache of its own: the next read returns whatever the host config holds at that moment', async () => {
    // The test host's config is edited IN PLACE and its port reads it live, so the host fires no config listener:
    // whatever the next read shows, Logins took it from the host at that moment and held none of its own. (The real
    // host serves the last reload's snapshot, which is the kernel's cache, proved in its service test J-0096.)
    const logins: Record<string, unknown> = { work: { harness: 'claude-code', store: 'host' } };
    const host = await testHost({ plugins: [daemon], fakes: { vault: emptyVault() }, config: { logins } });
    try {
      await host.settle();
      const idsOf = async () =>
        (LoginListSchema.parse((await host.request('GET', '/v1/logins')).json()).logins as readonly { id: string }[])
          .map(login => login.id)
          .sort();
      const announced = () => host.published.filter(entry => entry.event === LoginChanged.name).length;

      expect(await idsOf()).toEqual(['work']);

      logins.home = { harness: 'codex', store: 'host' };
      expect(await idsOf()).toEqual(['home', 'work']);

      delete logins.work;
      expect(await idsOf()).toEqual(['home']);

      expect(announced()).toBe(0);
    } finally {
      await host.stop();
    }
  });

  test('J-0157 a sign-in’s timer is the kernel clock’s, so it ends with the daemon and a test can drive it', () => {
    const armed: number[] = [];
    const timer = harnessLoginTimer({
      after: (delay: number) => {
        armed.push(Number(delay));
        return () => undefined;
      },
    } as never);

    timer.after(1_500, () => undefined)();

    expect(armed).toEqual([Number(milliseconds(1_500))]);
  });

  test('J-0223 J-0224 J-0226 a sign-in keeps its window, its idle limit and its shutdown grace', () => {
    expect([HARNESS_LOGIN_WINDOW_MINUTES, HARNESS_LOGIN_IDLE_MINUTES, HARNESS_LOGIN_SHUTDOWN_GRACE_MS]).toEqual([
      10, 5, 2_000,
    ]);
  });

  test('J-0232 the passive reading runs as a kernel job on an interval, and one run records the reading of a ferret on the login', async () => {
    const rig = await codexRig(8);
    try {
      expect(rig.host.jobIds()).toContain(CODEX_PASSIVE_USAGE_JOB);
      expect((await rig.usage())?.usedPercent).toBeUndefined();

      await rig.host.runJob(CODEX_PASSIVE_USAGE_JOB);

      expect(await rig.usage()).toMatchObject({ usedPercent: 8, source: 'codex-rollout' });
    } finally {
      await rig.host.stop();
    }
  });

  test('J-0232 a reading taken before the ferret started on the login is not the login’s, end to end', async () => {
    const rig = await codexRig(8, '2026-10-13T09:00:00.000Z');
    try {
      await rig.host.runJob(CODEX_PASSIVE_USAGE_JOB);

      expect(rig.reads()).toBe(1);
      expect((await rig.usage())?.usedPercent).toBeUndefined();
    } finally {
      await rig.host.stop();
    }
  });

  test('J-0232 a daemon with no Ferrets to ask has no ferret on any login, and a run records nothing and fails nothing', async () => {
    const host = await testHost({
      plugins: [daemon],
      fakes: { vault: emptyVault() },
      config: { logins: { team: { harness: 'codex', store: 'ferretry' } } },
    });
    try {
      await host.settle();
      await host.runJob(CODEX_PASSIVE_USAGE_JOB);
      expect(host.logs.filter(entry => entry.level === 'error')).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  test('J-0234 a rollout is read again only after it moved, and a ferret that stopped is not asked about at all', async () => {
    const rig = await codexRig(8);
    try {
      await rig.host.runJob(CODEX_PASSIVE_USAGE_JOB);
      await rig.host.runJob(CODEX_PASSIVE_USAGE_JOB);
      expect(rig.reads()).toBe(1);

      rig.append(31);
      await rig.host.runJob(CODEX_PASSIVE_USAGE_JOB);
      expect(rig.reads()).toBe(2);
      expect(await rig.usage()).toMatchObject({ usedPercent: 31 });

      rig.ferrets.setState(rig.ferret, 'stopped');
      rig.append(77);
      await rig.host.runJob(CODEX_PASSIVE_USAGE_JOB);
      expect(rig.reads()).toBe(2);
      expect(await rig.usage()).toMatchObject({ usedPercent: 31 });
    } finally {
      await rig.host.stop();
    }
  });

  test('J-0233 no watch keeps a store’s facts: a store that changed is simply what the next read shows', async () => {
    const files = new Map<string, string>();
    const info = (path: string) => ({
      kind: 'file' as const,
      size: files.get(path)?.length ?? 0,
      modified: 1,
      mode: 0o600,
      links: 1,
    });
    const root = {
      resolve: (within: string) => ({ ok: true as const, value: within === '' ? '/creds' : `/creds/${within}` }),
      readText: async (path: string) => files.get(path) ?? '',
      writeText: async () => undefined,
      stat: async (path: string) => (files.has(path) ? info(path) : undefined),
      lstat: async (path: string) => (files.has(path) ? info(path) : undefined),
      ensurePrivateDirectory: async () => undefined,
    } as unknown as OwnedLoginRoot;
    const store = new OwnedLoginStore(root, () => 0);
    const resolution = {
      harness: 'codex',
      store: 'ferretry',
      ownedDirectory: '/creds/team',
      canonicalFile: '/creds/team/auth.json',
    } as never;

    const empty = await store.local(resolution);
    files.set('/creds/team/auth.json', '{"tokens":{"access_token":"first"}}');
    const first = await store.local(resolution);
    files.set('/creds/team/auth.json', '{"tokens":{"access_token":"second"}}');
    const second = await store.local(resolution);

    expect(empty.fingerprint).toBeUndefined();
    expect(first.fingerprint).toBeDefined();
    expect(second.fingerprint).toBeDefined();
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });
});

/** A Codex login with one idle ferret launched on it, whose rollout holds one reading; a run of the job reads it. */
async function codexRig(initial: number, startedAt = '2026-10-13T08:00:00.000Z') {
  const ferrets = new FakeFerrets();
  const ferret = ferretId('f1');
  // Started on `team` at `startedAt` (by default before every reading this rig appends: 08:00 plus the used percent in minutes).
  ferrets.add({
    id: ferret,
    harness: 'codex',
    state: 'idle',
    runtime: 'work',
    login: 'team',
    stateAt: startedAt,
  } as never);
  const event = (used: number) =>
    `${JSON.stringify({
      timestamp: new Date(Date.parse('2026-10-13T08:00:00.000Z') + used * 60_000).toISOString(),
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: used, resets_at: 1_800_003_600 } } },
    })}\n`;
  let text = event(initial);
  let opened = 0;
  const encoder = new TextEncoder();
  Object.assign(ferrets, {
    harness: async () => ({
      transcriptBytes: async () => {
        const bytes = encoder.encode(text);
        let counted = false;
        return {
          file: 'rollout',
          size: bytes.length,
          mtimeMs: bytes.length,
          read: async (offset: number, length: number) => {
            if (!counted) {
              counted = true;
              opened += 1;
            }
            return bytes.slice(offset, offset + length);
          },
          close: async () => undefined,
        };
      },
    }),
  });
  const host = await testHost({
    plugins: [daemon],
    fakes: { vault: emptyVault() },
    uses: { ferrets },
    config: { logins: { team: { harness: 'codex', store: 'ferretry' } } },
  });
  await host.settle();
  return {
    host,
    ferrets,
    ferret,
    reads: () => opened,
    append: (used: number) => {
      text += event(used);
    },
    usage: async () => {
      // The list is kept for a few seconds; a later read must be a new one.
      await host.clock.advance(CREDENTIAL_LIST_FRESH_MS + 1);
      const list = LoginListSchema.parse((await host.request('GET', '/v1/logins')).json());
      const usage = list.logins.find(login => login.id === 'team')?.usage;
      return { usedPercent: usage?.fiveHour?.usedPercent, source: usage?.source };
    },
  };
}
