/**
 * C59 O1: a tool installed (or removed) while the daemon runs is seen by the NEXT read, with no restart.
 *
 * The read the UI makes (`inEffect`, behind `GET /v1/fleet/runtimes`, `/machine`, `/components`, `/profiles`) answers
 * `tools.claude` / `tools.codex` from the `CommandCache`, and that cache is only filled by a `prime`. `prime` used to
 * run only inside `load()` (boot, a config change, an apply), so every later read answered what boot saw. These tests
 * use a real temp directory as the whole `PATH`, the real cache and the real evaluator, wired the way
 * `host-assembly.ts` wires them. No network, no real home.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ConfigCollectionDef } from '@ferretry/kernel/contract';
import { CommandCache } from '../../../daemon/adapters/command-cache.ts';
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
