import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { describe, expect, test } from 'bun:test';
import type { InstructionEntry } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import type { FerretId, FerretRecord } from '../../../../contract/index.ts';
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
 * R-0128 what a launch records of the instructions it told (u6-r1 minor 5): a record that could not be written leaves
 * NO record, never the previous launch's, so a resumed ferret is never compared against what an earlier launch said.
 */

const BOARD: InstructionEntry = {
  plugin: 'board' as never,
  id: 'board',
  text: 'the board rules',
  when: { role: 'any' },
};

function fixture(records: readonly FerretRecord[], failWrite: () => boolean) {
  const kept = new Map<FerretId, Readonly<Record<string, string>>>();
  const forgotten: FerretId[] = [];
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => ferretId('f1'),
    newName: () => 'fern1',
    save: async () => {},
    saveTokens: async () => {},
    harness: key => (key === 'claude-code' ? new FakeHarness('claude-code') : undefined),
    harnessKeys: () => ['claude-code'],
    runner: () => new FakeRunner(),
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [BOARD],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
    launchSections: {
      write: async (ferret, sections) => {
        if (failWrite()) throw new Error('disk full');
        kept.set(ferret, sections);
      },
      forget: async ferret => {
        forgotten.push(ferret);
        kept.delete(ferret);
      },
    },
  };
  return {
    kept,
    forgotten,
    service: new FerretsService(new FerretRegistry(records), new FerretTokenDirectory(), ports),
  };
}

const stopped: FerretRecord = {
  format: 1,
  id: ferretId('old'),
  name: 'old',
  role: 'lead',
  mode: 'auto',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work',
  state: 'stopped',
  harnessConversation: 'conv-1',
  createdAt: T0,
  stateAt: T0,
};

describe('R-0128 the launch record of what a ferret was told', () => {
  test('R-0128 a launch whose write lands records what it told, and forgets nothing', async () => {
    const f = fixture([stopped], () => false);
    const resumed = await f.service.resume(ferretId('old'), undefined, { origin: PERSON_ORIGIN });
    if (!resumed.ok) throw new Error(resumed.error.reason);
    expect([...f.kept.keys()]).toEqual([ferretId('old')]);
    expect(Object.keys(f.kept.get(ferretId('old')) ?? {})).toEqual(['board']);
    expect(f.forgotten).toEqual([]);
  });

  test("R-0128 a launch whose write fails leaves no record: the previous launch's is forgotten, never compared against", async () => {
    const f = fixture([stopped], () => true);
    // What an EARLIER launch told this ferret, still on disk.
    f.kept.set(ferretId('old'), { board: 'aaaa1111' });
    const resumed = await f.service.resume(ferretId('old'), undefined, { origin: PERSON_ORIGIN });
    // The launch itself still succeeds: the record is advice.
    if (!resumed.ok) throw new Error(resumed.error.reason);
    expect(f.forgotten).toEqual([ferretId('old')]);
    expect(f.kept.has(ferretId('old'))).toBe(false);
  });
});
