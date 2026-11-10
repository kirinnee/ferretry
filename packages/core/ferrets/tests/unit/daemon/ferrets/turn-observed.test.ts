import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import type { FerretChangedPayload, FerretRecord, FerretState } from '../../../../contract/index.ts';
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

/** `FerretsService.turnObserved` (U4): a recorded turn moves a ferret that is working or idle, and nothing else. */

const record = (id: string, state: FerretState): FerretRecord => ({
  format: 1,
  id: ferretId(id),
  name: id,
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work',
  state,
  createdAt: T0,
  stateAt: T0,
});

function fixture(records: readonly FerretRecord[]) {
  const registry = new FerretRegistry(records);
  const harness = new FakeHarness();
  const runner = new FakeRunner();
  const changes: FerretChangedPayload[] = [];
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => ferretId('unused'),
    newName: () => 'unused',
    save: async () => {},
    saveTokens: async () => {},
    harness: () => harness,
    harnessKeys: () => [harness.key],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: payload => void changes.push(payload),
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
  };
  return { registry, changes, service: new FerretsService(registry, new FerretTokenDirectory(), ports) };
}

describe('FerretsService.turnObserved (U4)', () => {
  test('a working ferret becomes idle when its turn ends, and working again on a new turn, each announced once', async () => {
    const f = fixture([record('w1', 'working')]);

    await f.service.turnObserved(ferretId('w1'), 'your-turn');
    await f.service.turnObserved(ferretId('w1'), 'your-turn');
    expect(f.registry.get(ferretId('w1'))?.state).toBe('idle');
    await f.service.turnObserved(ferretId('w1'), 'working');

    expect(f.registry.get(ferretId('w1'))?.state).toBe('working');
    expect(f.changes.map(change => [change.change, change.previous, change.state])).toEqual([
      ['state', 'working', 'idle'],
      ['state', 'idle', 'working'],
    ]);
  });

  test('a stop has the last word: a turn recorded after the ferret stopped leaves it stopped, and says nothing', async () => {
    const f = fixture([record('s1', 'stopped')]);

    await f.service.turnObserved(ferretId('s1'), 'working');
    await f.service.turnObserved(ferretId('s1'), 'your-turn');

    expect(f.registry.get(ferretId('s1'))?.state).toBe('stopped');
    expect(f.changes).toEqual([]);
  });

  test('a start settles its own starting state: a recorded turn does not move a ferret that is starting', async () => {
    const f = fixture([record('t1', 'starting')]);

    await f.service.turnObserved(ferretId('t1'), 'working');

    expect(f.registry.get(ferretId('t1'))?.state).toBe('starting');
    expect(f.changes).toEqual([]);
  });

  test('a ferret the registry does not hold is ignored', async () => {
    const f = fixture([]);

    await f.service.turnObserved(ferretId('gone'), 'working');

    expect(f.changes).toEqual([]);
  });
});
