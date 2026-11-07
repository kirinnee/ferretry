import { describe, expect, it } from 'bun:test';
import type { CardEvent, PrLink } from '../../../contract/index.ts';

import {
  activityText,
  askOrigin,
  askWords,
  type HistoryContext,
  hasLinks,
  historyRows,
  isWebLink,
  kindLabel,
  laneCategoryOf,
  laneNameOf,
  linkLabel,
  prLine,
  testSteps,
  written,
} from '../../../app/lib/board-detail.ts';
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
  const ferret = { kind: 'ferret', ferret: 'abc' } as const;
  const event = (seq: number, type: string, extra: Record<string, unknown> = {}, actor: unknown = ferret) =>
    ({ seq, at: AT, actor, type, ...extra }) as unknown as CardEvent;
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
      [event(2, 'note', { text: 'hi' }, { kind: 'owner', via: 'admin-token' }), event(1, 'note', { text: 'yo' })],
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
        event(2, 'moved', { ...moved, reportedBy: { kind: 'owner', via: 'admin-token' } }, daemon),
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
    expect(rowOf('assigned', { from: 'y', to: 'x', claimedFrom: 'y' }).text).toBe('claimed by ferret x from ferret y');
    expect(rowOf('assigned', { from: 'y', to: 'x', returnedFrom: 'y' }).text).toBe(
      'returned to ferret x: ferret y finished',
    );
    expect(rowOf('assigned', { from: 'z', to: 'x', adopted: { from: 'y', reason: 'nobody is left' } }).text).toBe(
      'adopted by ferret x from ferret y, whose ferrets ended: nobody is left',
    );
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
    expect(rowOf('field-edited', { field: 'progress' })).toMatchObject({ text: 'edited the progress', minor: true });
    expect(rowOf('file-claimed', { path: 'a.ts' })).toMatchObject({ text: 'claimed a.ts', minor: true });
    expect(rowOf('file-released', { path: 'a.ts', reason: 'done' })).toMatchObject({
      text: 'released a.ts',
      detail: 'done',
      minor: true,
    });
    expect(rowOf('ordered')).toMatchObject({ text: 'reordered it in its lane', minor: true });
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
  const steps = (...entries: readonly (readonly [number, string])[]) => ({
    kind: 'steps' as const,
    steps: entries.map(([n, text]) => ({ n, text })),
  });

  it('splits a numbered or bulleted list into steps, with the text before it as the lead', () => {
    expect(testSteps('On the Mac, v4.157:\n\n1. Open **Board**\n2) Tap &F1\n3. See it')).toEqual({
      lead: 'On the Mac, v4.157:',
      blocks: [steps([1, 'Open **Board**'], [2, 'Tap &F1'], [3, 'See it'])],
    });
    expect(testSteps('- one\n* two\n+ three')).toEqual({
      lead: null,
      blocks: [steps([1, 'one'], [2, 'two'], [3, 'three'])],
    });
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
    expect(testSteps(text)?.blocks).toEqual([
      steps([1, 'Open it\n\nthen wait'], [2, `Compare\n${fence}mermaid\ngraph TB\n  A-->B\n${fence}`]),
    ]);
  });

  it('keeps the number a run starts at, and counts on from it', () => {
    expect(testSteps('2FA codes\n4. Run it\n5. Enter it\n9. Done')?.blocks).toEqual([
      steps([4, 'Run it'], [5, 'Enter it'], [6, 'Done']),
    ]);
  });

  it('draws a heading or a paragraph set apart between steps as a section, and restarts the number after it', () => {
    const text =
      '## Setup\n1. Open it → see `fy`\n2. Look\n\n## 2FA codes\n4. Run **it**\n\nThen check:\n- tick\n\nLast';
    expect(testSteps(text)).toEqual({
      lead: '## Setup',
      blocks: [
        steps([1, 'Open it → see `fy`'], [2, 'Look']),
        { kind: 'section', text: '## 2FA codes' },
        steps([4, 'Run **it**']),
        { kind: 'section', text: 'Then check:' },
        steps([5, 'tick']),
        { kind: 'section', text: 'Last' },
      ],
    });
  });

  it('starts a section at a heading even without a blank line, and keeps a multi-line label whole', () => {
    expect(testSteps('1. a\n## Next\nmore label\n# Third\n2. b')?.blocks).toEqual([
      steps([1, 'a']),
      { kind: 'section', text: '## Next\nmore label' },
      { kind: 'section', text: '# Third' },
      steps([2, 'b']),
    ]);
  });

  it('reads a line right under a step, with no blank line, as that step’s own next line', () => {
    expect(testSteps('1. Open it\nthen look\n   and wait\n2. Go')?.blocks).toEqual([
      steps([1, 'Open it\nthen look\nand wait'], [2, 'Go']),
    ]);
  });

  it('never reads a list inside a fence as steps, in the lead, a step or a section', () => {
    const fence = '`'.repeat(3);
    const lead = `${fence}\n1. not a step\n${fence}\n1. real`;
    expect(testSteps(lead)).toEqual({
      lead: `${fence}\n1. not a step\n${fence}`,
      blocks: [steps([1, 'real'])],
    });
    const inStep = `1. run\n   ${fence}\n   2. no\n\n   ${fence}\n2. real`;
    expect(testSteps(inStep)?.blocks).toEqual([steps([1, `run\n${fence}\n2. no\n\n${fence}`], [2, 'real'])]);
    const inSection = `1. a\n\nLabel\n${fence}\n- no\n\n## still\n${fence}\n- yes`;
    expect(testSteps(inSection)?.blocks).toEqual([
      steps([1, 'a']),
      { kind: 'section', text: `Label\n${fence}\n- no\n\n## still\n${fence}` },
      steps([2, 'yes']),
    ]);
  });

  it('is null for text that is not a list', () => {
    expect(testSteps('Just open it and look.')).toBeNull();
    expect(testSteps('')).toBeNull();
    expect(testSteps('## Heading\nOnly words')).toBeNull();
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
      { ...base, createdBy: { kind: 'ferret', name: 's2', ferret: 's2' }, ask: { text: 't', source: 'cli' } },
      names,
      null,
    );
    expect(origin).toEqual({ who: 'ottilie', sessionId: null, chat: null, via: 'cli', age: null });
  });

  it('says the admin token for what it is when it opened the card: the owner, or a ferret', () => {
    const origin = askOrigin(
      { ...base, createdBy: { kind: 'owner', via: 'admin-token' }, ask: { text: 't', source: 'cli' } },
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
