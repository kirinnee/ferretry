import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import type { ComponentProps } from 'react';
import { allMachinesView, type MachineSource } from '../../src/lib/all-machines.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { SessionsBar } from '../../src/shell/sessions-bar.tsx';
import {
  attentionWords,
  hasAttention,
  pullNeedsYou,
  rowPreview,
  sessionRowPath,
  sessionsBarView,
} from '../../src/shell/sessions-bar-model.ts';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const DAEMON = 'alpha' as DaemonId;
const BETA = 'beta' as DaemonId;
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const recent = new Date(NOW - 60_000).toISOString();
const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const attention = (open: number, first: string, minutesAgo: number, ask = `Ask ${first}?`) => ({
  open,
  first,
  ask,
  latestAt: at(minutesAgo),
});

/** A running session with open Attention, raised `minutesAgo` minutes before NOW. */
const unread = (
  id: string,
  open: number,
  first: string,
  minutesAgo: number,
  extra: SessionView['state'] | object = {},
) =>
  sessionView(id, {
    config: { teammate: id, label: `Task ${id}`, cwd: `/work/${id}`, mode: 'interactive' },
    state: { lastActivityAt: recent, attention: attention(open, first, minutesAgo), ...extra },
  });

const calm = (id: string) =>
  sessionView(id, {
    config: { teammate: id, label: `Task ${id}`, cwd: `/work/${id}`, mode: 'interactive' },
    state: { lastActivityAt: recent },
  });

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

type BarProps = ComponentProps<typeof SessionsBar>;

const bar = (props: Partial<BarProps> = {}) => {
  const calls: string[] = [];
  const element = (
    <SessionsBar
      active={null}
      activeSessionId={null}
      daemonId={DAEMON}
      machineName="work-mac"
      initialMode="all"
      machines={[
        { daemonId: DAEMON, name: 'work-mac' },
        { daemonId: BETA, name: 'kirin-box' },
      ]}
      onAddMachine={() => calls.push('add-machine')}
      onCollapse={() => calls.push('collapse')}
      onNavigate={to => calls.push(`navigate:${to}`)}
      onOpenPalette={() => calls.push('palette')}
      presentation="column"
      projects={[]}
      sessions={[
        calm('calm-1'),
        unread('old-1', 2, 'A2', 30),
        unread('new-1', 1, 'A7', 5),
        unread('tie-a', 1, 'A1', 10),
        unread('tie-b', 1, 'A9', 10),
      ]}
      {...props}
    />
  );
  return { calls, element };
};

const click = async (element: Element | null, what: string): Promise<void> => {
  await interact(() => (must(element, what) as HTMLElement).click());
};

const ids = (root: Element): (string | null)[] =>
  [...root.querySelectorAll('[data-sbar-session]')].map(node => node.getAttribute('data-sbar-session'));

