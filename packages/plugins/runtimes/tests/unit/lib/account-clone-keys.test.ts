import { describe, it } from 'bun:test';
import { mcpOAuthSecretNames } from '../../../daemon/lib/foreign.ts';
import should from 'should';
import { type CloneBase, parseCloneBase, serializeCloneBase } from '../../../daemon/lib/account/clone-base.ts';
import { classifyCloneKeys, recordCloneKeys } from '../../../daemon/lib/account/clone-keys.ts';

const T0 = '2026-10-01T08:00:00.000Z';
const T1 = '2026-10-10T08:00:00.000Z';
const T2 = '2026-10-20T08:00:00.000Z';
const KEY_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';

/** The only strings that could be a secret value in these tests: nothing may ever carry one. */
const FAKE_VALUES = ['sk-live-0123456789abcdef', 'correct-horse-battery-staple'];

const held = (name: string, updatedAt: string) => ({ name, updatedAt });

const recorded = (name: string, sourceUpdatedAt: string, targetUpdatedAt: string) => ({
  [name]: { sourceUpdatedAt, targetUpdatedAt },
});

const base = (keys?: CloneBase['sources'][string]['keys']): CloneBase => ({
  version: 1,
  sources: {
    'daemon-source': {
      name: 'studio-mac',
      verified: 'browser',
      lastCopiedAt: T0,
      items: { [KEY_A]: { kind: 'instructions', sourceName: 'main', digest: 'f'.repeat(64), bytes: 1 } },
      ...(keys === undefined ? {} : { keys }),
    },
  },
});

describe('classifyCloneKeys', () => {
  it('should call a key the source holds and this machine does not missing', () => {
    should(
      classifyCloneKeys({
        source: [held('GLM_API_KEY', T1)],
        target: [],
        wanted: ['GLM_API_KEY'],
        recorded: undefined,
      }),
    ).deepEqual([{ name: 'GLM_API_KEY', outcome: 'missing' }]);
  });

  it('should call a key newer on the source, and unchanged here since the last copy, newer', () => {
    should(
      classifyCloneKeys({
        source: [held('GLM_API_KEY', T2)],
        target: [held('GLM_API_KEY', T1)],
        wanted: ['GLM_API_KEY'],
        recorded: recorded('GLM_API_KEY', T1, T1),
      }),
    ).deepEqual([{ name: 'GLM_API_KEY', outcome: 'newer' }]);
  });

  it('should call a key newer on the source AND changed here since the last copy both', () => {
    should(
      classifyCloneKeys({
        source: [held('GLM_API_KEY', T2)],
        target: [held('GLM_API_KEY', T2)],
        wanted: ['GLM_API_KEY'],
        recorded: recorded('GLM_API_KEY', T1, T1),
      }),
    ).deepEqual([{ name: 'GLM_API_KEY', outcome: 'both' }]);
  });

  it('should call a key the source has not changed since the last copy the same, whatever happened here', () => {
    for (const here of [T1, T2])
      should(
        classifyCloneKeys({
          source: [held('GLM_API_KEY', T1)],
          target: [held('GLM_API_KEY', here)],
          wanted: ['GLM_API_KEY'],
          recorded: recorded('GLM_API_KEY', T1, T1),
        }),
      ).deepEqual([{ name: 'GLM_API_KEY', outcome: 'same' }]);
  });

  it('should offer nothing for a key both hold that no copy recorded: there is nothing to say it moved', () => {
    should(
      classifyCloneKeys({
        source: [held('GLM_API_KEY', T2)],
        target: [held('GLM_API_KEY', T0)],
        wanted: ['GLM_API_KEY'],
        recorded: undefined,
      }),
    ).deepEqual([{ name: 'GLM_API_KEY', outcome: 'same' }]);
  });

  it('should compare instants, not spellings', () => {
    should(
      classifyCloneKeys({
        source: [held('GLM_API_KEY', '2026-10-10T10:00:00.000+02:00')],
        target: [held('GLM_API_KEY', '2026-10-10T08:00:00Z')],
        wanted: ['GLM_API_KEY'],
        recorded: recorded('GLM_API_KEY', T1, T1),
      }),
    ).deepEqual([{ name: 'GLM_API_KEY', outcome: 'same' }]);
  });

  it('should concern itself with the keys a copy recorded as well as the ones the bundle names', () => {
    should(
      classifyCloneKeys({
        source: [held('OLD_KEY', T2), held('UNRELATED_KEY', T2)],
        target: [held('OLD_KEY', T1)],
        wanted: [],
        recorded: recorded('OLD_KEY', T1, T1),
      }),
    ).deepEqual([{ name: 'OLD_KEY', outcome: 'newer' }]);
  });

  it('should leave out a key only this machine holds, and a key the source does not list', () => {
    should(
      classifyCloneKeys({
        source: [],
        target: [held('LOCAL_KEY', T1)],
        wanted: ['LOCAL_KEY', 'GONE_KEY'],
        recorded: recorded('LOCAL_KEY', T0, T0),
      }),
    ).deepEqual([]);
  });

  it('should never name a sign-in token, however it got into either list', () => {
    const signIn = mcpOAuthSecretNames('linear', 'https://mcp.example.com/mcp').access;
    const outcomes = classifyCloneKeys({
      source: [held(signIn, T2), held('GLM_API_KEY', T2)],
      target: [],
      wanted: [signIn, 'GLM_API_KEY'],
      recorded: recorded(signIn, T0, T0),
    });
    should(outcomes.map(outcome => outcome.name)).deepEqual(['GLM_API_KEY']);
  });

  it('should answer sorted by name, one outcome per name', () => {
    const outcomes = classifyCloneKeys({
      source: [held('B_KEY', T1), held('A_KEY', T1)],
      target: [],
      wanted: ['B_KEY', 'A_KEY', 'A_KEY'],
      recorded: undefined,
    });
    should(outcomes.map(outcome => outcome.name)).deepEqual(['A_KEY', 'B_KEY']);
  });

  it('should only ever answer names and outcomes: nothing a value could ride in', () => {
    const outcomes = classifyCloneKeys({
      source: [held('GLM_API_KEY', T2)],
      target: [held('GLM_API_KEY', T1)],
      wanted: ['GLM_API_KEY'],
      recorded: recorded('GLM_API_KEY', T1, T1),
    });
    should(Object.keys(outcomes[0] ?? {}).sort()).deepEqual(['name', 'outcome']);
    for (const value of FAKE_VALUES) should(JSON.stringify(outcomes)).not.containEql(value);
  });
});

