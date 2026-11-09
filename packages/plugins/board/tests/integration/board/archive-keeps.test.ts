import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import {
  ArchiveKeeps,
  type ArchiveCardStanding,
  ArchiveCardStandingsSchema,
  type ArchiveKeepSource,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import type { Log } from '@ferretry/kernel/contract';
import { HookEngine } from '@ferretry/kernel/host';
import { definePlugin } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { type BoardCardSnapshot, boardArchiveKeeps } from '../../../daemon/adapters/archive-keeps.ts';
import { BoardPort, type Card, CardCreateRequestSchema } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';
import type { LaneSets } from '../../../daemon/lib/board/index.ts';
import { card, lanes, OTHER_PROJECT, PROJECT } from '../../unit/board/support.ts';

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

/**
 * Whether Ferrets' boundary reads the whole answer: its own `ArchiveCardStandingsSchema` (ferret-id parties, a boolean
 * `dropped`, no extra keys), which it parses strictly, so one standing it refuses keeps every ferret on every pass.
 */
const meetsFerretsBoundary = (standings: readonly ArchiveCardStanding[]): boolean =>
  ArchiveCardStandingsSchema.safeParse(standings).success;

/** The answer as plain data, for comparing with literal ids (the parties are branded `FerretId`s). */
const plain = (standings: readonly ArchiveCardStanding[]): readonly unknown[] => standings;

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
    expect(plain(standings)).toEqual([
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

describe('AK-B Board answers only ferret ids, so one odd stored card never stops the archive', () => {
  // Board stores a party as plain text (FerretRefSchema); Ferrets takes only ferret ids and parses the whole list.
  const ODD = 'not a ferret!';

  test('AK-B9 all parties are ferret ids: every card is answered as stored, and every standing meets Ferrets’ boundary', async () => {
    const standings = await answer(
      snapshotOf([
        card({ id: 'F1', owner: 'lead', assignee: 'helper_2', laneId: 'implement' }),
        card({ id: 'F2', owner: 'mw5qhtt4-5a81fb85', assignee: null, laneId: 'closed' }),
      ]),
    );
    expect(plain(standings)).toEqual([
      { owner: 'lead', assignee: 'helper_2', dropped: false, category: 'active' },
      { owner: 'mw5qhtt4-5a81fb85', assignee: null, dropped: false, category: 'closed' },
    ]);
    expect(meetsFerretsBoundary(standings)).toBe(true);
  });

  test('AK-B10 an owner that is not a ferret id is left out, and the card answers its assignee as its owner', async () => {
    const standings = await answer(
      snapshotOf([
        card({ id: 'F1', owner: ODD, assignee: 'helper', laneId: 'implement' }),
        card({ id: 'F2', owner: 'lead', laneId: 'todo' }),
      ]),
    );
    expect(plain(standings)).toEqual([
      { owner: 'helper', assignee: null, dropped: false, category: 'active' },
      { owner: 'lead', assignee: null, dropped: false, category: 'backlog' },
    ]);
    // The assignee is still kept live by the card, exactly as today (owner and assignee keep alike).
    expect(standings.map(keptToday)).toEqual([true, true]);
    expect(meetsFerretsBoundary(standings)).toBe(true);
  });

  test('AK-B11 an assignee that is not a ferret id is left out; the owner still answers', async () => {
    const standings = await answer(snapshotOf([card({ id: 'F1', owner: 'lead', assignee: ODD, laneId: 'review' })]));
    expect(plain(standings)).toEqual([{ owner: 'lead', assignee: null, dropped: false, category: 'review' }]);
    expect(meetsFerretsBoundary(standings)).toBe(true);
  });

  test('AK-B12 a card with neither party a ferret id names no ferret and is left out; the other cards still answer', async () => {
    const standings = await answer(
      snapshotOf([
        card({ id: 'F1', owner: ODD, assignee: ':callsign', laneId: 'implement' }),
        card({ id: 'F2', owner: ODD, assignee: null, laneId: 'implement' }),
        card({ id: 'F3', owner: 'lead', assignee: 'helper', laneId: 'implement' }),
      ]),
    );
    expect(plain(standings)).toEqual([{ owner: 'lead', assignee: 'helper', dropped: false, category: 'active' }]);
    expect(meetsFerretsBoundary(standings)).toBe(true);
  });

  test('AK-B13 one odd card beside a good one: Ferrets still reads the answer, so the good card’s finished ferret can archive', async () => {
    const cards = [
      // An odd card still in flight: its owner is a callsign, not a ferret id, and it names nobody else.
      card({ id: 'F1', owner: ':lead', assignee: null, laneId: 'implement' }),
      // A good card that is done: it no longer holds its owner, so that ferret may archive.
      card({ id: 'F2', owner: 'finished', assignee: null, laneId: 'closed' }),
      // A good card in flight: it holds its owner and assignee.
      card({ id: 'F3', owner: 'busy', assignee: 'helper', laneId: 'implement' }),
    ];
    // Stored as-is, the odd party fails Ferrets' boundary, which would make the WHOLE answer unreadable and keep every
    // ferret (the archive dead): this is what leaving the party out prevents.
    const asStored = cards.map(each => ({
      owner: each.owner,
      assignee: each.assignee,
      dropped: each.dropped !== null,
      category: undefined,
    }));
    expect(ArchiveCardStandingsSchema.safeParse(asStored).success).toBe(false);

    const standings = await answer(snapshotOf(cards));
    // Ferrets parses Board's answer with this schema: it is readable, so the pass decides on it.
    const read = ArchiveCardStandingsSchema.safeParse(standings);
    if (!read.success) throw new Error('Ferrets would read this answer as unreadable and keep every ferret');
    // Today's rule over what Ferrets read: only an open card's owner and assignee are kept.
    const kept = new Set<string>(
      read.data
        .filter(each => !each.dropped && each.category !== 'closed' && each.category !== 'shipped')
        .flatMap(each => [each.owner, ...(each.assignee === null ? [] : [each.assignee])]),
    );
    expect([...kept].sort()).toEqual(['busy', 'helper']);
    // The good card's finished ferret is not kept, so the archive may take it.
    expect(kept.has('finished')).toBe(false);
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
    const ferrets = new FakeFerrets();
    const taken: { hooks?: Record<string, unknown> } = {};
    const capturing = {
      ...daemon,
      build: (ctx: never) => {
        const half = (daemon.build as (ctx: never) => { hooks: Record<string, unknown> })(ctx);
        taken.hooks = half.hooks;
        return half;
      },
    } as typeof daemon;
    const host = await testHost({ plugins: [capturing], fakes: { asks: new FakeAsks(), ferrets } });
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
      // A card written through the booted plugin is answered by the hook: the hook reads Board's real store.
      const made = await host.provided(BoardPort).create(
        'owner',
        CardCreateRequestSchema.parse({
          kind: 'feature',
          title: 'Archive keeps',
          ask: { text: 'keep the helper live', source: 'owner' },
          projectId: 'unfiled',
          assignee: 'helper-1',
        }),
      );
      if (!made.ok) throw new Error(`the card was refused: ${made.error.message}`);
      const standings = await only.item.cards();
      expect(plain(standings)).toEqual([
        { owner: made.value.owner, assignee: 'helper-1', dropped: false, category: expect.any(String) },
      ]);
      expect(standings.map(each => each.category)).toEqual(['backlog']);
      expect(meetsFerretsBoundary(standings)).toBe(true);
    } finally {
      await host.stop();
    }
  });
});
