import { describe, expect, it } from 'bun:test';
import type { AgendaRef, AgendaSnapshot, BoardTaskEvent, PrLink } from '@ferretry/protocol';
import { MAX_BOARD_NOTE_LENGTH } from '@ferretry/protocol';

import {
  activityText,
  askOrigin,
  askSessions,
  askWords,
  assignedMessage,
  collectAsks,
  commentNote,
  commentTag,
  ferretComment,
  type HistoryContext,
  hasLinks,
  historyRows,
  isWebLink,
  kindLabel,
  laneCategoryOf,
  laneNameOf,
  linkLabel,
  NEW_CARD_PROBLEM_TEXT,
  newCardProblems,
  nonBlockingAsks,
  OWNER_CARD_SOURCE,
  prLine,
  type SessionAgenda,
  startBrief,
  testSteps,
  verdictLanes,
  written,
} from '../../src/lib/board-detail.ts';
import { card, laneSetFor } from './board-support.ts';

const lanes = laneSetFor();
const AT = '2026-07-01T10:00:00.000Z';

describe('lane lookups', () => {
  it('name the category and the lane, and fall back to the id', () => {
    expect(laneCategoryOf(lanes, 'review')).toBe('review');
    expect(laneCategoryOf(lanes, 'gone')).toBeNull();
    expect(laneCategoryOf(null, 'review')).toBeNull();
    expect(laneNameOf(lanes, 'review')).toBe(lanes.lanes.find(lane => lane.id === 'review')?.name ?? '');
    expect(laneNameOf(lanes, 'gone')).toBe('gone');
    expect(laneNameOf(null, 'gone')).toBe('gone');
  });
});

describe('verdictLanes', () => {
  const verify = lanes.lanes.find(lane => lane.category === 'verify')?.id ?? '';

  it('goes to Closed and to the last active lane from a verify lane', () => {
    const active = lanes.lanes.filter(lane => lane.category === 'active');
    expect(verdictLanes(lanes, verify)).toEqual({
      closeLaneId: lanes.lanes.find(lane => lane.category === 'closed')?.id ?? null,
      reworkLaneId: active[active.length - 1]?.id ?? null,
    });
  });

  it('is absent outside a verify lane and without lanes', () => {
    expect(verdictLanes(lanes, 'implement')).toBeNull();
    expect(verdictLanes(lanes, 'gone')).toBeNull();
    expect(verdictLanes(null, verify)).toBeNull();
  });

  it('has no close or rework lane when the set has neither', () => {
    const bare = { lanes: lanes.lanes.filter(lane => lane.category === 'verify') };
    expect(verdictLanes(bare, verify)).toEqual({ closeLaneId: null, reworkLaneId: null });
  });
});

describe('kindLabel', () => {
  it('names every kind', () => {
    expect(['bug', 'feature', 'infra', 'chore'].map(kind => kindLabel(kind as never))).toEqual([
      'Bug',
      'Feature',
      'Infra',
      'Chore',
    ]);
  });
});

describe('activityText', () => {
  const task = (activity: string, blocking = false) =>
    ({ activity, waitingOnOwner: blocking ? [{ sessionId: 's', id: 'A1' }] : [] }) as never;

  it('says what a verify lane waits for, whatever the card derived', () => {
    expect(activityText(task('active'), 'verify')).toBe('Waiting for you to try it');
  });

  it('says each liveness in words', () => {
    expect(activityText(task('active'), 'active')).toBe('A ferret is working on it');
    expect(activityText(task('idle'), null)).toBe('Idle');
    expect(activityText(task('stale'), null)).toMatch(/^Stale/u);
    expect(activityText(task('orphaned'), null)).toBe('No ferret is left on it');
  });

  it('tells a wait on the owner from a wait on something else', () => {
    expect(activityText(task('waiting', true), 'active')).toBe('Stopped until you answer');
    expect(activityText(task('waiting'), 'active')).toBe('Waiting on something outside the ferret');
  });
});

