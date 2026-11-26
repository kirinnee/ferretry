import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
  THIRD_HARNESS_KEY,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/**
 * A start that names no runtime, login or harness lands on Claude Code when it is installed, whatever order the plugin
 * graph registers harnesses in: turning another harness plugin on must never change which harness an unqualified start
 * picks. A harness stands in for any later-registered plugin; fixture values only.
 */

function fixture(keys: readonly string[]) {
  const registry = new FerretRegistry([]);
  const harnesses = new Map(keys.map(key => [key, new FakeHarness(key, `/fixture-fy/state/${key}/agent-homes`)]));
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => ferretId('one'),
    newName: taken => {
      for (let n = 1; ; n += 1) if (!taken(`fern${n}`)) return `fern${n}`;
    },
    save: async () => {},
    saveTokens: async () => {},
    harness: key => harnesses.get(key),
    harnessKeys: () => [...harnesses.keys()],
    runner: () => new FakeRunner(),
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  return { registry, service: new FerretsService(registry, new FerretTokenDirectory(), ports) };
}

describe('the harness an unqualified start picks', () => {
  test('is claude-code even when another harness is registered before it', async () => {
    const f = fixture([THIRD_HARNESS_KEY, 'claude-code', 'codex']);

    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(f.registry.get(started.value)?.harness).toBe('claude-code');
  });

  test('is the harness a start names, even one registered first', async () => {
    const f = fixture([THIRD_HARNESS_KEY, 'claude-code', 'codex']);

    const started = await f.service.start({ folder: '/work', by: 'owner', harness: THIRD_HARNESS_KEY }, PERSON_ORIGIN);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(f.registry.get(started.value)?.harness).toBe(THIRD_HARNESS_KEY);
  });

  test('is the first registered harness only when claude-code is not installed at all', async () => {
    const f = fixture(['codex', THIRD_HARNESS_KEY]);

    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(f.registry.get(started.value)?.harness).toBe('codex');
  });
});
