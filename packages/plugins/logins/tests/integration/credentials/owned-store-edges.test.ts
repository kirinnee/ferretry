/**
 * The owned login store's edges, on the kernel's REAL credentials root over a temporary FY_HOME: the Claude account
 * email kept only while the file's stamp holds (a link and what it points at), a path outside the root, a probe that
 * throws during an active read, and a Check now whose folder is not there.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RootName, RootsPort } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor } from '@ferretry/kernel/host';
import { OwnedLoginStore } from '../../../daemon/adapters/credentials/owned-store.ts';

const NOW = Date.parse('2026-10-16T09:00:00Z');
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const fyHome = await mkdtemp(join(tmpdir(), 'logins-owned-edges-'));
  homes.push(fyHome);
  const base = join(fyHome, 'state', 'logins', 'credentials');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const roots: RootsPort = rootsPortFor(
    nodeFs(() => 'fixture'),
    { home: fyHome, plugin: 'logins', worktrees: `${fyHome}-worktrees` },
    ['credentials'] as readonly RootName[],
    () => undefined,
  );
  return { base, fyHome, root: roots.root('credentials') };
}

const account = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email } });

describe('the Claude account email', () => {
  test('is read from the account file and kept only while the file’s stamp holds', async () => {
    const f = await fixture();
    const store = new OwnedLoginStore(f.root, () => NOW);
    const accountFile = join(f.base, 'claude', '.claude.json');
    await mkdir(join(f.base, 'claude'));
    const ask = () => store.email({ harness: 'claude', accountFile });

    expect(await ask()).toBeUndefined();
    await writeFile(accountFile, account('first@example.test'));
    expect(await ask()).toBe('first@example.test');
    expect(await ask()).toBe('first@example.test');
    await writeFile(accountFile, account('a-longer-second@example.test'));
    expect(await ask()).toBe('a-longer-second@example.test');
    await writeFile(accountFile, 'not json at all');
    expect(await ask()).toBeUndefined();
    await writeFile(accountFile, '["an","array","not","an","account"]');
    expect(await ask()).toBeUndefined();
    await writeFile(accountFile, '{"oauthAccount":"a string, not an account"}');
    expect(await ask()).toBeUndefined();
  });

  test('follows a link inside the root to what it points at, and reads a dangling link as nothing', async () => {
    const f = await fixture();
    const store = new OwnedLoginStore(f.root, () => NOW);
    await mkdir(join(f.base, 'claude'));
    await writeFile(join(f.base, 'real.json'), account('linked@example.test'));
    const link = join(f.base, 'claude', '.claude.json');
    await symlink(join(f.base, 'real.json'), link);

    const linked = await store.email({ harness: 'claude', accountFile: link });
    await unlink(join(f.base, 'real.json'));
    const dangling = await store.email({ harness: 'claude', accountFile: link });

    expect(linked).toBe('linked@example.test');
    expect(dangling).toBeUndefined();
  });

  test('is still read, but not kept, when the root cannot even look at the file', async () => {
    const f = await fixture();
    const blind = new OwnedLoginStore(
      {
        ...f.root,
        lstat: async () => {
          throw new Error('lstat refused');
        },
      },
      () => NOW,
    );
    await mkdir(join(f.base, 'claude'));
    const accountFile = join(f.base, 'claude', '.claude.json');
    await writeFile(accountFile, account('blind@example.test'));

    expect(await blind.email({ harness: 'claude', accountFile })).toBe('blind@example.test');
    await writeFile(accountFile, account('changed@example.test'));
    expect(await blind.email({ harness: 'claude', accountFile })).toBe('changed@example.test');
  });

  test('is never read from outside the owned login root', async () => {
    const f = await fixture();
    const store = new OwnedLoginStore(f.root, () => NOW);

    await expect(store.email({ harness: 'claude', accountFile: join(f.fyHome, 'elsewhere.json') })).rejects.toThrow(
      'outside the owned login root',
    );
  });
});

describe('the status ports', () => {
  const resolution = (base: string) =>
    ({
      harness: 'claude',
      store: 'ferretry',
      ownedDirectory: join(base, 'claude'),
      credentialFile: join(base, 'claude', '.credentials.json'),
    }) as never;

  test('an active read whose probe throws answers inconclusive, with the local facts still returned', async () => {
    const f = await fixture();
    await mkdir(join(f.base, 'claude'));
    const store = new OwnedLoginStore(f.root, () => NOW);
    const ports = store.statusPorts({
      anthropic: {
        probeMaterial: async () => {
          throw new Error('the probe fell over');
        },
      } as never,
      codex: {} as never,
      refresh: { refresh: async () => ({ outcome: 'ran' }) },
      usageIntervalMs: 60_000,
    });

    const read = await ports.activeUsage(resolution(f.base));

    expect(read.result).toEqual({ usageBased: true, ok: false, credentialSignal: 'inconclusive' });
    expect(read.local).toBeDefined();
  });

  test('Check now on a login whose folder is not there is unavailable, and launches nothing', async () => {
    const f = await fixture();
    const store = new OwnedLoginStore(f.root, () => NOW);
    let launched = false;
    const ports = store.statusPorts({
      anthropic: {} as never,
      codex: {} as never,
      refresh: {
        refresh: async () => {
          launched = true;
          return { outcome: 'ran' };
        },
      },
      usageIntervalMs: 60_000,
    });

    const attempt = await ports.refresh.refresh(
      { accountId: 'codex', kind: 'codex', home: join(f.base, 'codex') },
      async () => true,
    );

    expect(attempt).toEqual({
      outcome: 'unavailable',
      reason: 'the owned login directory could not be reached',
    });
    expect(launched).toBe(false);
  });

  test('the passive reading `fy statusline` writes is read from state/logins/credentials/<id>/usage.json', async () => {
    // `fy statusline` writes JSON.stringify(record) + "\n" at internalRootFolder('logins', 'credentials')/<id>/usage.json
    // (packages/cli/src/adapters/statusline); this is the reader of exactly that file, on the real credentials root.
    const f = await fixture();
    await mkdir(join(f.base, 'claude'));
    const record = {
      version: 1,
      source: 'claude-statusline',
      at: NOW - 1_000,
      fiveHour: { usedPercent: 12, resetAt: NOW + 3_600_000 },
      weekly: { usedPercent: 3 },
    } as const;
    await writeFile(join(f.base, 'claude', 'usage.json'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const store = new OwnedLoginStore(f.root, () => NOW);
    const ports = store.statusPorts({
      anthropic: {} as never,
      codex: {} as never,
      refresh: { refresh: async () => ({ outcome: 'ran' }) },
      usageIntervalMs: 60_000,
    });

    const read = await ports.passiveUsage({ resolution: resolution(f.base) } as never);

    expect(read).toEqual(record);
  });

  test('a Codex rollout reading is recorded where the reader finds it: private, one JSON line, replaced whole', async () => {
    const f = await fixture();
    await mkdir(join(f.base, 'codex'));
    const store = new OwnedLoginStore(f.root, () => NOW);
    const subject = {
      id: 'codex',
      resolution: {
        harness: 'codex',
        store: 'ferretry',
        ownedDirectory: join(f.base, 'codex'),
        canonicalFile: join(f.base, 'codex', 'auth.json'),
      },
    } as never;
    const ports = store.statusPorts({
      anthropic: {} as never,
      codex: {} as never,
      refresh: { refresh: async () => ({ outcome: 'ran' }) },
      usageIntervalMs: 60_000,
    });
    const first = { version: 1, source: 'codex-rollout', at: NOW - 60_000, fiveHour: { usedPercent: 10 } } as const;
    const second = {
      version: 1,
      source: 'codex-rollout',
      at: NOW,
      fiveHour: { usedPercent: 25 },
      weekly: { usedPercent: 4 },
    } as const;

    await store.recordPassiveUsage(subject, first);
    await store.recordPassiveUsage(subject, second);

    const file = join(f.base, 'codex', 'usage.json');
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(second)}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await ports.passiveUsage(subject)).toEqual(second);
  });

  describe('an older passive reading never replaces a newer persisted one', () => {
    const codexSubject = (base: string) =>
      ({
        id: 'codex',
        resolution: {
          harness: 'codex',
          store: 'ferretry',
          ownedDirectory: join(base, 'codex'),
          canonicalFile: join(base, 'codex', 'auth.json'),
        },
      }) as never;
    const reading = (at: number, usedPercent: number) =>
      ({ version: 1, source: 'codex-rollout', at, fiveHour: { usedPercent } }) as const;
    const AT_0801 = Date.parse('2026-10-16T08:01:00Z');
    const AT_0800 = Date.parse('2026-10-16T08:00:00Z');

    test('08:01 at 99% survives a later write of 08:00 at 1%, from the same store and from a fresh one', async () => {
      const f = await fixture();
      await mkdir(join(f.base, 'codex'));
      const subject = codexSubject(f.base);
      const file = join(f.base, 'codex', 'usage.json');

      const store = new OwnedLoginStore(f.root, () => NOW);
      await store.recordPassiveUsage(subject, reading(AT_0801, 99));
      await store.recordPassiveUsage(subject, reading(AT_0800, 1));
      expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(reading(AT_0801, 99))}\n`);

      // A daemon restart: no memory of what was recorded, only the file.
      const restarted = new OwnedLoginStore(f.root, () => NOW);
      await restarted.recordPassiveUsage(subject, reading(AT_0800, 1));
      await restarted.recordPassiveUsage(subject, reading(AT_0801, 5));
      expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(reading(AT_0801, 99))}\n`);
      expect((await stat(file)).mode & 0o777).toBe(0o600);

      await restarted.recordPassiveUsage(subject, reading(AT_0801 + 1, 7));
      expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(reading(AT_0801 + 1, 7))}\n`);
    });

    test('two writers at once leave the newer reading, whichever order they arrive in', async () => {
      const f = await fixture();
      await mkdir(join(f.base, 'codex'));
      const subject = codexSubject(f.base);
      const file = join(f.base, 'codex', 'usage.json');

      const store = new OwnedLoginStore(f.root, () => NOW);
      await Promise.all([
        store.recordPassiveUsage(subject, reading(AT_0801, 99)),
        store.recordPassiveUsage(subject, reading(AT_0800, 1)),
        store.recordPassiveUsage(subject, reading(AT_0800 - 1, 2)),
      ]);
      expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(reading(AT_0801, 99))}\n`);

      const other = new OwnedLoginStore(f.root, () => NOW);
      await rm(file);
      await Promise.all([
        other.recordPassiveUsage(subject, reading(AT_0800, 1)),
        other.recordPassiveUsage(subject, reading(AT_0801, 99)),
      ]);
      expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(reading(AT_0801, 99))}\n`);
    });

    test('a write that fails is said to its caller and does not stop the next one', async () => {
      const f = await fixture();
      await mkdir(join(f.base, 'codex'));
      const subject = codexSubject(f.base);
      let failing = true;
      const flaky = new OwnedLoginStore(
        {
          resolve: path => f.root.resolve(path),
          readText: async path => await f.root.readText(path),
          writeText: async (path, text, options) => {
            if (failing) throw new Error('disk full');
            await f.root.writeText(path, text, options);
          },
          stat: async path => await f.root.stat(path),
          lstat: async path => await f.root.lstat(path),
          ensurePrivateDirectory: async path => await f.root.ensurePrivateDirectory(path),
        },
        () => NOW,
      );

      const lost = flaky.recordPassiveUsage(subject, reading(AT_0800, 1));
      const next = flaky.recordPassiveUsage(subject, reading(AT_0801, 2));
      await expect(lost).rejects.toThrow('disk full');
      await expect(next).rejects.toThrow('disk full');

      failing = false;
      await flaky.recordPassiveUsage(subject, reading(AT_0801, 2));
      expect(await readFile(join(f.base, 'codex', 'usage.json'), 'utf8')).toBe(
        `${JSON.stringify(reading(AT_0801, 2))}\n`,
      );
    });
  });

  test('a login this daemon does not own, or one with no sign-in directory, has no reading file to write', async () => {
    const f = await fixture();
    const store = new OwnedLoginStore(f.root, () => NOW);
    const record = { version: 1, source: 'codex-rollout', at: NOW, fiveHour: { usedPercent: 1 } } as const;
    const refused = [
      { id: 'host', resolution: { harness: 'codex', store: 'host', unavailable: 'not in 5.0 yet' } },
      { id: 'env', resolution: { harness: 'codex', store: 'environment' } },
      {
        id: 'bare',
        resolution: { harness: 'codex', store: 'ferretry', canonicalFile: join(f.base, 'bare', 'auth.json') },
      },
    ] as never[];

    for (const subject of refused) await store.recordPassiveUsage(subject, record);

    expect(await readdir(f.base)).toEqual([]);
  });
});