describe('unread rows in the sessions bar', () => {
  test('lists Needs you first, newest latestAt first, ties in their arrival order, and not again in a project group', async () => {
    view = await mount(bar().element);
    const group = must(view.container.querySelector('[data-sbar-needs-you-group]'), 'the Needs you group');
    expect(ids(group)).toEqual(['new-1', 'tie-a', 'tie-b', 'old-1']);
    // Each session is drawn once on the page: the calm one in its folder, the unread ones only above.
    expect(ids(view.container).filter(id => id === 'old-1')).toHaveLength(1);
    expect(ids(view.container)).toHaveLength(5);
  });

  test('bolds the name, shows an accent count pill capped at 99+, and says the count to a screen reader', async () => {
    view = await mount(
      bar({ sessions: [unread('many', 150, 'A4', 1), unread('one', 1, 'A2', 2), calm('calm-1')] }).element,
    );
    const many = must(view.container.querySelector('[data-sbar-session="many"]'), 'the busy row');
    expect(many.hasAttribute('data-sbar-unread')).toBe(true);
    expect(many.querySelector('[data-unread-badge]')?.textContent).toContain('99+');
    expect(many.querySelector('.sr-only')?.textContent).toBe('150 open Inbox items');
    const one = must(view.container.querySelector('[data-sbar-session="one"]'), 'the single-item row');
    expect(one.querySelector('.sr-only')?.textContent).toBe('1 open Inbox item');
    const calmRow = must(view.container.querySelector('[data-sbar-session="calm-1"]'), 'the calm row');
    expect(calmRow.hasAttribute('data-sbar-unread')).toBe(false);
    expect(calmRow.querySelector('[data-unread-badge]')).toBeNull();
  });

  test('the whole row opens the conversation at the first open item, and shows the ask under the name', async () => {
    const { element, calls } = bar();
    view = await mount(element);
    const row = must(view.container.querySelector('[data-sbar-session="old-1"]'), 'the row');
    expect(row.getAttribute('href') ?? '').toContain('/session/old-1?attention=A2');
    expect(row.querySelector('[data-sbar-ask]')?.textContent).toBe('Ask A2?');
    await click(row, 'the unread row');
    expect(calls.at(-1)).toBe('navigate:/d/alpha/session/old-1?attention=A2');
    await click(view.container.querySelector('[data-sbar-session="calm-1"]'), 'the calm row');
    expect(calls.at(-1)).toBe('navigate:/d/alpha/session/calm-1');
  });

  test('stays until the summary disappears, and a stopped session with Attention is still listed', async () => {
    const stopped = unread('stopped-1', 1, 'A3', 3, { status: 'stopped' });
    view = await mount(bar({ sessions: [stopped, calm('calm-1')], initialMode: 'all' }).element);
    expect(ids(view.container)).toContain('stopped-1');
    await view.unmount();
    view = await mount(
      bar({ sessions: [{ ...stopped, state: { ...stopped.state, attention: undefined } }, calm('calm-1')] }).element,
    );
    expect(ids(view.container)).not.toContain('stopped-1');
  });
});

describe('a parked session is not Needs you', () => {
  const waiting = sessionView('waits', {
    config: { teammate: 'waits', label: 'Parked', cwd: '/work/waits', mode: 'interactive' },
    state: { status: 'awaiting_user', lastActivityAt: recent },
  });

  test('a parked session with no Attention has no badge and no waiting word, and stays in its folder', async () => {
    view = await mount(bar({ sessions: [waiting, unread('loud', 1, 'A1', 1)] }).element);
    const row = must(view.container.querySelector('[data-sbar-session="waits"]'), 'the parked row');
    expect(row.querySelector('[data-sbar-waiting]')).toBeNull();
    expect(row.querySelector('[data-unread-badge]')).toBeNull();
    const group = must(view.container.querySelector('[data-sbar-needs-you-group]'), 'the Needs you group');
    expect(ids(group)).toEqual(['loud']);
  });

  test('across machines only Attention rows are pinned', () => {
    const source = (daemonId: DaemonId, name: string, sessions: SessionView[]): MachineSource => ({
      daemonId,
      name,
      reach: 'online',
      projects: [],
      slice: { sessions, byId: new Map(), status: 'ready', error: null },
    });
    const machines = [
      source(DAEMON, 'work-mac', [waiting, unread('older', 1, 'A1', 20)]),
      source(BETA, 'kirin-box', [unread('newer', 1, 'A2', 2)]),
    ];
    const filter = { mode: 'all' as const, showStopped: false };
    expect(allMachinesView(machines, { filter }).needsYou.map(entry => entry.view.config.id)).toEqual([
      'newer',
      'older',
    ]);
    expect(allMachinesView(machines, { filter, groupNeedsYou: false }).needsYou).toEqual([]);
  });
});

