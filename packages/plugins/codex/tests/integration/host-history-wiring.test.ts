/**
 * `hostHistory` through the REGISTERED wiring: `daemon.build` over the kernel's REAL config service (a real
 * `ConfigPort`, so a broken file keeps answering its last good value exactly as production does), real kernel roots over a
 * fake owner home in a temp dir (never the real `~/.codex`), no network. Proves: a copy-on-link succeeds with the switch
 * ON (no doubled `sessions/` folder); OFF, neither the copy nor the listing asks for the owner's folder; and an invalid or
 * unreadable `harness-codex.yaml` reads as OFF (fail closed), for new and already issued sources alike.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Harness, HarnessHistorySource } from '@ferretry/core-ferrets/contract';
import type { KernelPorts } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor, state } from '@ferretry/kernel/host';
import { ensureInternalRootBases } from '../../../../core/kernel/host/roots.ts';
import { createConfigFiles } from '../../../../core/kernel/host/config/service.ts';
import { createMemoryHostFs } from '../../../../core/kernel/host/state/memory-fs.ts';
import { instantFromEpochMs } from '@ferretry/std';
import {
  CODEX_AGENT_HOMES,
  CODEX_CONFIG,
  CODEX_HISTORY_ENTRIES,
  CODEX_HISTORY_POOL,
  CODEX_ROLLOUTS,
} from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import manifest from '../../manifest.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const ID = '019fab95-c49a-7843-b42f-40a6390eefc3';
const RELATIVE = `sessions/2026/11/16/rollout-2026-11-16T09-00-00-${ID}.jsonl`;
const TEXT = `${JSON.stringify({
  timestamp: '2026-11-16T09:00:00.000Z',
  type: 'session_meta',
  payload: { id: ID, cwd: '/work/project' },
})}\n`;
const CONFIG = '/fy-config-home/config/harness-codex.yaml';
const SENTENCE =
  "harness-codex.yaml cannot be read, so Codex's conversations from this computer stay hidden until it is fixed.";

async function world(yaml: string | undefined) {
  const parent = await mkdtemp(join(tmpdir(), 'ferretry-codex-wiring-'));
  parents.push(parent);
  const home = join(parent, 'fy');
  const ownerHome = join(parent, 'owner');
  const owner = join(ownerHome, '.codex');
  await mkdir(join(owner, 'sessions/2026/11/16'), { recursive: true });
  await writeFile(join(owner, RELATIVE), TEXT);
  for (const folder of ['', 'state', 'state/codex', 'state/codex/agent-homes'])
    await mkdir(join(home, folder), { recursive: true, mode: 0o700 }).then(() => chmod(join(home, folder), 0o700));
  const pooling = {
    historyPool: { state: CODEX_HISTORY_POOL.name, entries: CODEX_HISTORY_ENTRIES },
    stateFiles: [CODEX_AGENT_HOMES, CODEX_HISTORY_POOL],
  };
  const fs = nodeFs(() => crypto.randomUUID());
  await ensureInternalRootBases(fs, { home, plugin: 'codex' }, ['agent-homes', 'harness-history'], pooling);
  const roots = rootsPortFor(
    fs,
    { home, plugin: 'codex', worktrees: join(parent, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
    { hardLinkRoots: [], ...pooling },
  );
  const asked: string[] = [];
  const spied = {
    ...roots,
    root: (name: string, scope?: { subfolder?: string }) => {
      asked.push(name);
      return (roots.root as (name: string, scope?: { subfolder?: string }) => unknown)(name, scope);
    },
  };

  // The kernel's REAL config service over an in-memory disk: the file the owner edits is `harness-codex.yaml`.
  const configFs = createMemoryHostFs();
  let unreadable = false;
  const failing = {
    ...configFs,
    info: async (path: string) => {
      if (unreadable && path.endsWith('harness-codex.yaml')) throw new Error('permission denied');
      return await configFs.info(path);
    },
  };
  const files = createConfigFiles({
    home: '/fy-config-home',
    fs: failing,
    clock: { nowMs: () => 0, after: () => () => undefined, every: () => () => undefined },
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    binary: 'fy',
    defs: [{ plugin: 'codex', def: CODEX_CONFIG as never }],
  });
  if (yaml !== undefined) configFs.seed(CONFIG, yaml);
  await files.reload();
  const config = files.port('codex');
  const setConfig = async (text: string | undefined) => {
    if (text !== undefined) configFs.seed(CONFIG, text);
    await files.reload();
  };

  const warnings: string[] = [];
  const kernel = {
    roots: spied,
    jobs: { add: () => undefined, kick: () => undefined },
    log: { warn: (message: string) => void warnings.push(message), info: () => undefined, error: () => undefined },
    state: state.createStatePort({
      home,
      pluginId: 'codex',
      files: [CODEX_ROLLOUTS],
      fs: state.createNodeHostFs(),
    }),
    config,
    spawn: {
      run: async (program: string, args: readonly string[]) => ({
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout: program === 'printenv' && args[0] === 'HOME' ? `${ownerHome}\n` : '',
      }),
    },
    redaction: { read: async (fn: (scope: { text(s: string): string }) => unknown) => await fn({ text: s => s }) },
    clock: {
      now: () => instantFromEpochMs(0),
      nowMs: () => 0,
      after: () => () => undefined,
      sleep: async () => undefined,
    },
  } as unknown as KernelPorts;
  const half = daemon.build?.({ manifest, kernel, uses: { runtimes: { current: () => undefined } } } as never);
  if (half === undefined) throw new Error('missing daemon half');
  const harness = half.hooks['harnesses:codex'] as Harness;
  const pool = (...parts: string[]) => join(home, 'state', 'codex', 'history-pool', ...parts);
  const computer = async (): Promise<HarnessHistorySource | undefined> =>
    (await harness.historySources?.())?.find(source => source.kind === 'computer');
  /** Whether the pool holds the copy (the pool folder itself is made only by a copy). */
  const copied = async () =>
    await readFile(pool(RELATIVE)).then(
      () => true,
      () => false,
    );
  const historyAsked = () => asked.filter(name => name === 'harness-history').length;
  return {
    harness,
    config,
    setConfig,
    pool,
    owner,
    computer,
    historyAsked,
    copied,
    warnings,
    breakDisk: (value: boolean) => {
      unreadable = value;
    },
  };
}

