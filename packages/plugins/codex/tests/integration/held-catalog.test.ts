import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock, FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { bunSpawn } from '@ferretry/kernel/host';
import { instantFromEpochMs, ok } from '@ferretry/std';
import { HeldCatalogSchema, type HeldCatalogFile } from '../../contract/index.ts';
import { CodexAppServerCatalog } from '../../daemon/adapters/app-server-catalog.ts';
import { HeldFastCatalog, STALE_AFTER_MS, type HeldFastCatalogPorts } from '../../daemon/adapters/held-catalog.ts';
import { catalogSpawn, type Started } from '../support/catalog-child.ts';

/**
 * The Codex catalog a fast start is judged against is HELD: kept on disk (the model list only), read by a child that has
 * its OWN created folder and a scrubbed environment with a throwaway HOME, never the daemon user's real HOME (and so
 * never `~/.codex`), and read again only when a fast start finds the held copy missing or older than five minutes.
 *
 * NOT VERIFIED HERE (needs the real binary, so no unit test can): that `codex app-server` answers `model/list` with no
 * login at all. The fake child below answers because the test says so.
 */

const DAEMON_HOME = '/home/the-daemon-user';
const temps: string[] = [];
afterAll(async () => {
  for (const path of temps) await rm(path, { recursive: true, force: true });
});

const clock: Clock = {
  now: () => instantFromEpochMs(0),
  nowMs: () => 0,
  after: () => () => undefined,
  every: () => () => undefined,
  sleep: async () => undefined,
};

/** A workspace root backed by a real temp folder, so "the folder exists" is a fact about the disk. */
async function workspace(): Promise<{ readonly root: RootHandle; readonly base: string }> {
  const base = await mkdtemp(join(tmpdir(), 'fy-held-catalog-'));
  temps.push(base);
  const root = {
    resolve: (relative: string) => ok(join(base, relative) as FencedPath),
    makeDirectory: async (path: FencedPath) => {
      await mkdir(path, { recursive: true });
    },
  } as unknown as RootHandle;
  return { root, base };
}

const SOL = {
  value: 'gpt-6-sol',
  label: 'GPT-6-Sol',
  reasoningEfforts: [{ value: 'medium' }],
  defaultReasoningEffort: 'medium',
  fast: false,
};
/** An `openai` catalog model as the fallback restates it: no `fast` field, because the catalog says nothing about tiers. */
const FALLBACK = {
  value: 'gpt-fallback',
  label: 'GPT Fallback',
  tier: 'balanced' as const,
  isDefault: true as const,
  reasoningEfforts: [{ value: 'medium' }],
};
const persisted = (readAtMs: number, value = 'gpt-persisted'): HeldCatalogFile => ({
  format: 1,
  readAt: instantFromEpochMs(readAtMs),
  choices: [{ ...SOL, value, label: 'Persisted', fast: false }],
});

interface Subject {
  readonly catalog: HeldFastCatalog;
  readonly base: string;
  readonly saved: HeldCatalogFile[];
  readonly warnings: string[];
  readonly refreshes: { count: number };
  readonly now: { ms: number };
}