describe('prLine', () => {
  const pr = (extra: Partial<PrLink>): PrLink =>
    ({
      url: 'https://github.com/o/r/pull/1',
      number: 1,
      repo: 'o/r',
      state: 'open',
      draft: false,
      checks: 'none',
      mergedAt: null,
      mergeSha: null,
      releasedIn: null,
      polledAt: null,
      ...extra,
    }) as PrLink;

  it('reads a merged, closed or unpolled PR with no checks', () => {
    expect(prLine(pr({ state: 'merged' }))).toMatchObject({ state: 'Merged', checks: null, tone: 'ok' });
    expect(prLine(pr({ state: 'closed' }))).toMatchObject({ state: 'Closed', checks: null, tone: 'quiet' });
    expect(prLine(pr({ state: 'unknown' }))).toMatchObject({ state: 'Not polled yet', checks: null, tone: 'quiet' });
  });

  it('reads an open PR with its checks', () => {
    expect(prLine(pr({ checks: 'failing' }))).toMatchObject({ state: 'Open', checks: 'CI red', tone: 'err' });
    expect(prLine(pr({ checks: 'pending' }))).toMatchObject({ state: 'Open', checks: 'CI running', tone: 'pend' });
    expect(prLine(pr({ checks: 'passing', draft: true }))).toMatchObject({
      state: 'Draft',
      checks: 'CI green',
      tone: 'ok',
    });
    expect(prLine(pr({ checks: 'none' }))).toMatchObject({ state: 'Open', checks: null, tone: 'quiet' });
  });

  it('keeps the PR it was given', () => {
    const given = pr({});
    expect(prLine(given).pr).toBe(given);
  });
});

describe('linkLabel and isWebLink', () => {
  it('shortens a URL to its last path part, or its host when it has none', () => {
    expect(linkLabel('https://github.com/o/r/tree/feat-x')).toBe('feat-x');
    expect(linkLabel('https://example.test')).toBe('example.test');
    expect(linkLabel('feat/board')).toBe('feat/board');
  });

  it('only turns http(s) into an anchor', () => {
    expect(isWebLink('https://a.test')).toBe(true);
    expect(isWebLink('HTTP://a.test')).toBe(true);
    expect(isWebLink('javascript:alert(1)')).toBe(false);
    expect(isWebLink('docs/x.md')).toBe(false);
  });
});