const importIt = (w: Awaited<ReturnType<typeof world>>) => w.harness.importConversation?.({ id: ID, source: RELATIVE });
const OFF = {
  ok: false,
  error: { reason: "Showing Codex's conversations from this computer is turned off." },
} as const;

describe('the switch ON, through the registered wiring', () => {
  test('a copy-on-link lands in the pool at the same relative path (no doubled sessions folder) and the original is untouched', async () => {
    const w = await world(undefined);
    expect(await importIt(w)).toEqual({ ok: true, value: undefined });
    expect(await readFile(w.pool(RELATIVE), 'utf8')).toBe(TEXT);
    expect(await w.copied()).toBe(true);
    expect(await readFile(join(w.owner, RELATIVE), 'utf8')).toBe(TEXT);
    expect(await readdir(w.pool('sessions'))).toEqual(['2026']);
    expect(await readdir(w.owner)).toEqual(['sessions']);
  });

  test('the legacy listing finds the owner’s conversation through the same wiring', async () => {
    const w = await world('hostHistory: true\n');
    expect(await w.harness.conversations.list(undefined)).toEqual([
      { id: ID, folder: '/work/project', updatedAt: expect.anything() },
    ]);
    expect((await (await w.computer())?.files.entries('sessions/2026/11/16'))?.map(entry => entry.name)).toEqual([
      `rollout-2026-11-16T09-00-00-${ID}.jsonl`,
    ]);
  });
});

