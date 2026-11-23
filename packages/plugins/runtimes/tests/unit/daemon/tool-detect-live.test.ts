/**
 * C59 O1: a tool installed (or removed) while the daemon runs is seen by the NEXT read, with no restart.
 *
 * The read the UI makes (`inEffect`, behind `GET /v1/fleet/runtimes`, `/machine`, `/components`, `/profiles`) answers
 * `tools.claude` / `tools.codex` from the `CommandCache`, and that cache is only filled by a `prime`. `prime` used to
 * run only inside `load()` (boot, a config change, an apply), so every later read answered what boot saw. These tests
 * use a real temp directory as the whole `PATH`, the real cache and the real evaluator, wired the way
 * `host-assembly.ts` wires them. No network, no real home.
 */
import { memoryPins, TEST_MODEL_SOURCES } from '../../support/starters.ts';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ConfigCollectionDef } from '@ferretry/kernel/contract';
import { harnessFallbackDirectories } from '../../../contract/index.ts';
import { CommandCache } from '../../../daemon/adapters/command-cache.ts';
import { harnessAwareWhich } from '../../../daemon/adapters/harness-lookup.ts';
import { fleetSetupRoutes } from '../../../daemon/routes/fleet-setup.ts';
import type { ComponentSourceLookup } from '../../../daemon/adapters/profile-components.ts';
import { runtimesConfigFiles } from '../../../daemon/adapters/runtimes-config-files.ts';

const EMPTY_OWNERS: ComponentSourceLookup = () => ({ list: async () => [], read: async () => undefined });
const HARNESS_COMMANDS = ['claude', 'codex'] as const;
/** The cache's own window is ten seconds; a clock that moves past it stands in for "the owner looks again later". */
const PAST_THE_WINDOW_MS = 11_000;

let binDirectory = '';

beforeEach(() => {
  binDirectory = mkdtempSync(join(tmpdir(), 'fy-tool-detect-'));
});
afterEach(() => {
  rmSync(binDirectory, { recursive: true, force: true });
});

