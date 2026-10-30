import { describe, expect, it } from 'bun:test';

import {
  type BoardFilters,
  type BoardMachineData,
  boardCardKey,
  boardFiltersToSearch,
  boardQueryParams,
  cardMatchesQuery,
  checkMove,
  isMine,
  mergeBoard,
  NO_BOARD_FILTERS,
  parseBoardFilters,
  runningOn,
  serverQueryKey,
  toServerQuery,
} from '../../src/lib/board-model.ts';
import {
  CHILD,
  COUNTS,
  card,
  laneSetFor,
  laptop,
  OTHER_PROJECT,
  PROJECT,
  phone,
  workstation,
} from './board-support.ts';

const data = (machine: typeof laptop, name: string, cards: ReturnType<typeof card>[], version = '4.110.0') =>
  ({
    daemonId: machine.daemonId,
    machine: name,
    version,
    cards,
    laneSets: new Map([[PROJECT, laneSetFor()]]),
    counts: { ...COUNTS, active: cards.length },
    quarantined: [],
  }) satisfies BoardMachineData;

describe('mergeBoard', () => {
  it('keeps two machines’ same-numbered cards apart, keyed (daemonId, taskId)', () => {
    const model = mergeBoard(
      [
        data(laptop, 'laptop', [card('F12', { title: 'on laptop' })]),
        data(workstation, 'workstation', [card('F12', { title: 'on workstation' })]),
      ],
      NO_BOARD_FILTERS,
    );
    expect(model.cards.map(entry => entry.key)).toEqual([
      boardCardKey(laptop.daemonId, 'F12'),
      boardCardKey(workstation.daemonId, 'F12'),
    ]);
    expect(model.cards.map(entry => entry.task.title)).toEqual(['on laptop', 'on workstation']);
    expect(model.multiMachine).toBe(true);
  });

  it('groups project → lane per machine, with each machine’s own lane set', () => {
    const wide = { ...laneSetFor(), lanes: laneSetFor().lanes.filter(lane => lane.id !== 'plan') };
    const model = mergeBoard(
      [
        data(laptop, 'laptop', [card('F1', { laneId: 'implement' }), card('F2', { laneId: 'review' })]),
        {
          ...data(workstation, 'workstation', [card('F1', { laneId: 'implement' })]),
          laneSets: new Map([[PROJECT, wide]]),
        },
      ],
      NO_BOARD_FILTERS,
    );
    expect(model.groups.map(group => [group.daemonId, group.projectId])).toEqual([
      [laptop.daemonId, PROJECT],
      [workstation.daemonId, PROJECT],
    ]);
    const [first, second] = model.groups;
    expect(first?.lanes.map(lane => lane.id)).toContain('plan');
    expect(second?.lanes.map(lane => lane.id)).not.toContain('plan');
    expect(first?.lanes.find(lane => lane.id === 'implement')?.cards.map(entry => entry.task.id)).toEqual(['F1']);
    expect(first?.lanes.find(lane => lane.id === 'review')?.cards.map(entry => entry.task.id)).toEqual(['F2']);
  });

  it('sums the counts, surfaces quarantined cards per machine and never drops an unplaced card', () => {
    const quarantined = [{ id: 'F9', reason: 'unreadable' }] as never;
    const model = mergeBoard(
      [
        { ...data(laptop, 'laptop', [card('F1')]), quarantined },
        { ...data(workstation, 'workstation', [card('F2', { laneId: 'gone' })]), counts: null },
      ],
      NO_BOARD_FILTERS,
    );
    expect(model.counts.active).toBe(1);
    expect(model.quarantined.map(entry => [entry.daemonId, entry.cards])).toEqual([[laptop.daemonId, quarantined]]);
    expect(model.groups[1]?.unplaced.map(entry => entry.task.id)).toEqual(['F2']);
  });

  it('applies the machine and mine filters, and leaves the rest to the daemon', () => {
    const owners = [
      card('F1', { createdBy: { kind: 'owner' } }),
      card('F2'),
      card('F3', { waitingOnOwner: [{ sessionId: CHILD, id: 'A1' }], openAsks: [{ sessionId: CHILD, id: 'A1' }] }),
    ];
    const machines = [data(laptop, 'laptop', owners), data(workstation, 'workstation', [card('F4')])];
    expect(
      mergeBoard(machines, { ...NO_BOARD_FILTERS, machine: workstation.daemonId }).cards.map(entry => entry.task.id),
    ).toEqual(['F4']);
    expect(mergeBoard(machines, { ...NO_BOARD_FILTERS, mine: true }).cards.map(entry => entry.task.id)).toEqual([
      'F1',
      'F3',
    ]);
    expect(isMine(card('F2'))).toBe(false);
  });

  it('orders a lane by order, then longest untouched, then id', () => {
    const model = mergeBoard(
      [
        data(laptop, 'laptop', [
          card('F3', { lastTouchedAt: '2026-08-01T10:00:00.000Z' }),
          card('F2', { lastTouchedAt: '2026-08-01T08:00:00.000Z' }),
          card('F1', { order: 0 }),
          card('F4', { order: 1 }),
        ]),
      ],
      NO_BOARD_FILTERS,
    );
    expect(model.groups[0]?.lanes.find(lane => lane.id === 'implement')?.cards.map(entry => entry.task.id)).toEqual([
      'F1',
      'F4',
      'F3',
      'F2',
    ]);
  });
});