describe('history', () => {
  const context: HistoryContext = {
    names: id => `ferret ${id}`,
    laneName: id => id.toUpperCase(),
  };
  const ferret = { kind: 'ferret', sessionId: 'abc' } as const;
  const event = (seq: number, type: string, extra: Record<string, unknown> = {}, actor: unknown = ferret) =>
    ({ seq, at: AT, actor, type, ...extra }) as unknown as BoardTaskEvent;
  const rowOf = (type: string, extra: Record<string, unknown> = {}) => {
    const [row] = historyRows([event(1, type, extra)], context);
    if (row === undefined) throw new Error('no row');
    return row;
  };

  it('lists the events newest first, naming each actor', () => {
    const rows = historyRows(
      [
        event(1, 'created', { laneId: 'todo' }, { kind: 'owner' }),
        event(3, 'note', { text: 'hi' }, { kind: 'daemon' }),
        event(2, 'note', { text: 'yo' }),
      ],
      context,
    );
    expect(rows.map(row => [row.seq, row.actor])).toEqual([
      [3, 'Ferretry'],
      [2, 'ferret abc'],
      [1, 'You'],
    ]);
    expect(rows[2]).toMatchObject({ text: 'opened it in TODO', detail: null, minor: false, type: 'created', at: AT });
  });

  it('names a move on the admin token as the token, never as you', () => {
    const rows = historyRows(
      [event(2, 'note', { text: 'hi', actorVia: 'admin-token' }, { kind: 'owner' }), event(1, 'note', { text: 'yo' })],
      context,
    );
    expect(rows.map(row => [row.actor, row.actorNote])).toEqual([
      ['Admin token', 'the owner at this machine, or a ferret without its own credential'],
      ['ferret abc', null],
    ]);
  });

  it('names a reported trigger as by its reporter, never as Ferretry, with the token said for what it is', () => {
    const moved = { from: 'a', to: 'b', backward: false, reason: 'deployed', auto: true, trigger: 'deploy.done' };
    const daemon = { kind: 'daemon' };
    const rows = historyRows(
      [
        event(2, 'moved', { ...moved, reportedBy: { kind: 'owner' }, reportedVia: 'admin-token' }, daemon),
        event(1, 'moved', { ...moved, reportedBy: ferret }, daemon),
      ],
      context,
    );
    expect(rows.map(row => [row.actor, row.actorNote, row.text, row.detail])).toEqual([
      [
        'Admin token',
        'the owner at this machine, or a ferret without its own credential',
        'reported deploy.done → moved A → B',
        'deployed',
      ],
      ['ferret abc', null, 'reported deploy.done → moved A → B', 'deployed'],
    ]);
    expect(rowOf('moved', { ...moved, trigger: undefined, reportedBy: ferret }).text).toBe(
      'reported a trigger → moved A → B',
    );
  });

  it('does not reorder the history it is given', () => {
    const given = [event(1, 'note', { text: 'a' }), event(2, 'note', { text: 'b' })];
    historyRows(given, context);
    expect(given.map(entry => entry.seq)).toEqual([1, 2]);
  });

  it('says each move in words', () => {
    expect(rowOf('moved', { from: 'a', to: 'b', backward: false, reason: null })).toMatchObject({
      text: 'moved A → B',
      detail: null,
    });
    expect(rowOf('moved', { from: 'b', to: 'a', backward: true, reason: 'broke' })).toMatchObject({
      text: 'moved back B → A',
      detail: 'broke',
    });
    expect(rowOf('moved', { from: 'a', to: 'b', backward: false, reason: null, auto: true }).text).toBe(
      'moved automatically A → B',
    );
    expect(
      rowOf('reopened', {
        from: 'a',
        to: 'b',
        reason: 'see the pictures',
        attachments: [
          { id: `att_${'a'.repeat(64)}`, filename: 'one.png', mime: 'image/png' },
          { id: `att_${'b'.repeat(64)}`, filename: 'two.png', mime: 'image/png' },
        ],
      }),
    ).toMatchObject({ text: 'reopened A → B with 2 images', detail: 'see the pictures' });
    expect(rowOf('reopened', { from: 'a', to: 'b', reason: 'again' })).toMatchObject({
      text: 'reopened A → B',
      detail: 'again',
    });
  });

  it('carries the words of notes, clarifications, blocks and drops as the detail', () => {
    expect(rowOf('note', { text: 'n' })).toMatchObject({ text: 'noted', detail: 'n' });
    expect(rowOf('clarified', { text: 'c' })).toMatchObject({ text: 'clarified the ask', detail: 'c' });
    expect(rowOf('blocked', { reason: 'r' })).toMatchObject({ text: 'blocked', detail: 'r' });
    expect(rowOf('unblocked', { reason: 'r' })).toMatchObject({ text: 'unblocked', detail: 'r' });
    expect(rowOf('dropped', { reason: 'r' })).toMatchObject({ text: 'dropped it', detail: 'r' });
    expect(rowOf('snoozed', { until: '2026-08-02T13:00:00.000Z' })).toMatchObject({
      text: 'snoozed it until 2026-08-02T13:00:00.000Z',
      minor: true,
    });
    expect(rowOf('snoozed', { until: null })).toMatchObject({ text: 'woke it from snooze' });
    expect(rowOf('refiled', { reason: 'r' })).toMatchObject({ text: 'moved it to another project', detail: 'r' });
    expect(rowOf('migrated', { legacyRef: '#F1' }).text).toBe('brought it over from #F1');
  });

  it('says a re-parent, from top level, between cards and back to top level', () => {
    const a = { id: 'F1' };
    const b = { id: 'F2' };
    expect(rowOf('reparented', { from: null, to: a, reason: 'r' })).toMatchObject({
      text: 'moved it under &F1 (was top level)',
      detail: 'r',
    });
    expect(rowOf('reparented', { from: a, to: b, reason: null }).text).toBe('moved it under &F2 (was under &F1)');
    expect(rowOf('reparented', { from: a, to: null, reason: null }).text).toBe(
      'made it a top-level card (was under &F1)',
    );
  });

  it('says an assignment, a reassignment and an unassignment', () => {
    expect(rowOf('assigned', { from: null, to: 'x' }).text).toBe('assigned it to ferret x');
    expect(rowOf('assigned', { from: 'y', to: 'x' }).text).toBe('assigned it to ferret x (was ferret y)');
    expect(rowOf('assigned', { from: 'y', to: null }).text).toBe('took the assignee off');
  });

  it('says a dependency, with an override when it had one', () => {
    const task = { id: 'F2' };
    expect(rowOf('depended', { task, until: 'merged' })).toMatchObject({
      text: 'now waits for &F2 to be merged',
      detail: null,
    });
    expect(rowOf('depended', { task, until: 'merged', override: { reason: 'urgent' } }).detail).toBe(
      'Overridden: urgent',
    );
    expect(rowOf('undepended', { task, reason: 'gone' })).toMatchObject({
      text: 'no longer waits for &F2',
      detail: 'gone',
    });
  });

  it('marks the small bookkeeping events as minor', () => {
    expect(rowOf('linked', { field: 'pr', value: 'u' })).toMatchObject({
      text: 'linked a pr',
      detail: 'u',
      minor: true,
    });
    expect(rowOf('field-edited', { field: 'title' })).toMatchObject({ text: 'edited the title', minor: true });
    expect(rowOf('field-edited', { field: 'howToTest' })).toMatchObject({ text: 'edited How to test', minor: true });
    expect(rowOf('file-claimed', { path: 'a.ts' })).toMatchObject({ text: 'claimed a.ts', minor: true });
    expect(rowOf('file-released', { path: 'a.ts', reason: 'done' })).toMatchObject({
      text: 'released a.ts',
      detail: 'done',
      minor: true,
    });
    expect(rowOf('ordered')).toMatchObject({ text: 'reordered it in its lane', minor: true });
  });
});

