/**
 * The owned login store's edges, on the kernel's REAL credentials root over a temporary FY_HOME: the Claude account
 * email kept only while the file's stamp holds (a link and what it points at), a path outside the root, a probe that
 * throws during an active read, and a Check now whose folder is not there.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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
});