describe('the pure model', () => {
  test('hasAttention, sessionRowPath and attentionWords', () => {
    const loud = unread('loud', 3, 'A4', 1);
    expect(hasAttention(loud)).toBe(true);
    expect(hasAttention(calm('calm'))).toBe(false);
    expect(sessionRowPath(DAEMON, loud)).toBe('/d/alpha/session/loud?attention=A4');
    expect(sessionRowPath(DAEMON, calm('calm'))).toBe('/d/alpha/session/calm');
    expect(attentionWords(1)).toBe('1 open Inbox item');
    expect(attentionWords(3)).toBe('3 open Inbox items');
  });

  test('rowPreview prefers the Attention ask, collapses whitespace and falls back to the parked question', () => {
    expect(
      rowPreview(unread('a', 1, 'A1', 1, { attention: { ...attention(1, 'A1', 1), ask: 'Ship\n  it?' } })),
    ).toEqual({
      kind: 'attention',
      text: 'Ship it?',
    });
    expect(rowPreview(calm('c'))).toBeUndefined();
  });

  test('pullNeedsYou splits newest-first Attention from the rest, which keep their order', () => {
    const rows = [calm('x'), unread('a', 1, 'A1', 9), calm('y'), unread('b', 1, 'A2', 1)];
    const { waiting, rest } = pullNeedsYou(rows, row => row);
    expect(waiting.map(row => row.config.id)).toEqual(['b', 'a']);
    expect(rest.map(row => row.config.id)).toEqual(['x', 'y']);
  });

  test('sessionsBarView lifts Attention sessions out of the groups', () => {
    const result = sessionsBarView([calm('x'), unread('a', 1, 'A1', 9)], [], { mode: 'all', showStopped: false });
    expect(result.needsYou.map(row => row.config.id)).toEqual(['a']);
    expect(result.groups.flatMap(group => group.rows).map(row => row.config.id)).toEqual(['x']);
  });

  test('with grouping off nothing is lifted: the session stays in its project group', () => {
    const rows = [calm('x'), unread('a', 1, 'A1', 9)];
    expect(pullNeedsYou(rows, row => row, false).waiting).toEqual([]);
    const result = sessionsBarView(rows, [], { mode: 'all', showStopped: false }, undefined, false);
    expect(result.needsYou).toEqual([]);
    expect(
      result.groups
        .flatMap(group => group.rows)
        .map(row => row.config.id)
        .sort(),
    ).toEqual(['a', 'x']);
  });

  test('a Your turn session with no Attention items is not needs-you', () => {
    const turn = sessionView('turn', { state: { status: 'awaiting_user', lastActivityAt: recent } });
    const result = sessionsBarView([turn], [], { mode: 'all', showStopped: false });
    expect(result.needsYou).toEqual([]);
  });
});

describe('the collapsed rail', () => {
  test('puts the count on the unread dot, links it to ?attention=<first>, and sorts unread dots first', async () => {
    const { element, calls } = bar({ presentation: 'rail', onExpand: () => undefined, activeSessionId: 'calm-1' });
    view = await mount(element);
    const dots = [...view.container.querySelectorAll('.fy-sbar__dot')];
    expect(dots.map(dot => dot.getAttribute('aria-label'))).toEqual([
      'New-1 — 1 open Inbox item',
      'Tie-A — 1 open Inbox item',
      'Tie-B — 1 open Inbox item',
      'Old-1 — 2 open Inbox items',
      'Calm-1',
    ]);
    expect(dots[3]?.querySelector('[data-unread-badge]')?.textContent).toBe('2');
    expect(dots[4]?.querySelector('[data-unread-badge]')).toBeNull();
    expect(dots[4]?.getAttribute('aria-current')).toBe('page');
    await click(dots[3] ?? null, 'the unread dot');
    expect(calls.at(-1)).toBe('navigate:/d/alpha/session/old-1?attention=A2');
  });

  test('caps the dot badge at 99+', async () => {
    view = await mount(
      bar({ presentation: 'rail', onExpand: () => undefined, sessions: [unread('big', 120, 'A1', 1)] }).element,
    );
    expect(view.container.querySelector('.fy-sbar__dot [data-unread-badge]')?.textContent).toBe('99+');
  });
});