async function subject(
  started: Started[],
  more: {
    readonly disk?: HeldCatalogFile;
    readonly read?: HeldFastCatalogPorts['read'];
    readonly spawn?: ReturnType<typeof catalogSpawn>;
    readonly fallback?: HeldFastCatalogPorts['fallback'];
  } = {},
): Promise<Subject> {
  const { root, base } = await workspace();
  const appServer = new CodexAppServerCatalog({
    spawn: more.spawn ?? catalogSpawn(started),
    clock,
    clientName: 'ferretry',
    clientVersion: '0.0.0-test',
  });
  const saved: HeldCatalogFile[] = [];
  const warnings: string[] = [];
  const refreshes = { count: 0 };
  const now = { ms: 0 };
  const catalog = new HeldFastCatalog({
    workspace: root,
    environment: async name => (name === 'PATH' ? '/usr/bin' : 'C.UTF-8'),
    locate: async () =>
      ({ outcome: 'located', path: '/opt/codex/bin/codex', rule: 'inherited path', declaredBy: 'PATH' }) as never,
    read: more.read ?? (async (binary, cwd, env, signal) => await appServer.models(binary, cwd, env, signal)),
    nowMs: () => now.ms,
    now: () => instantFromEpochMs(now.ms),
    fallback: more.fallback ?? (async () => undefined),
    load: async () => more.disk,
    save: async file => {
      saved.push(file);
    },
    requestRefresh: () => {
      refreshes.count += 1;
    },
    warn: message => {
      warnings.push(message);
    },
  });
  return { catalog, base, saved, warnings, refreshes, now };
}