describe('nonBlockingAsks', () => {
  it('leaves out the asks that are stopping the ferret', () => {
    const open: AgendaRef[] = [
      { sessionId: 's', id: 'A1' },
      { sessionId: 's', id: 'A2' },
    ];
    const task = { openAsks: open, waitingOnOwner: [{ sessionId: 's', id: 'A1' }] };
    expect(nonBlockingAsks(task)).toEqual([{ sessionId: 's', id: 'A2' }]);
    expect(nonBlockingAsks({ openAsks: open, waitingOnOwner: [] })).toEqual(open);
  });
});

describe('messages the owner sends', () => {
  it('tags a comment with the card', () => {
    expect(commentTag({ id: 'F412' })).toBe('[re &F412]');
    expect(ferretComment({ id: 'F412' }, '  look at this  ')).toBe('[re &F412] look at this');
  });

  it('trims a history note and bounds its length', () => {
    expect(commentNote('  hi  ')).toBe('hi');
    expect(commentNote('x'.repeat(MAX_BOARD_NOTE_LENGTH + 50))).toHaveLength(MAX_BOARD_NOTE_LENGTH);
  });

  it('briefs a started ferret with the title and the ask', () => {
    const brief = startBrief({ title: ' Try it ', ask: ' do it ' });
    expect(brief.startsWith('Try it\n\ndo it\n\n')).toBe(true);
    expect(brief).toContain('board card');
  });

  it('tells a started ferret which card is its own', () => {
    expect(assignedMessage({ id: 'F9', title: 'Try it' })).toBe(
      '[re &F9] The owner assigned this card to you: Try it. Keep it current as you work.',
    );
  });
});

describe('newCardProblems', () => {
  it('is empty for a ready card', () => {
    expect(newCardProblems({ title: 'Try it', ask: 'do it' }, 's')).toEqual([]);
  });

  it('lists what is missing in the order the form shows it', () => {
    expect(newCardProblems({ title: ' ', ask: ' ' }, null)).toEqual(['title-empty', 'ask-empty', 'assignee-missing']);
  });

  it('allows five words in a title and no more', () => {
    expect(newCardProblems({ title: 'one two three four five', ask: 'x' }, 's')).toEqual([]);
    expect(newCardProblems({ title: 'one two three four five six', ask: 'x' }, 's')).toEqual(['title-long']);
  });

  it('has words for every problem', () => {
    expect(Object.keys(NEW_CARD_PROBLEM_TEXT).sort()).toEqual([
      'ask-empty',
      'assignee-missing',
      'title-empty',
      'title-long',
    ]);
    expect(OWNER_CARD_SOURCE).toBe('owner (board)');
  });
});