describe('runningOn', () => {
  const machines = [
    { daemonId: laptop.daemonId, machine: 'laptop', version: '4.110.0' },
    { daemonId: workstation.daemonId, machine: 'workstation', version: '4.109.2' },
    { daemonId: phone.daemonId, machine: 'phone', version: null },
  ];

  it('is empty for a card that has not shipped', () => {
    expect(runningOn(null, machines)).toEqual([]);
  });

  it('is true only where the daemon’s version is at or past the release', () => {
    const answer = runningOn({ version: '4.110.0' }, machines);
    expect(answer.map(entry => [entry.machine, entry.has])).toEqual([
      ['laptop', true],
      ['workstation', false],
      ['phone', false],
    ]);
  });

  it('treats a version it cannot compare as not running it', () => {
    expect(
      runningOn({ version: '4.110.0' }, [{ daemonId: phone.daemonId, machine: 'm', version: 'garbage' }])[0]?.has,
    ).toBe(false);
  });

  it('is set on every merged card from every paired machine’s version', () => {
    const shipped = card('F1', { shippedIn: { version: '4.110.0', tag: 'v4.110.0', at: '2026-08-01T10:00:00.000Z' } });
    const model = mergeBoard(
      [data(laptop, 'laptop', [shipped], '4.110.0'), data(workstation, 'workstation', [], '4.100.0')],
      NO_BOARD_FILTERS,
    );
    expect(model.cards[0]?.runningOn.map(entry => [entry.machine, entry.has])).toEqual([
      ['laptop', true],
      ['workstation', false],
    ]);
  });
});

describe('filters and the URL', () => {
  const full: BoardFilters = {
    project: PROJECT,
    machine: laptop.daemonId,
    ferret: CHILD,
    kind: 'bug',
    pr: 'ci_red',
    state: 'all',
    activity: 'waiting_on_you',
    mine: true,
  };

  it('round-trips every filter through the query string', () => {
    expect(parseBoardFilters(boardFiltersToSearch(full).toString())).toEqual(full);
    expect(parseBoardFilters(boardFiltersToSearch(NO_BOARD_FILTERS))).toEqual(NO_BOARD_FILTERS);
  });

  it('leaves the defaults out, so the plain board has a plain URL', () => {
    expect(boardFiltersToSearch(NO_BOARD_FILTERS).toString()).toBe('');
    expect(boardFiltersToSearch({ ...NO_BOARD_FILTERS, mine: true }).toString()).toBe('mine=1');
  });

  it('drops a value it does not know instead of failing', () => {
    expect(
      parseBoardFilters('?kind=nonsense&pr=maybe&state=weird&activity=x&project=not-a-uuid&mine=0&machine=%20'),
    ).toEqual(NO_BOARD_FILTERS);
    expect(parseBoardFilters(new URLSearchParams('mine=true')).mine).toBe(true);
  });

  it('sends the daemon’s part of the query only, and shares one read between equal queries', () => {
    const query = toServerQuery(full);
    expect(query).toEqual({
      project: PROJECT,
      ferret: CHILD,
      kind: 'bug',
      pr: 'ci_red',
      state: 'all',
      activity: 'waiting_on_you',
    });
    expect(serverQueryKey(query)).toBe(serverQueryKey(toServerQuery({ ...full, machine: null, mine: false })));
    const params = boardQueryParams(query, 'cursor-1', 25);
    expect(params.get('prState')).toBe('ci_red');
    expect(params.get('cursor')).toBe('cursor-1');
    expect(params.get('limit')).toBe('25');
    expect(params.get('machine')).toBeNull();
    expect(boardQueryParams(toServerQuery(NO_BOARD_FILTERS)).get('state')).toBe('open');
  });
});

