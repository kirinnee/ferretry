import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { ArchiveKeeps, type ArchiveCardStanding, type ArchiveKeepSource } from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import type { Log } from '@ferretry/kernel/contract';
import { HookEngine } from '@ferretry/kernel/host';
import { definePlugin } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { type BoardCardSnapshot, boardArchiveKeeps } from '../../../daemon/adapters/archive-keeps.ts';
import type { Card } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';
import type { LaneSets } from '../../../daemon/lib/board/index.ts';
import { card, lanes, OTHER_PROJECT, PROJECT } from './support.ts';

/**
 * Board's half of `session.archive-keeps` (ruling #46). The archive is OFF by default today and in 5.0 (no `afterHours`
 * in `archive.yaml`); these takers answer for when the owner turns it on. Today's rule (`sessionsOnOpenCards`, which
 * Ferrets keeps): a card holds its owner and assignee live unless it is dropped or its lane is `closed` or `shipped`;
 * a lane Board cannot name is in flight.
 */

const silent: Log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };
const never = () => ({ promise: new Promise<'timeout'>(() => {}), cancel: () => {} });

/** Ferrets' offer as its manifest declares it: the hook object its contract exports (core is never imported whole). */
const ferretsOffering = definePlugin({
  id: 'ferrets',
  title: 'Ferrets',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  hooks: { offers: [{ hook: ArchiveKeeps }] },
});

const snapshotOf = (cards: readonly Card[], laneSets: LaneSets = new Map([[PROJECT, lanes()]])): BoardCardSnapshot => ({
  snapshot: async () => ({ cards, laneSets }),
});

const answer = async (board: BoardCardSnapshot): Promise<readonly ArchiveCardStanding[]> => {
  const source = boardArchiveKeeps(board);
  if (source.kind !== 'board') throw new Error('Board contributed something other than a board source');
  return await source.cards();
};

/** Today's keep rule over one standing: the expectation each category row below is checked against. */
const keptToday = (standing: ArchiveCardStanding): boolean =>
  !standing.dropped && standing.category !== 'closed' && standing.category !== 'shipped';