describe('collectAsks', () => {
  const item = (id: string) => ({ id, subject: `ask ${id}` });
  const resolvedItem = (id: string, resolvedAt: string, task: unknown) => ({ ...item(id), resolvedAt, task });
  const snapshot = (sessionId: string, items: unknown[], resolved: unknown[] = []): SessionAgenda => ({
    sessionId,
    snapshot: { sessionId, items, resolved } as unknown as AgendaSnapshot,
  });
  const task = card('F1', {
    openAsks: [
      { sessionId: 's1', id: 'A1' },
      { sessionId: 's1', id: 'A2' },
      { sessionId: 's2', id: 'A9' },
    ],
    waitingOnOwner: [{ sessionId: 's1', id: 'A1' }],
  });

  it('joins each open ask to its agenda item and says which one blocks', () => {
    const asks = collectAsks(task, [snapshot('s1', [item('A1'), item('A2')]), snapshot('s2', [])]);
    expect(asks.open.map(row => [row.ref.id, row.item?.id ?? null, row.blocking])).toEqual([
      ['A1', 'A1', true],
      ['A2', 'A2', false],
      ['A9', null, false],
    ]);
    expect(asks.reading).toBe(false);
  });

  it('keeps an ask whose agenda is not read yet, and says it is still reading', () => {
    const asks = collectAsks(task, [snapshot('s1', [item('A1')]), { sessionId: 's2', snapshot: null }]);
    expect(asks.open).toHaveLength(3);
    expect(asks.open[2]?.item).toBeNull();
    expect(asks.reading).toBe(true);
  });

  it('keeps an ask whose ferret has no agenda entry at all', () => {
    expect(collectAsks(task, []).open.map(row => row.item)).toEqual([null, null, null]);
  });

  it('collects the resolved asks about this card, newest first', () => {
    const asks = collectAsks(task, [
      snapshot(
        's1',
        [],
        [
          resolvedItem('R1', '2026-07-01T00:00:00.000Z', { id: 'F1' }),
          resolvedItem('R2', '2026-07-03T00:00:00.000Z', { id: 'F1', machineId: task.machineId }),
          resolvedItem('R3', '2026-07-02T00:00:00.000Z', { id: 'F2' }),
          resolvedItem('R4', '2026-07-04T00:00:00.000Z', { id: 'F1', machineId: 'another-box' }),
          resolvedItem('R5', '2026-07-05T00:00:00.000Z', null),
          resolvedItem('R6', '2026-07-06T00:00:00.000Z', undefined),
        ],
      ),
      snapshot('s2', [], [resolvedItem('R7', '2026-07-02T12:00:00.000Z', { id: 'F1' })]),
    ]);
    expect(asks.resolved.map(entry => entry.item.id)).toEqual(['R2', 'R7', 'R1']);
  });

  it('has no asks for a card with none', () => {
    const quiet = card('F3');
    expect(collectAsks(quiet, [])).toEqual({ open: [], resolved: [], reading: false });
  });
});

describe('askSessions', () => {
  it('lists the sessions that raised an ask, the owner and the assignee, once each', () => {
    expect(
      askSessions({
        openAsks: [
          { sessionId: 's1', id: 'A1' },
          { sessionId: 's1', id: 'A2' },
          { sessionId: 's2', id: 'A3' },
        ],
        owner: 's2',
        assignee: 's3',
      }),
    ).toEqual(['s1', 's2', 's3']);
  });

  it('leaves out an assignee the card does not have', () => {
    expect(askSessions({ openAsks: [], owner: 's1', assignee: null })).toEqual(['s1']);
  });
});

