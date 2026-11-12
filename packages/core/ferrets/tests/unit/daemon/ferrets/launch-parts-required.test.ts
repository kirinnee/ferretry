import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import {
  type FerretRecord,
  type LaunchPart,
  type LaunchPartSource,
  LaunchPartsRefusal,
} from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/**
 * A REQUIRED `launch.parts` source (a login's pinned environment) that cannot answer refuses the launch with nothing
 * started; it is never skipped as an empty answer. A source that is only an addition is still skipped. Fixture values only.
 */

const SECRET = 'fixture-secret-value-0007';

const throwing = (error: Error, required: boolean): LaunchPartSource => ({
  ...(required ? { required: true } : {}),
  parts: async () => {
    throw error;
  },
});
const answering = (parts: readonly LaunchPart[]): LaunchPartSource => ({ parts: async () => parts });

function fixture(sources: readonly LaunchPartSource[], records: readonly FerretRecord[] = []) {
  const registry = new FerretRegistry(records);
  const tokens = new FerretTokenDirectory();
  const runner = new FakeRunner();
  const harness = new FakeHarness('claude-code', '/fixture-fy/state/claude-code/agent-homes');
  let next = 0;
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => {
      next += 1;
      return ferretId(`f${next}`);
    },
    newName: taken => {
      for (let n = 1; ; n += 1) if (!taken(`fern${n}`)) return `fern${n}`;
    },
    save: async () => {},
    saveTokens: async () => {},
    harness: key => (key === 'claude-code' ? harness : undefined),
    harnessKeys: () => ['claude-code'],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => sources,
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  return { registry, tokens, runner, harness, service: new FerretsService(registry, tokens, ports) };
}

const stopped = (id: string): FerretRecord => ({
  format: 1,
  id: ferretId(id),
  name: id,
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work',
  state: 'stopped',
  harnessConversation: '11111111-2222-4333-8444-555555555555',
  createdAt: T0,
  stateAt: T0,
});

describe('a required launch-part source', () => {
  test('a refusal with a sentence refuses a start with that sentence, and nothing is prepared, started or left holding a token', async () => {
    const f = fixture([throwing(new LaunchPartsRefusal('the login settings were not checked'), true)]);

    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.reason).toBe('the login settings were not checked');
    expect(f.runner.starts).toBe(0);
    expect(f.harness.prepared).toHaveLength(0);
    expect(f.harness.launched).toHaveLength(0);
    expect(f.tokens.holds(ferretId('f1'))).toBe(false);
  });

  test('any other failure refuses with a generic sentence that carries none of the error text', async () => {
    const f = fixture([throwing(new Error(`read ${SECRET} failed`), true)]);

    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.reason).toContain('the ferret was not started');
    expect(JSON.stringify(started.error)).not.toContain(SECRET);
    expect(f.runner.starts).toBe(0);
    expect(f.harness.launched).toHaveLength(0);
  });

  test('it refuses a resume the same way, and the stopped ferret is not relaunched', async () => {
    const f = fixture([throwing(new Error('boom'), true)], [stopped('f9')]);

    const resumed = await f.service.resume(ferretId('f9'), undefined, { origin: PERSON_ORIGIN });

    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.reason).toContain('the ferret was not started');
    expect(f.runner.starts).toBe(0);
    expect(f.harness.launched).toHaveLength(0);
  });

  test('a source that is only an addition, failing, is skipped: the other sources still contribute and the ferret starts', async () => {
    const f = fixture([
      throwing(new Error('lessons unavailable'), false),
      answering([{ kind: 'instruction', id: 'i', text: 'hello' }]),
    ]);

    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(true);
    expect(f.harness.launched[0]?.parts).toEqual([{ kind: 'instruction', id: 'i', text: 'hello' }]);
  });

  test('a required source that answers is used like any other', async () => {
    const f = fixture([{ required: true, parts: async () => [{ kind: 'pin', env: { A: 'b' } }] }]);

    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);

    expect(started.ok).toBe(true);
    expect(f.harness.launched[0]?.parts).toEqual([{ kind: 'pin', env: { A: 'b' } }]);
  });
});
