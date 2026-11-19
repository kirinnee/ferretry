import { describe, expect, test } from 'bun:test';
import type { HarnessHistorySource } from '@ferretry/core-ferrets/contract';
import { ConversationIndex } from '../../../daemon/links/lib/conversation-index.ts';
import { type HistoryGroup, indexSourcesOf } from '../../../daemon/links/lib/history-groups.ts';
import { codexRollout, MemoryHistory, memorySqlite, PARSERS } from '../../support/history-tree.ts';

const CODEX = '5c1e0e3a-0000-4000-8000-0000000000aa';
const ROLLOUT = `sessions/2026/10/10/rollout-2026-10-10T09-00-00-${CODEX}.jsonl`;
const familyOf = (harness: string) => (harness === 'codex' ? ('codex' as const) : undefined);

/** The owner's host history for a harness that stops offering it once its switch is off. */
function world() {
  const sqlite = memorySqlite();
  const owner = new MemoryHistory();
  owner.set(ROLLOUT, codexRollout(CODEX, '/work/notes', 'take notes'));
  let groups: readonly HistoryGroup[] = [
    { harness: 'codex', sources: [{ kind: 'computer', label: 'owner', files: owner }] },
  ];
  const index = new ConversationIndex({
    sqlite: () => sqlite,
    sources: async () => indexSourcesOf(groups, familyOf),
    ferretNames: async () => new Map(),
    parsers: PARSERS,
    nowMs: () => 0,
  });
  const answer = (next: readonly HistoryGroup[]): void => {
    groups = next;
  };
  return { index, owner, answer };
}

describe('indexSourcesOf', () => {
  test('one tree per offered source, none for a harness the index has no parser for', () => {
    const files = new MemoryHistory();
    const offered: HarnessHistorySource[] = [{ kind: 'pool', label: 'pool', files }];
    expect(
      indexSourcesOf(
        [
          { harness: 'codex', sources: offered },
          { harness: 'other', sources: offered },
          { harness: 'other', sources: [] },
        ],
        familyOf,
      ),
    ).toEqual([{ harness: 'codex', parser: 'codex', kind: 'pool', label: 'pool', files }]);
  });

  test('a harness that answered with no source gets one EMPTY owner tree, which lists nothing and reads nothing', async () => {
    const [only, ...rest] = indexSourcesOf([{ harness: 'codex', sources: [] }], familyOf);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ harness: 'codex', parser: 'codex', kind: 'computer', label: 'owner' });
    expect(await only?.files.entries('')).toEqual([]);
    expect(await only?.files.stat(ROLLOUT)).toBeUndefined();
    expect(await only?.files.read(ROLLOUT, 0, 10)).toBeUndefined();
  });
});

describe('a harness that stops offering the owner history (its switch turned off)', () => {
  test('keeps its computer rows while a source still offers them, and PURGES them when it answers with no source at all', async () => {
    const w = world();
    await w.index.refresh();
    expect(w.index.query({ harness: 'codex' }).matched).toBe(1);

    // Answered with none: the rows read from the computer are removed, though no other source of the harness is left.
    w.answer([{ harness: 'codex', sources: [] }]);
    await w.index.refresh();
    expect(w.index.query({ harness: 'codex' }).matched).toBe(0);
  });

  test('a harness that FAILED (absent from the answer) keeps its rows, as before', async () => {
    const w = world();
    await w.index.refresh();
    w.answer([]);
    await w.index.refresh();
    expect(w.index.query({ harness: 'codex' }).matched).toBe(1);
  });
});