describe('the Attention entry', () => {
  test('column: a prominent row with the count badge, linking to attentionHref', async () => {
    const { element, calls } = bar({ attentionHref: '/d/alpha/attention', attentionTotal: 7 });
    view = await mount(element);
    const entry = must(view.container.querySelector('a[data-sbar-attention]'), 'the Attention entry');
    expect(entry.textContent).toContain('Inbox');
    expect(entry.querySelector('[data-unread-badge]')?.textContent).toContain('7');
    expect(entry.querySelector('.sr-only')?.textContent).toBe('7 open Inbox items');
    expect(entry.hasAttribute('aria-current')).toBe(false);
    await click(entry, 'the entry');
    expect(calls.at(-1)).toBe('navigate:/d/alpha/attention');
  });

  test('column: a calm zero state that is still a link, with no badge', async () => {
    view = await mount(bar({ attentionHref: '/d/alpha/attention', attentionTotal: 0 }).element);
    const entry = must(view.container.querySelector('a[data-sbar-attention]'), 'the Attention entry');
    expect(entry.textContent).toContain('Nothing waiting');
    expect(entry.querySelector('[data-unread-badge]')).toBeNull();
    expect(entry.getAttribute('href')).toBe('/d/alpha/attention');
  });

  test('is drawn only when the host gives it somewhere to go', async () => {
    view = await mount(bar({ attentionTotal: 4 }).element);
    expect(view.container.querySelector('[data-sbar-attention]')).toBeNull();
  });

  test('marks the inbox page as current', async () => {
    view = await mount(bar({ attentionHref: '/d/alpha/attention', attentionTotal: 1, active: 'attention' }).element);
    expect(view.container.querySelector('a[data-sbar-attention]')?.getAttribute('aria-current')).toBe('page');
  });

  test('drawer: the same row as the column', async () => {
    view = await mount(
      bar({ presentation: 'drawer', onClose: () => undefined, attentionHref: '/d/alpha/attention', attentionTotal: 2 })
        .element,
    );
    const entry = must(view.container.querySelector('a[data-sbar-attention]'), 'the drawer entry');
    expect(entry.querySelector('[data-unread-badge]')?.textContent).toContain('2');
  });

  test('rail: an icon button with the badge, whose label says the count', async () => {
    const { element, calls } = bar({
      presentation: 'rail',
      onExpand: () => undefined,
      attentionHref: '/d/alpha/attention',
      attentionTotal: 5,
    });
    view = await mount(element);
    const entry = must(view.container.querySelector('a[data-sbar-attention]'), 'the rail entry');
    expect(entry.getAttribute('aria-label')).toBe('Inbox — 5 open Inbox items');
    expect(entry.querySelector('[data-unread-badge]')?.textContent).toBe('5');
    await click(entry, 'the rail entry');
    expect(calls.at(-1)).toBe('navigate:/d/alpha/attention');
  });
});

describe('across every machine', () => {
  const source = (daemonId: DaemonId, name: string, sessions: SessionView[]): MachineSource => ({
    daemonId,
    name,
    reach: 'online',
    projects: [],
    slice: { sessions, byId: new Map(), status: 'ready', error: null },
  });
  const sources = [
    source(DAEMON, 'work-mac', [calm('calm-1'), unread('older', 1, 'A2', 20)]),
    source(BETA, 'kirin-box', [unread('newer', 3, 'A8', 2)]),
  ];

  test('the column pins Attention sessions of every machine, newest first, each opening at its item on its machine', async () => {
    const { element, calls } = bar({ machineSources: sources, sessions: sources[0]?.slice.sessions ?? null, now: NOW });
    view = await mount(element);
    const group = must(view.container.querySelector('[data-sbar-needs-you-group]'), 'the Needs you group');
    expect(ids(group)).toEqual(['newer', 'older']);
    const newer = must(group.querySelector('[data-sbar-session="newer"]'), 'the newer row');
    expect(newer.querySelector('[data-unread-badge]')?.textContent).toContain('3');
    await click(newer, 'the newer row');
    expect(calls.at(-1)).toBe('navigate:/d/beta/session/newer?attention=A8');
  });

  test('the rail badges the unread dots and puts them first', async () => {
    const { element, calls } = bar({
      presentation: 'rail',
      onExpand: () => undefined,
      machineSources: sources,
      sessions: sources[0]?.slice.sessions ?? null,
      now: NOW,
    });
    view = await mount(element);
    const dots = [...view.container.querySelectorAll('.fy-sbar__dot')];
    expect(dots.map(dot => dot.getAttribute('data-sbar-unread'))).toEqual(['', '', null]);
    expect(dots[0]?.querySelector('[data-unread-badge]')?.textContent).toBe('3');
    await click(dots[0] ?? null, 'the first dot');
    expect(calls.at(-1)).toBe('navigate:/d/beta/session/newer?attention=A8');
  });
});