describe('cardMatchesQuery', () => {
  const open = toServerQuery(NO_BOARD_FILTERS);
  const lanes = laneSetFor();

  it('keeps an open card and drops closed and dropped ones from the default board', () => {
    expect(cardMatchesQuery(card('F1'), lanes, open)).toBe(true);
    expect(cardMatchesQuery(card('F1', { laneId: 'closed' }), lanes, open)).toBe(false);
    expect(cardMatchesQuery(card('F1', { laneId: 'closed' }), lanes, { ...open, state: 'closed' })).toBe(true);
    expect(cardMatchesQuery(card('F1'), lanes, { ...open, state: 'all' })).toBe(true);
  });

  it('judges a card with no known lane set by whether it was dropped', () => {
    expect(cardMatchesQuery(card('F1'), null, open)).toBe(true);
    expect(cardMatchesQuery(card('F1'), null, { ...open, state: 'dropped' })).toBe(false);
  });

  it('matches project, ferret, kind, pr state and activity', () => {
    expect(cardMatchesQuery(card('F1'), lanes, { ...open, project: OTHER_PROJECT })).toBe(false);
    expect(cardMatchesQuery(card('F1', { assignee: CHILD }), lanes, { ...open, ferret: CHILD })).toBe(true);
    expect(cardMatchesQuery(card('F1'), lanes, { ...open, ferret: CHILD })).toBe(false);
    expect(cardMatchesQuery(card('B1', { kind: 'bug' }), lanes, { ...open, kind: 'feature' })).toBe(false);
    expect(cardMatchesQuery(card('F1'), lanes, { ...open, pr: 'none' })).toBe(true);
    expect(cardMatchesQuery(card('F1'), lanes, { ...open, pr: 'merged' })).toBe(false);
    expect(cardMatchesQuery(card('F1', { activity: 'stale' }), lanes, { ...open, activity: 'stale' })).toBe(true);
    expect(cardMatchesQuery(card('F1'), lanes, { ...open, activity: 'blocked' })).toBe(false);
    expect(cardMatchesQuery(card('F1', { laneId: 'tested' }), lanes, { ...open, activity: 'to_test' })).toBe(true);
    expect(cardMatchesQuery(card('F1', { laneId: 'tested' }), null, { ...open, activity: 'to_test' })).toBe(false);
  });
});

describe('checkMove', () => {
  const lanes = laneSetFor();

  it('lets a forward move go without a reason', () => {
    expect(checkMove(lanes, 'implement', 'review', undefined).ok).toBe(true);
  });

  it('requires a reason for a move back', () => {
    const refused = checkMove(lanes, 'review', 'implement', undefined);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('reason-required');
    expect(checkMove(lanes, 'review', 'implement', '   ').ok).toBe(false);
    expect(checkMove(lanes, 'review', 'implement', 'CI found a regression').ok).toBe(true);
  });

  it('refuses a lane the project does not have, and a project with no lanes', () => {
    const unknown = checkMove(lanes, 'implement', 'nowhere', 'x');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('unknown-lane');
    const none = checkMove(null, 'implement', 'review', undefined);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.code).toBe('no-lane-set');
  });
});

describe('cardMatchesQuery on every pr and activity filter', () => {
  const open = toServerQuery(NO_BOARD_FILTERS);
  const lanes = laneSetFor();
  const pr = (extra: Record<string, unknown>) => ({
    url: 'https://github.com/ferretry/ferretry/pull/1',
    number: 1,
    repo: 'ferretry/ferretry',
    state: 'open',
    draft: false,
    checks: 'passing',
    mergedAt: null,
    mergeSha: null,
    releasedIn: null,
    polledAt: '2026-08-01T10:00:00.000Z',
    ...extra,
  });
  const merged = { state: 'merged', mergedAt: '2026-08-01T10:00:00.000Z', mergeSha: 'a'.repeat(40) };
  const withPr = (extra: Record<string, unknown>) =>
    card('F1', { links: { prs: [pr(extra)], branch: null, commits: [], docs: [] } });

  it('reads draft, open, red, merged and released off the card’s pull requests', () => {
    expect(cardMatchesQuery(withPr({ draft: true }), lanes, { ...open, pr: 'draft' })).toBe(true);
    expect(cardMatchesQuery(withPr({}), lanes, { ...open, pr: 'draft' })).toBe(false);
    expect(cardMatchesQuery(withPr({}), lanes, { ...open, pr: 'open' })).toBe(true);
    expect(cardMatchesQuery(withPr({ checks: 'failing' }), lanes, { ...open, pr: 'ci_red' })).toBe(true);
    expect(cardMatchesQuery(withPr(merged), lanes, { ...open, pr: 'merged' })).toBe(true);
    expect(cardMatchesQuery(withPr({}), lanes, { ...open, pr: 'released' })).toBe(false);
    const shipped = card('F1', { shippedIn: { version: '1.0.0', tag: 'v1.0.0', at: '2026-08-01T10:00:00.000Z' } });
    expect(cardMatchesQuery(shipped, lanes, { ...open, pr: 'released' })).toBe(true);
  });

  it('reads waiting_on_you and blocked off the card', () => {
    const waiting = card('F1', {
      waitingOnOwner: [{ sessionId: CHILD, id: 'A1' }],
      openAsks: [{ sessionId: CHILD, id: 'A1' }],
    });
    expect(cardMatchesQuery(waiting, lanes, { ...open, activity: 'waiting_on_you' })).toBe(true);
    expect(cardMatchesQuery(card('F1'), lanes, { ...open, activity: 'waiting_on_you' })).toBe(false);
    const blocked = card('F1', { blockedBy: [{ id: 'F2' }] });
    expect(cardMatchesQuery(blocked, lanes, { ...open, activity: 'blocked' })).toBe(true);
  });
});