const drop = (name: string): string => {
  const path = join(binDirectory, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
};

/** The evaluator over the real cache, whose lookup is `Bun.which` on the temp directory alone. */
function daemon() {
  const clock = { now: 0 };
  const commands = new CommandCache(
    { which: async name => Bun.which(name, { PATH: binDirectory }) ?? undefined },
    () => clock.now,
  );
  const files = runtimesConfigFiles({
    pins: memoryPins(),
    config: {
      collection: (_def: ConfigCollectionDef<unknown>) => new Map(),
      file: () => undefined,
    } as never,
    logins: {
      list: async () => ({
        format: 1 as const,
        machine: 'm',
        logins: [sampleLogin('claude-you', { store: 'ferretry' })],
      }),
      environmentTemplates: async () => [],
      modelSources: async () => TEST_MODEL_SOURCES,
    },
    components: EMPTY_OWNERS,
    within: work => work,
    prime: async () => {
      await commands.prime(HARNESS_COMMANDS);
    },
  });
  return { files, commands, later: () => (clock.now += PAST_THE_WINDOW_MS) };
}

describe('a tool installed or removed while the daemon runs (C59 O1)', () => {
  it('finds a claude and a codex dropped on PATH after boot, on the next read, without a restart', async () => {
    const { files, commands, later } = daemon();
    await files.load(); // boot: neither is installed
    expect(commands.which('claude')).toBeUndefined();
    expect(commands.which('codex')).toBeUndefined();

    const claude = drop('claude');
    const codex = drop('codex');
    later();
    await files.inEffect(); // what every catalogue read does

    expect(commands.which('claude')).toBe(claude);
    expect(commands.which('codex')).toBe(codex);
  });

  it('stops finding a tool that was removed, on the next read', async () => {
    const { files, commands, later } = daemon();
    drop('claude');
    await files.load();
    expect(commands.which('claude')).toBeDefined();

    rmSync(join(binDirectory, 'claude'));
    later();
    await files.inEffect();

    expect(commands.which('claude')).toBeUndefined();
  });

  it('does not look again inside the window, so a burst of reads costs one lookup', async () => {
    const { files, commands } = daemon();
    await files.load();
    drop('claude');

    await files.inEffect();
    await files.inEffect();

    expect(commands.which('claude')).toBeUndefined();
  });
});

// ── C59 O1 (review of 2293): a tool installed into a folder the daemon's PATH never listed ─────────────────────────────

/**
 * The kernel's lookup, as `whichCommand` does it: the caller's `directories` first, then PATH, first executable wins.
 * PATH is the one fixed (empty) folder for the whole test, like a daemon whose PATH was captured at boot.
 */
const kernelWhich =
  (path: string) =>
  async (name: string, options?: { readonly directories?: readonly string[] }): Promise<string | undefined> =>
    Bun.which(name, { PATH: [...(options?.directories ?? []), path].join(':') }) ?? undefined;

/** A real temp HOME; `.local/bin` is created later, by the test, the way an installer creates it. */
function lookup(platformName = 'linux') {
  const home = mkdtempSync(join(tmpdir(), 'fy-tool-home-'));
  const clock = { now: 0 };
  const commands = new CommandCache(
    {
      which: harnessAwareWhich({
        which: kernelWhich(binDirectory),
        home: () => home,
        platform: { name: () => platformName, prime: async () => {} },
      }),
    },
    () => clock.now,
  );
  return { home, commands, clock };
}

const install = (home: string, relative: string, name: string): string => {
  const folder = join(home, relative);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
};

describe('claude and codex in the folders their installers write to, PATH held fixed (C59 O1 review)', () => {
  it('finds a tool dropped into a ~/.local/bin created after boot, and loses it when removed', async () => {
    const { home, commands, clock } = lookup();
    try {
      await commands.prime(HARNESS_COMMANDS);
      expect(commands.which('claude')).toBeUndefined();

      const claude = install(home, '.local/bin', 'claude');
      const codex = install(home, '.npm-global/bin', 'codex');
      clock.now += PAST_THE_WINDOW_MS;
      await commands.prime(HARNESS_COMMANDS);
      expect(commands.which('claude')).toBe(claude);
      expect(commands.which('codex')).toBe(codex);

      rmSync(claude);
      clock.now += PAST_THE_WINDOW_MS;
      await commands.prime(HARNESS_COMMANDS);
      expect(commands.which('claude')).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('"Check again" sees the tool at once, inside the ten-second window, because it looks past the cache', async () => {
    const { home, commands } = lookup();
    try {
      await commands.prime(HARNESS_COMMANDS);
      const claude = install(home, '.local/bin', 'claude');

      await commands.prime(HARNESS_COMMANDS); // an ordinary read, inside the window: the stale answer
      expect(commands.which('claude')).toBeUndefined();

      await commands.refresh(HARNESS_COMMANDS); // what `?fresh=1` does
      expect(commands.which('claude')).toBe(claude);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps PATH ahead of the install folders, and looks nothing else up there', async () => {
    const { home, commands } = lookup();
    try {
      const onPath = drop('claude');
      install(home, '.local/bin', 'claude');
      install(home, '.local/bin', 'npm');
      await commands.prime(['claude', 'npm']);

      expect(commands.which('claude')).toBe(onPath);
      expect(commands.which('npm')).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('searches /opt/homebrew/bin on macOS only', () => {
    const facts = { home: '/h', platform: 'linux' };
    expect(harnessFallbackDirectories(facts)).not.toContain('/opt/homebrew/bin');
    expect(harnessFallbackDirectories({ ...facts, platform: 'darwin' })).toContain('/opt/homebrew/bin');
  });

  it('is exactly the listed folders, in order, honouring XDG_STATE_HOME', () => {
    expect(harnessFallbackDirectories({ home: '/h', platform: 'linux' })).toEqual([
      '/h/.local/bin',
      '/h/.npm-global/bin',
      '/h/.bun/bin',
      '/h/.nix-profile/bin',
      '/h/.local/state/nix/profile/bin',
      '/usr/local/bin',
    ]);
    expect(harnessFallbackDirectories({ home: '/h', platform: 'linux', xdgStateHome: '/s' })).toContain(
      '/s/nix/profile/bin',
    );
    // A relative XDG value or no home is never searched against the working folder.
    expect(harnessFallbackDirectories({ home: '', platform: 'linux', xdgStateHome: 'rel' })).toEqual([
      '/usr/local/bin',
    ]);
  });
});

describe('GET /v1/runtimes/setup/scan?fresh=1 (C59 O1 review)', () => {
  const asked = async (query: Record<string, string>): Promise<unknown[]> => {
    const seen: unknown[] = [];
    const routes = fleetSetupRoutes({
      scan: async (options?: unknown) => {
        seen.push(options);
        throw new Error('stop here');
      },
    } as never);
    const call = { request: { query: new Map(Object.entries(query).map(([k, v]) => [k, [v]])) } } as never;
    await routes['GET /v1/runtimes/setup/scan'](call).catch(() => undefined);
    return seen;
  };

  it('asks for a fresh scan only when the page said so', async () => {
    expect(await asked({ fresh: '1' })).toEqual([{ fresh: true }]);
    expect(await asked({})).toEqual([{ fresh: false }]);
  });
});