describe('the held Codex catalog', () => {
  test('(no guarantees row) nothing is held before the first read, and holding never spawns', async () => {
    const started: Started[] = [];
    const { catalog } = await subject(started);
    await catalog.loaded();
    expect(catalog.held()).toBeUndefined();
    expect(started).toHaveLength(0);
  });

  test("(no guarantees row) the child's cwd exists when it starts, and it is inside the plugin's own folder", async () => {
    const started: Started[] = [];
    const { catalog, base } = await subject(started);
    await catalog.refresh();
    expect(started).toHaveLength(1);
    expect(started[0]?.cwd?.startsWith(base)).toBe(true);
    expect(await started[0]?.cwdExisted).toBe(true);
  });

  test("(no guarantees row) O8-4 the child's CODEX_HOME exists when it starts: a real codex app-server refuses to start without it", async () => {
    const started: Started[] = [];
    const { catalog, base } = await subject(started);
    await catalog.refresh();
    const codexHome = started[0]?.env?.CODEX_HOME;
    expect(codexHome?.startsWith(base)).toBe(true);
    expect((await stat(codexHome ?? '/nowhere')).isDirectory()).toBe(true);
  });

  test("(no guarantees row) the child's HOME is a throwaway inside the plugin's folder, never the daemon's HOME", async () => {
    const started: Started[] = [];
    const { catalog, base } = await subject(started);
    await catalog.refresh();
    const env = started[0]?.env;
    expect(env).toBeDefined();
    expect(env?.HOME?.startsWith(base)).toBe(true);
    expect(env?.CODEX_HOME?.startsWith(base)).toBe(true);
    // The whole environment is the scrubbed one: nothing of the daemon's own beyond PATH and LANG.
    expect(Object.keys(env ?? {}).sort()).toEqual(
      [
        'ALL_PROXY',
        'CI',
        'CODEX_HOME',
        'HOME',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'LANG',
        'NO_PROXY',
        'PATH',
        'TMPDIR',
        'all_proxy',
        'http_proxy',
        'https_proxy',
      ].sort(),
    );
  });

  test("(no guarantees row) the REAL spawn, whose own base environment carries the daemon's HOME, gives the child the throwaway HOME", async () => {
    // Not a fake: the kernel's own `bunSpawn` merges `{ PATH, HOME: <daemon's> }` under the caller's env, exactly as the
    // daemon does. A "codex" that only writes down the HOME it was given proves what a child really sees; if the held
    // catalog stopped passing its env, the file would say DAEMON_HOME and this would fail.
    const { root, base } = await workspace();
    const binary = join(base, 'fake-codex');
    await writeFile(binary, '#!/bin/sh\nprintf "%s" "$HOME" > "$PWD/home.seen"\nexit 0\n');
    await chmod(binary, 0o755);
    const real = new CodexAppServerCatalog({
      spawn: bunSpawn({ PATH: '/usr/bin:/bin', HOME: DAEMON_HOME }),
      clock: { ...clock, after: () => () => undefined, sleep: async () => undefined },
      clientName: 'ferretry',
      clientVersion: '0.0.0-test',
      timeoutMs: 2_000,
    });
    const catalog = new HeldFastCatalog({
      workspace: root,
      environment: async name => (name === 'PATH' ? '/usr/bin:/bin' : 'C.UTF-8'),
      locate: async () => ({ outcome: 'located', path: binary }) as never,
      read: async (program, cwd, env, signal) => await real.models(program, cwd, env, signal),
      nowMs: () => 0,
      now: () => instantFromEpochMs(0),
      load: async () => undefined,
      save: async () => undefined,
      fallback: async () => undefined,
      requestRefresh: () => undefined,
      warn: () => undefined,
    });
    await catalog.refresh();
    const seen = await readFile(join(base, 'work', 'home.seen'), 'utf8');
    expect(seen).not.toBe(DAEMON_HOME);
    expect(seen.startsWith(base)).toBe(true);
  });

  test('(no guarantees row) a read that works is held and kept on disk, as the model list only', async () => {
    const started: Started[] = [];
    const { catalog, saved } = await subject(started);
    await catalog.refresh();
    expect(catalog.held()?.map(choice => choice.value)).toEqual(['gpt-6-sol']);
    expect(saved).toHaveLength(1);
    // What is written loads back through the plugin's own schema, and holds nothing but the list.
    const written = HeldCatalogSchema.parse(JSON.parse(JSON.stringify(saved[0])));
    expect(Object.keys(written).sort()).toEqual(['choices', 'format', 'readAt']);
    expect(JSON.stringify(written)).not.toContain('/');
  });

  test('(no guarantees row) a catalog on disk is held from the start, and a read that already landed is not replaced by it', async () => {
    const started: Started[] = [];
    const { catalog } = await subject(started, { disk: persisted(0) });
    expect(catalog.held()).toBeUndefined();
    await catalog.loaded();
    expect(catalog.held()?.map(choice => choice.value)).toEqual(['gpt-persisted']);
    expect(started).toHaveLength(0);

    const raced = await subject(started, { disk: persisted(0) });
    await raced.catalog.refresh();
    await raced.catalog.loaded();
    expect(raced.catalog.held()?.map(choice => choice.value)).toEqual(['gpt-6-sol']);
  });

  test('(no guarantees row) a failed read keeps what was held', async () => {
    const started: Started[] = [];
    let fail = false;
    const { catalog } = await subject(started, {
      read: async () => {
        if (fail) throw new Error('the Codex model catalog probe timed out');
        return [SOL];
      },
    });
    await catalog.refresh();
    fail = true;
    await catalog.refresh();
    expect(catalog.held()?.map(choice => choice.value)).toEqual(['gpt-6-sol']);
  });

  test('(no guarantees row) no Codex binary located reads nothing and holds nothing', async () => {
    const { root } = await workspace();
    let reads = 0;
    const catalog = new HeldFastCatalog({
      workspace: root,
      environment: async () => undefined,
      locate: async () => ({ outcome: 'absent' }) as never,
      read: async () => {
        reads += 1;
        return [];
      },
      nowMs: () => 0,
      now: () => instantFromEpochMs(0),
      load: async () => undefined,
      save: async () => undefined,
      fallback: async () => undefined,
      requestRefresh: () => undefined,
      warn: () => undefined,
    });
    expect(catalog.binaryMissing()).toBe(false);
    await catalog.refresh();
    expect(reads).toBe(0);
    expect(catalog.held()).toBeUndefined();
    expect(catalog.binaryMissing()).toBe(true);
  });

  test('(no guarantees row) r3 LOW-C a binary found on a later read clears the missing mark', async () => {
    const { root } = await workspace();
    let found = false;
    const catalog = new HeldFastCatalog({
      workspace: root,
      environment: async () => undefined,
      locate: async () =>
        (found ? { outcome: 'located', path: '/opt/codex/bin/codex' } : { outcome: 'absent' }) as never,
      read: async () => [SOL],
      nowMs: () => 0,
      now: () => instantFromEpochMs(0),
      load: async () => undefined,
      save: async () => undefined,
      fallback: async () => undefined,
      requestRefresh: () => undefined,
      warn: () => undefined,
    });
    await catalog.refresh();
    expect(catalog.binaryMissing()).toBe(true);
    found = true;
    await catalog.refresh();
    expect(catalog.binaryMissing()).toBe(false);
    expect(catalog.held()).toHaveLength(1);
  });

  test('(no guarantees row) a fast start asks for a read only when nothing is held or the held copy is older than five minutes', async () => {
    const started: Started[] = [];
    const s = await subject(started, { disk: persisted(0) });
    // Nothing held yet: ask.
    s.catalog.refreshIfStale();
    expect(s.refreshes.count).toBe(1);
    await s.catalog.loaded();
    // Held and fresh: do not ask.
    s.now.ms = STALE_AFTER_MS;
    s.catalog.refreshIfStale();
    expect(s.refreshes.count).toBe(1);
    // Held and stale: ask, and the answer is still the held copy.
    s.now.ms = STALE_AFTER_MS + 1;
    s.catalog.refreshIfStale();
    expect(s.refreshes.count).toBe(2);
    expect(s.catalog.held()?.map(choice => choice.value)).toEqual(['gpt-persisted']);
    expect(started).toHaveLength(0);
  });

  test('(no guarantees row) a read already running is not asked for again, and two refreshes share one child', async () => {
    const started: Started[] = [];
    const s = await subject(started);
    const first = s.catalog.refresh();
    s.catalog.refreshIfStale();
    expect(s.refreshes.count).toBe(0);
    await Promise.all([first, s.catalog.refresh()]);
    expect(started).toHaveLength(1);
  });

  test('(no guarantees row) a read that keeps failing is warned about once, and again only after it worked in between', async () => {
    const started: Started[] = [];
    let fail = true;
    const s = await subject(started, {
      read: async () => {
        if (fail) throw new Error('boom');
        return [SOL];
      },
    });
    await s.catalog.refresh();
    await s.catalog.refresh();
    await s.catalog.refresh();
    expect(s.warnings).toHaveLength(1);
    // The child's own reason is in the warning, so the log says what to fix.
    expect(s.warnings[0]).toBe(
      'the Codex model catalog could not be read (boom); fast starts on Codex are refused until it can be read (next try in 1 min)',
    );
    fail = false;
    await s.catalog.refresh();
    fail = true;
    await s.catalog.refresh();
    expect(s.warnings).toHaveLength(2);
  });

  test('U0 a failing read logs its cause once, masked', async () => {
    const started: Started[] = [];
    const s = await subject(started, {
      read: async () => {
        throw new Error(
          'GET https://user:hunter2@api.example/v1/models failed: Authorization: Bearer sk-abcdef123456 token=abc.def',
        );
      },
      fallback: async () => [FALLBACK],
    });
    await s.catalog.loaded();
    await s.catalog.refresh();
    await s.catalog.refresh();
    expect(s.warnings).toHaveLength(1);
    const line = s.warnings[0] ?? '';
    expect(line).toContain('could not be read (GET https://***@api.example/v1/models failed');
    expect(line).toContain('refused until it can be read');
    for (const secret of ['hunter2', 'sk-abcdef123456', 'abc.def']) expect(line).not.toContain(secret);
  });

  test('U0 with nothing held, the openai catalog is known as fallbackChoices(); held() stays real-only and a read that lands takes over', async () => {
    const started: Started[] = [];
    let fail = true;
    const s = await subject(started, {
      read: async () => {
        if (fail) throw new Error('boom');
        return [SOL];
      },
      fallback: async () => [FALLBACK],
    });
    await s.catalog.loaded();
    expect(s.catalog.held()).toBeUndefined();
    expect(s.catalog.fallbackChoices()?.map(choice => choice.value)).toEqual(['gpt-fallback']);
    await s.catalog.refresh();
    expect(s.catalog.held()).toBeUndefined();
    expect(s.catalog.fallbackChoices()?.map(choice => choice.value)).toEqual(['gpt-fallback']);
    fail = false;
    await s.catalog.refresh();
    expect(s.catalog.held()?.map(choice => choice.value)).toEqual(['gpt-6-sol']);
  });

  test('U0 with no openai catalog in effect, fallbackChoices() is nothing', async () => {
    const started: Started[] = [];
    const s = await subject(started);
    await s.catalog.loaded();
    expect(s.catalog.fallbackChoices()).toBeUndefined();
  });

  test('U0 a failing read is not asked for again until 1 minute, then 5, then 30, and a read that works resets it', async () => {
    const started: Started[] = [];
    let fail = true;
    const s = await subject(started, {
      read: async () => {
        if (fail) throw new Error('boom');
        return [SOL];
      },
    });
    const ask = async (at: number): Promise<number> => {
      s.now.ms = at;
      s.catalog.refreshIfStale();
      return s.refreshes.count;
    };
    expect(await ask(0)).toBe(1);
    await s.catalog.refresh(); // fails at 0: next ask no sooner than 60 s
    expect(await ask(59_999)).toBe(1);
    expect(await ask(60_000)).toBe(2);
    s.now.ms = 60_000;
    await s.catalog.refresh(); // fails again: 5 minutes
    expect(await ask(359_999)).toBe(2);
    expect(await ask(360_000)).toBe(3);
    s.now.ms = 360_000;
    await s.catalog.refresh(); // fails a third time: 30 minutes
    expect(await ask(360_000 + 1_799_999)).toBe(3);
    expect(await ask(360_000 + 1_800_000)).toBe(4);
    s.now.ms = 360_000 + 1_800_000;
    await s.catalog.refresh(); // fails a fourth time: stays at 30 minutes
    expect(await ask(360_000 + 3_599_999)).toBe(4);
    fail = false;
    s.now.ms = 360_000 + 3_600_000;
    await s.catalog.refresh(); // works: the wait is gone
    s.now.ms += STALE_AFTER_MS + 1;
    s.catalog.refreshIfStale();
    expect(s.refreshes.count).toBe(5);
  });

  test('U0 a missing binary backs off too, so a fast start does not spawn a lookup every time', async () => {
    const started: Started[] = [];
    const s = await subject(started, {});
    const missing = new HeldFastCatalog({
      workspace: {} as unknown as RootHandle,
      environment: async () => undefined,
      locate: async () => ({ outcome: 'absent', searched: [] }),
      read: async () => [],
      nowMs: () => s.now.ms,
      now: () => instantFromEpochMs(s.now.ms),
      fallback: async () => undefined,
      load: async () => undefined,
      save: async () => undefined,
      requestRefresh: () => {
        s.refreshes.count += 1;
      },
      warn: () => undefined,
    });
    missing.refreshIfStale();
    await missing.refresh();
    missing.refreshIfStale();
    expect(s.refreshes.count).toBe(1);
    s.now.ms = 60_000;
    missing.refreshIfStale();
    expect(s.refreshes.count).toBe(2);
  });

  test('(no guarantees row) a stop signal ends a running read and kills its child', async () => {
    const started: Started[] = [];
    const s = await subject(started, { spawn: catalogSpawn(started, { answers: false }) });
    const stop = new AbortController();
    const running = s.catalog.refresh(stop.signal);
    // Let the child start, then stop the job.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(started).toHaveLength(1);
    stop.abort();
    await running;
    expect(started[0]?.kills).toBeGreaterThan(0);
    expect(s.catalog.held()).toBeUndefined();
    expect(s.saved).toHaveLength(0);
  });
});
