import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LoginKind } from '@ferretry/core-ferrets/contract';
import type { RootsPort } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor } from '@ferretry/kernel/host';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { fixedClock, owner, standInAdmission, testHost } from '@ferretry/kernel/testing';
import { instantFromEpochMs } from '@ferretry/std';
import { buildLoginsDaemon } from '../../../daemon/index.ts';
import { emptyVault } from '../../support/fake-vault.ts';

/**
 * A Claude login kept in Ferretry's store launches a ferret with EXACTLY the one variable that points Claude at that
 * store, and a ferret that is handed it can read the sign-in from a fresh agent home. Real Logins daemon half, real
 * kernel roots over a temporary FY_HOME, a fake `.credentials.json` with fake values, no network.
 *
 * Why one variable is enough on both platforms: Claude's store is `<CLAUDE_SECURESTORAGE_CONFIG_DIR>/.credentials.json`
 * on Linux and, on macOS, a keychain item whose name is a hash of that same directory string. The agent home
 * (`CLAUDE_CONFIG_DIR`) is a fresh folder either way, so without the variable Claude looks in the wrong place. The launch
 * keeps the real HOME, which macOS needs to find the login keychain. Only the Linux file is exercised here.
 */

const NOW = Date.parse('2026-10-16T09:00:00Z');
const TOKEN = 'oauth-access-TESTONLY-launch-env';
const REFRESH = 'refresh-TESTONLY-launch-env';
const admission = standInAdmission(() => owner());
const tempHomes: string[] = [];
afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

const claudeCredential = () => ({
  claudeAiOauth: { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: NOW + 3_600_000 },
});

async function boot(logins: Record<string, unknown>) {
  const fyHome = await mkdtemp(join(tmpdir(), 'logins-launch-env-'));
  tempHomes.push(fyHome);
  const base = join(fyHome, 'state', 'logins', 'credentials');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const roots: RootsPort = rootsPortFor(
    nodeFs(() => 'fixture'),
    { home: fyHome, plugin: 'logins', worktrees: `${fyHome}-worktrees` },
    ['credentials'],
    () => undefined,
  );
  const put = async (path: string, value: unknown) => {
    const target = join(base, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, JSON.stringify(value), { mode: 0o600 });
  };
  const daemon = buildLoginsDaemon();
  let kind: LoginKind | undefined;
  const wired = implementDaemon(daemon.manifest, {
    build: context => {
      if (daemon.build === undefined) throw new Error('missing build');
      const half = daemon.build({ ...context, kernel: { ...context.kernel, roots } });
      kind = half.hooks['logins:anthropic'];
      return half;
    },
  });
  const host = await testHost({
    plugins: [wired],
    fakes: { vault: emptyVault() },
    config: { logins },
    gate: admission,
    clock: fixedClock(instantFromEpochMs(NOW)),
  });
  const anthropic = (): LoginKind => {
    if (kind === undefined) throw new Error('the anthropic kind was not provided');
    return kind;
  };
  return { host, base, fyHome, put, anthropic };
}

/** A stand-in for Claude's documented store rule: the secure-storage variable if set, else the config dir. */
const STUB = [
  'import { existsSync } from "node:fs";',
  'const store = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? "";',
  'process.exit(store !== "" && existsSync(`${store}/.credentials.json`) ? 0 : 1);',
  '',
].join('\n');

async function stubReads(env: Record<string, string>): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'fy-claude-stub-'));
  tempHomes.push(dir);
  const script = join(dir, 'claude-stub.ts');
  await writeFile(script, STUB);
  const child = Bun.spawn([process.execPath, script], { env, stdout: 'ignore', stderr: 'ignore' });
  return await child.exited;
}

test('a signed-in Ferretry-kept Claude login launches with exactly its store variable, and a fresh agent home reads it', async () => {
  const f = await boot({ work: { harness: 'claude-code', store: 'ferretry' } });
  try {
    await f.put('work/.credentials.json', claudeCredential());

    const answered = await f.anthropic().launchEnvironment?.('work', 'claude-code');

    const store = join(f.base, 'work');
    expect(answered).toEqual({ ok: true, value: { CLAUDE_SECURESTORAGE_CONFIG_DIR: store } });
    // The login file declares no env, and the variable is not smuggled through it.
    expect(await f.anthropic().env('work', 'claude-code')).toEqual({});
    // A fresh agent home (what a ferret has) reads the sign-in only because the variable is set.
    const agentHome = join(f.fyHome, 'state', 'claude-code', 'agent-homes', 'fern');
    await mkdir(agentHome, { recursive: true });
    expect(await stubReads({ CLAUDE_CONFIG_DIR: agentHome, CLAUDE_SECURESTORAGE_CONFIG_DIR: store })).toBe(0);
    // Positive control: the same launch without the variable is signed out.
    expect(await stubReads({ CLAUDE_CONFIG_DIR: agentHome })).toBe(1);
    expect(JSON.stringify(answered)).not.toContain(TOKEN);
  } finally {
    await f.host.stop();
  }
});

test('a Ferretry-kept Claude login nobody signed in to refuses with a sentence instead of launching signed out', async () => {
  const f = await boot({ work: { harness: 'claude-code', store: 'ferretry' } });
  try {
    const answered = await f.anthropic().launchEnvironment?.('work', 'claude-code');

    expect(answered?.ok).toBe(false);
    if (answered === undefined || answered.ok) return;
    expect(answered.error).toContain('the login work is not signed in');
    expect(answered.error).toContain('so the ferret was not started');
    expect(answered.error).not.toContain(TOKEN);
  } finally {
    await f.host.stop();
  }
});

test('the Codex half of the same kind adds no variable here', async () => {
  const f = await boot({ work: { harness: 'claude-code', store: 'ferretry' } });
  try {
    await f.put('work/.credentials.json', claudeCredential());

    expect(await f.anthropic().launchEnvironment?.('work', 'codex')).toEqual({ ok: true, value: {} });
  } finally {
    await f.host.stop();
  }
});

test('a host-kept Claude login never gets a store variable; this build cannot read it, so the start is refused in a sentence', async () => {
  const f = await boot({ mine: { harness: 'claude-code', store: 'host' } });
  try {
    const answered = await f.anthropic().launchEnvironment?.('mine', 'claude-code');

    // Never a variable (a host store is the person's own default store, which a launch must not name) and no pane is
    // started signed out on a store this build cannot read.
    expect(answered).toEqual({
      ok: false,
      error:
        'the login mine is not signed in (This login cannot be reached on this machine.), so the ferret was not started',
    });
  } finally {
    await f.host.stop();
  }
});