describe('the switch OFF', () => {
  test('neither the copy nor the listing asks for the owner’s folder, and nothing is copied', async () => {
    const w = await world('hostHistory: false\n');
    expect(await importIt(w)).toEqual(OFF);
    expect(await w.harness.conversations.list(undefined)).toEqual([]);
    expect(await w.computer()).toBeUndefined();
    expect(w.historyAsked()).toBe(0);
    expect(await w.copied()).toBe(false);
    expect(await readFile(join(w.owner, RELATIVE), 'utf8')).toBe(TEXT);
  });

  test('turned off after the first look, the next copy and listing stop at once', async () => {
    const w = await world(undefined);
    expect((await w.harness.conversations.list(undefined)).length).toBe(1);
    const before = w.historyAsked();
    await w.setConfig('hostHistory: false\n');
    expect(await importIt(w)).toEqual(OFF);
    expect(await w.harness.conversations.list(undefined)).toEqual([]);
    expect(w.historyAsked()).toBe(before);
    expect(await w.copied()).toBe(false);
  });
});

describe('a setting that cannot be trusted fails closed', () => {
  const broken = [
    ['YAML that does not parse', 'hostHistory: [unclosed\n'],
    ['a value of the wrong kind', 'hostHistory: maybe\n'],
  ] as const;

  for (const [name, text] of broken)
    test(`${name} after a good ON file: off for the copy and the listing, though the config port still answers the last good value`, async () => {
      const w = await world('hostHistory: true\n');
      await w.setConfig(text);
      // The live port keeps answering the last accepted file, which is why `file` alone would have left this ON.
      expect((w.config.file(CODEX_CONFIG as never) as { hostHistory?: boolean } | undefined)?.hostHistory).toBe(true);
      expect(w.config.fileState(CODEX_CONFIG as never).state).toBe('invalid');
      expect(await importIt(w)).toEqual(OFF);
      expect(await w.harness.conversations.list(undefined)).toEqual([]);
      expect(await w.computer()).toBeUndefined();
      expect(w.historyAsked()).toBe(0);
      expect(await w.copied()).toBe(false);
      expect(w.warnings).toEqual([SENTENCE]);
    });

  test('a file that was never good (default on) and is now broken is off too', async () => {
    const w = await world('hostHistory: [unclosed\n');
    expect(await importIt(w)).toEqual(OFF);
    expect(await w.harness.conversations.list(undefined)).toEqual([]);
    expect(w.historyAsked()).toBe(0);
  });

  test('a file that cannot be read from the disk is off', async () => {
    const w = await world('hostHistory: true\n');
    w.breakDisk(true);
    await w.setConfig(undefined);
    expect(w.config.fileState(CODEX_CONFIG as never).state).toBe('invalid');
    expect(await importIt(w)).toEqual(OFF);
    expect(await w.harness.conversations.list(undefined)).toEqual([]);
    expect(w.historyAsked()).toBe(0);
  });

  test('an already issued source answers nothing once the file breaks, and reads again when it is fixed', async () => {
    const w = await world('hostHistory: true\n');
    const issued = await w.computer();
    if (issued === undefined) throw new Error('the owner source is offered while the switch is on');
    const path = RELATIVE;
    expect((await issued.files.stat(path))?.size).toBe(TEXT.length);
    await w.setConfig('hostHistory: [unclosed\n');
    expect(await issued.files.entries('sessions/2026/11/16')).toEqual([]);
    expect(await issued.files.stat(path)).toBeUndefined();
    expect(await issued.files.read(path, 0, 10)).toBeUndefined();
    await w.setConfig('hostHistory: true\n');
    expect((await issued.files.stat(path))?.size).toBe(TEXT.length);
  });

  test('the warning is said once per break, never the file’s text', async () => {
    const w = await world('hostHistory: true\n');
    await w.setConfig('hostHistory: [unclosed\n');
    await importIt(w);
    await importIt(w);
    await w.harness.conversations.list(undefined);
    expect(w.warnings).toEqual([SENTENCE]);
  });
});