describe('written and hasLinks', () => {
  it('counts only non-blank prose as written', () => {
    expect(written('')).toBe(false);
    expect(written('  \n ')).toBe(false);
    expect(written('why')).toBe(true);
  });

  it('has links for a PR, a branch, a doc or a release, and none otherwise', () => {
    const bare = card('F1', {});
    expect(hasLinks(bare)).toBe(false);
    const links = bare.links;
    expect(hasLinks({ ...bare, links: { ...links, branch: 'feat/x' } })).toBe(true);
    expect(hasLinks({ ...bare, links: { ...links, docs: ['a.md'] } })).toBe(true);
    expect(hasLinks({ ...bare, links: { ...links, prs: [{} as PrLink] } })).toBe(true);
    expect(hasLinks({ ...bare, shippedIn: { version: '1.0.0', tag: 'v1.0.0', at: '2026-08-01T09:50:00.000Z' } })).toBe(
      true,
    );
  });
});

describe('testSteps', () => {
  it('splits a numbered or bulleted list into steps, with the text before it as the lead', () => {
    expect(testSteps('On the Mac, v4.157:\n\n1. Open **Board**\n2) Tap &F1\n3. See it')).toEqual({
      lead: 'On the Mac, v4.157:',
      steps: ['Open **Board**', 'Tap &F1', 'See it'],
    });
    expect(testSteps('- one\n* two\n+ three')).toEqual({ lead: null, steps: ['one', 'two', 'three'] });
  });

  it('keeps a step’s own lines with it: a second paragraph, an indented diagram', () => {
    const fence = '`'.repeat(3);
    const text = [
      '1. Open it',
      '',
      '   then wait',
      '2. Compare',
      `   ${fence}mermaid`,
      '   graph TB',
      '     A-->B',
      `   ${fence}`,
    ].join('\n');
    expect(testSteps(text)?.steps).toEqual([
      'Open it\n\nthen wait',
      `Compare\n${fence}mermaid\ngraph TB\n  A-->B\n${fence}`,
    ]);
  });

  it('is null for text that is not a list, or that carries on after the list', () => {
    expect(testSteps('Just open it and look.')).toBeNull();
    expect(testSteps('')).toBeNull();
    expect(testSteps('1. Open it\n2. Look\nThen you are done.')).toBeNull();
  });
});

describe('askOrigin', () => {
  const names = (id: string): string => (id === 's1' ? 'denisha' : 'ottilie');
  const base = { createdAt: '2026-08-01T09:00:00.000Z' } as const;

  it('says the owner, in the chat the ask came from', () => {
    const origin = askOrigin(
      { ...base, createdBy: { kind: 'owner' }, ask: { text: 't', source: 'session:s1' } },
      names,
      '3h',
    );
    expect(origin).toEqual({ who: 'you', sessionId: 's1', chat: "denisha's chat", via: null, age: '3h' });
  });

  it('says a ferret by name, and keeps a source that is neither a session nor the owner', () => {
    const origin = askOrigin(
      { ...base, createdBy: { kind: 'ferret', sessionId: 's2' }, ask: { text: 't', source: 'cli' } },
      names,
      null,
    );
    expect(origin).toEqual({ who: 'ottilie', sessionId: null, chat: null, via: 'cli', age: null });
  });

  it('says the admin token for what it is when it opened the card: the owner, or a ferret', () => {
    const origin = askOrigin(
      { ...base, createdBy: { kind: 'owner' }, createdByVia: 'admin-token', ask: { text: 't', source: 'cli' } },
      names,
      null,
    );
    expect(origin.who).toBe('the admin token (the owner at this machine, or a ferret without its own credential)');
  });

  it('drops the owner’s own source label and names the daemon when it opened the card', () => {
    const origin = askOrigin(
      { ...base, createdBy: { kind: 'daemon' }, ask: { text: 't', source: 'owner (board)' } },
      names,
      null,
    );
    expect(origin.who).toBe('the daemon');
    expect(origin.via).toBeNull();
  });
});

describe('askWords', () => {
  it('drops the raw note a ferret leaves in front of the ask', () => {
    expect(askWords('(sada, found live) Fix the login')).toBe('Fix the login');
    expect(askWords('  (note)\nFix the login  ')).toBe('Fix the login');
  });

  it('keeps words that do not start with a note, and a parenthesis that is all there is', () => {
    expect(askWords('Fix the login (again)')).toBe('Fix the login (again)');
    expect(askWords('(just this)')).toBe('(just this)');
  });
});