describe('AK-B Board answers the archive: every card, as today read it', () => {
  test('AK-B1 each card answers its own owner and assignee, and no card speaks for another ferret', async () => {
    const standings = await answer(
      snapshotOf([
        card({ id: 'F1', owner: 'lead', assignee: 'helper', laneId: 'implement' }),
        card({ id: 'F2', owner: 'other', assignee: null, laneId: 'todo' }),
      ]),
    );
    expect(standings).toEqual([
      { owner: 'lead', assignee: 'helper', dropped: false, category: 'active' },
      { owner: 'other', assignee: null, dropped: false, category: 'backlog' },
    ]);
    // A ferret that neither owns nor holds a card is named by none.
    expect(standings.some(each => each.owner === 'stranger' || each.assignee === 'stranger')).toBe(false);
  });

  test('AK-B2 a dropped card is answered dropped, so it keeps nobody, whatever lane it sits in', async () => {
    const dropped = { reason: 'no longer wanted', at: '2026-10-30T11:00:00.000Z' };
    const standings = await answer(
      snapshotOf([
        card({ id: 'F1', owner: 'lead', assignee: 'helper', laneId: 'implement', dropped }),
        card({ id: 'F2', owner: 'lead', laneId: 'todo', dropped }),
      ]),
    );
    expect(standings.map(each => each.dropped)).toEqual([true, true]);
    expect(standings.map(keptToday)).toEqual([false, false]);
  });

  test('AK-B3 every lane category is answered as Board resolves it: backlog, active, review and verify keep; shipped and closed do not', async () => {
    // The classic pr-release-verify lanes carry every one of the six categories.
    const cases: readonly { readonly lane: string; readonly category: string; readonly kept: boolean }[] = [
      { lane: 'todo', category: 'backlog', kept: true },
      { lane: 'plan', category: 'active', kept: true },
      { lane: 'implement', category: 'active', kept: true },
      { lane: 'review', category: 'review', kept: true },
      { lane: 'tested', category: 'verify', kept: true },
      { lane: 'merged', category: 'shipped', kept: false },
      { lane: 'released', category: 'shipped', kept: false },
      { lane: 'closed', category: 'closed', kept: false },
    ];
    const standings = await answer(
      snapshotOf(cases.map((each, at) => card({ id: `F${at + 1}`, owner: `f${at + 1}`, laneId: each.lane }))),
    );
    expect(standings.map(each => each.category)).toEqual(cases.map(each => each.category));
    expect(standings.map(keptToday)).toEqual(cases.map(each => each.kept));
  });

  test('AK-B4 a card whose lane or board Board cannot name is answered with no category, which keeps (when unsure, keep)', async () => {
    const standings = await answer(
      snapshotOf([
        card({ id: 'F1', owner: 'a', laneId: 'a-lane-that-is-gone' }),
        card({ id: 'F2', owner: 'b', projectId: OTHER_PROJECT, laneId: 'todo' }),
      ]),
    );
    expect(standings.map(each => each.category)).toEqual([undefined, undefined]);
    expect(standings.map(keptToday)).toEqual([true, true]);
  });

  test('AK-B5 a board that cannot be read rejects, never answers "no cards": the archive keeps every ferret live', async () => {
    const broken: BoardCardSnapshot = {
      snapshot: async () => {
        throw new Error('the cards file is damaged');
      },
    };
    await expect(answer(broken)).rejects.toThrow('the cards file is damaged');
  });

  test('AK-B6 each ask reads the board afresh: a card that closes after one pass stops keeping its ferret at the next', async () => {
    let cards: readonly Card[] = [card({ id: 'F1', owner: 'lead', laneId: 'implement' })];
    const board: BoardCardSnapshot = { snapshot: async () => ({ cards, laneSets: new Map([[PROJECT, lanes()]]) }) };
    const source = boardArchiveKeeps(board) as Extract<ArchiveKeepSource, { kind: 'board' }>;
    expect((await source.cards()).map(keptToday)).toEqual([true]);
    cards = [card({ id: 'F1', owner: 'lead', laneId: 'closed' })];
    expect((await source.cards()).map(keptToday)).toEqual([false]);
  });
});

describe('AK-B Board takes session.archive-keeps through Ferrets’ contract only', () => {
  test('AK-B7 the manifest takes the hook Ferrets offers, and the kernel plans it with no refusal and no new edge', () => {
    expect(manifest.hooks?.takes?.some(take => take.hook.name === ArchiveKeeps.name)).toBe(true);
    const { refusals, engine } = HookEngine.plan([ferretsOffering, manifest], silent, never);
    expect(refusals.filter(refusal => refusal.plugins.includes('board'))).toEqual([]);
    expect(engine.offererOf(ArchiveKeeps)).toBe('ferrets');
    // Board reaches nothing new: Ferrets was already a need, and no other plugin is named for the hook.
    expect(Object.keys(manifest.needs ?? {}).sort()).toEqual(['asks', 'ferrets']);
  });

  test('AK-B8 a real boot contributes ONE board source under Board’s id, answering from Board’s own store', async () => {
    const taken: { hooks?: Record<string, unknown> } = {};
    const capturing = {
      ...daemon,
      build: (ctx: never) => {
        const half = (daemon.build as (ctx: never) => { hooks: Record<string, unknown> })(ctx);
        taken.hooks = half.hooks;
        return half;
      },
    } as typeof daemon;
    const host = await testHost({ plugins: [capturing], fakes: { asks: new FakeAsks(), ferrets: new FakeFerrets() } });
    try {
      const contribute = taken.hooks?.['session.archive-keeps'] as () => readonly {
        readonly id: string;
        readonly item: ArchiveKeepSource;
      }[];
      const contributions = contribute();
      expect(contributions.map(each => [each.id, each.item.kind])).toEqual([['board', 'board']]);
      const [only] = contributions;
      if (only?.item.kind !== 'board') throw new Error('no board source');
      expect(await only.item.cards()).toEqual([]);
    } finally {
      await host.stop();
    }
  });
});