describe('recordCloneKeys', () => {
  it('should add the two instants of each key to the source that was copied from, and change nothing else', () => {
    const before = base();
    const after = recordCloneKeys(before, 'daemon-source', [
      { name: 'GLM_API_KEY', sourceUpdatedAt: T1, targetUpdatedAt: T2 },
    ]);
    should(after.sources['daemon-source']?.keys).deepEqual(recorded('GLM_API_KEY', T1, T2));
    should({ ...after.sources['daemon-source'], keys: undefined }).deepEqual({
      ...before.sources['daemon-source'],
      keys: undefined,
    });
  });

  it('should replace the instants of a key recorded before and keep the others', () => {
    const before = base({ ...recorded('A_KEY', T0, T0), ...recorded('B_KEY', T0, T0) });
    const after = recordCloneKeys(before, 'daemon-source', [
      { name: 'A_KEY', sourceUpdatedAt: T2, targetUpdatedAt: T2 },
    ]);
    should(after.sources['daemon-source']?.keys).deepEqual({
      ...recorded('A_KEY', T2, T2),
      ...recorded('B_KEY', T0, T0),
    });
  });

  it('should leave the record as it is for a source it holds nothing for', () => {
    const before = base();
    should(
      recordCloneKeys(before, 'another-machine', [{ name: 'A_KEY', sourceUpdatedAt: T1, targetUpdatedAt: T1 }]),
    ).equal(before);
    should(recordCloneKeys(before, '__proto__', [{ name: 'A_KEY', sourceUpdatedAt: T1, targetUpdatedAt: T1 }])).equal(
      before,
    );
    should(recordCloneKeys(before, 'daemon-source', [])).equal(before);
  });

  it('should not record a name no copy can carry', () => {
    const before = base();
    const after = recordCloneKeys(before, 'daemon-source', [
      {
        name: mcpOAuthSecretNames('linear', 'https://mcp.example.com/mcp').access,
        sourceUpdatedAt: T1,
        targetUpdatedAt: T1,
      },
    ]);
    should(after.sources['daemon-source']?.keys).deepEqual({});
  });

  it('should write a record that reads back as written, holding timestamps and names and nothing else', () => {
    const after = recordCloneKeys(base(), 'daemon-source', [
      { name: 'GLM_API_KEY', sourceUpdatedAt: T1, targetUpdatedAt: T2 },
    ]);
    const text = serializeCloneBase(after);
    should(parseCloneBase(text)).deepEqual(after);
    for (const value of FAKE_VALUES) should(text).not.containEql(value);
    const written = JSON.parse(text) as { sources: Record<string, { keys: Record<string, unknown> }> };
    should(Object.keys(written.sources['daemon-source']?.keys.GLM_API_KEY ?? {}).sort()).deepEqual([
      'sourceUpdatedAt',
      'targetUpdatedAt',
    ]);
  });
});
