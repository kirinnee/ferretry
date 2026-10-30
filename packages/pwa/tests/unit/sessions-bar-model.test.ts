import { describe, expect, test } from 'bun:test';
import { PACK_CLEAN_UP_LABEL } from '@ferretry/protocol';
import {
  DEFAULT_LIST_FILTER,
  isGuideBuilder,
  isStopped,
  listedBeforeMode,
  listTallies,
  matchesMode,
  pendingQuestionPreview,
  sessionsBarDirectory,
  sessionsBarNames,
  sessionsBarSubline,
  hasAgenda,
  sessionsBarView,
  sidebarCompact,
} from '../../src/shell/sessions-bar-model.ts';
import { sessionView } from '../support/sessions.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const ago = (milliseconds: number): string => new Date(NOW - milliseconds).toISOString();
const DAY = 24 * 60 * 60 * 1000;

describe('how much a row says', () => {
  test('is one line unless the reader chose Full', () => {
    expect(sidebarCompact(undefined)).toBe(true);
    expect(sidebarCompact(null)).toBe(true);
    expect(sidebarCompact('compact')).toBe(true);
    expect(sidebarCompact('minimal')).toBe(true);
    expect(sidebarCompact('full')).toBe(false);
  });
});

describe('who needs the reader', () => {
  test('only open Attention does: a parked session with no items is not Needs you, one with an item is', () => {
    const parked = sessionView('a', { state: { status: 'awaiting_user' } });
    const asking = sessionView('b', { state: { status: 'awaiting_question', needsHuman: 'approve' } });
    const filter = { mode: 'all' as const, showStopped: false };
    expect(sessionsBarView([parked, asking], [], filter).needsYou).toEqual([]);
    const filed = sessionView('c', {
      state: { status: 'awaiting_user', attention: { open: 1, first: 'A1', latestAt: ago(1_000) } as never },
    });
    expect(sessionsBarView([parked, filed], [], filter).needsYou.map(row => row.config.id)).toEqual(['c']);
  });

  test('grouping off leaves the Attention session in its project group, still unread', () => {
    const filed = sessionView('c', {
      state: { status: 'running', attention: { open: 1, first: 'A1', latestAt: ago(1_000) } as never },
    });
    const result = sessionsBarView([filed], [], { mode: 'all', showStopped: false }, undefined, false);
    expect(result.needsYou).toEqual([]);
    expect(result.groups.flatMap(group => group.rows).map(row => row.config.id)).toEqual(['c']);
    expect(hasAgenda(filed)).toBe(true);
  });

  test('stopped is the status mark’s own finished class, kill_failed included', () => {
    expect(isStopped(sessionView('a'))).toBe(false);
    expect(isStopped(sessionView('b', { state: { status: 'waiting' } }))).toBe(false);
    for (const status of ['completed', 'failed', 'stalled', 'stopped', 'kill_failed'] as const)
      expect(isStopped(sessionView(status, { state: { status } }))).toBe(true);
  });

  test('a kind of session is its mode; All is every mode', () => {
    const agent = sessionView('a', { config: { mode: 'auto' } });
    const person = sessionView('p', { config: { mode: 'interactive' } });
    expect([agent, person].map(view => matchesMode(view, 'all'))).toEqual([true, true]);
    expect([agent, person].map(view => matchesMode(view, 'auto'))).toEqual([true, false]);
    expect([agent, person].map(view => matchesMode(view, 'interactive'))).toEqual([false, true]);
  });
});

const ALL_KINDS = { ...DEFAULT_LIST_FILTER, mode: 'all' as const };
const SHOW_STOPPED = { ...ALL_KINDS, showStopped: true };

test('a new device opens on the sessions a person drives, stopped ones tucked away', () => {
  expect(DEFAULT_LIST_FILTER).toEqual({ mode: 'interactive', showStopped: false });
});

describe('which sessions the bar lists', () => {
  test('stopped sessions are hidden by default, however recently they stopped', () => {
    const alive = sessionView('alive');
    const done = sessionView('done', { state: { status: 'completed', lastActivityAt: ago(1_000) } });
    const view = sessionsBarView([alive, done], [], ALL_KINDS);
    expect(view.groups.flatMap(group => group.rows.map(row => row.config.id))).toEqual(['alive']);
    expect(view.counts.all).toBe(1);
    expect(view.hiddenStopped).toBe(1);
  });

  test('every session, however long ago it finished — nothing is cut by age', () => {
    const alive = sessionView('alive', { state: { lastActivityAt: ago(10 * DAY) } });
    const old = sessionView('old', { state: { status: 'completed', lastActivityAt: ago(30 * DAY) } });
    const undated = sessionView('undated', {
      config: { updatedAt: undefined as never },
      state: { status: 'stopped', lastActivityAt: undefined as never },
    });

    const view = sessionsBarView([alive, old, undated], [], SHOW_STOPPED);
    expect(view.counts.all).toBe(3);
    expect(view.hiddenStopped).toBe(0);
    expect(view.groups.flatMap(group => group.rows.map(row => row.config.id)).sort()).toEqual([
      'alive',
      'old',
      'undated',
    ]);
  });

  test('groups by project, newest first, and counts each kind over the same pool', () => {
    const sessions = [
      sessionView('a', { config: { cwd: '/work/ferretry' }, state: { lastActivityAt: ago(5_000) } }),
      sessionView('b', {
        config: { cwd: '/work/ferretry/packages' },
        state: { status: 'awaiting_user', lastActivityAt: ago(1_000) },
      }),
      sessionView('c', {
        config: { cwd: '/work/nitroso', mode: 'interactive' },
        state: { status: 'waiting', lastActivityAt: ago(2_000) },
      }),
      sessionView('gone', {
        config: { cwd: '/work/nitroso' },
        state: { status: 'completed', lastActivityAt: ago(3 * DAY) },
      }),
    ];
    const projects = [{ name: 'ferretry', path: '/work/ferretry' }];

    const all = sessionsBarView(sessions, projects, SHOW_STOPPED);
    expect(all.counts).toEqual({ all: 4, auto: 3, interactive: 1 });
    expect(all.groups.map(group => [group.name, group.rows.map(row => row.config.id)])).toEqual([
      ['ferretry', ['b', 'a']],
      ['nitroso', ['c', 'gone']],
    ]);

    const interactive = sessionsBarView(sessions, projects, { ...SHOW_STOPPED, mode: 'interactive' });
    expect(interactive.groups.flatMap(group => group.rows.map(row => row.config.id))).toEqual(['c']);
    // Choosing a kind never changes what the other segments say they would show.
    expect(interactive.counts).toEqual(all.counts);
    const agents = sessionsBarView(sessions, projects, { mode: 'auto', showStopped: false });
    expect(agents.groups.flatMap(group => group.rows.map(row => row.config.id))).toEqual(['b', 'a']);
    expect(agents.counts).toEqual({ all: 3, auto: 2, interactive: 1 });
  });

  test('"Show stopped" counts the stopped sessions of the kind chosen, and the open one stays listed', () => {
    const sessions = [
      sessionView('live'),
      sessionView('agent-done', { state: { status: 'completed' } }),
      sessionView('person-done', { config: { mode: 'interactive' }, state: { status: 'stopped' } }),
    ];
    expect(listTallies(sessions, ALL_KINDS).hiddenStopped).toBe(2);
    expect(listTallies(sessions, { mode: 'auto', showStopped: false }).hiddenStopped).toBe(1);
    expect(listTallies(sessions, { mode: 'interactive', showStopped: false }).hiddenStopped).toBe(1);
    expect(listTallies(sessions, SHOW_STOPPED).hiddenStopped).toBe(0);

    const open = (view: (typeof sessions)[number]) => view.config.id === 'agent-done';
    const kept = sessionsBarView(sessions, [], ALL_KINDS, open);
    expect(kept.groups.flatMap(group => group.rows.map(row => row.config.id)).sort()).toEqual(['agent-done', 'live']);
    expect(kept.counts.all).toBe(2);
    expect(kept.hiddenStopped).toBe(1);
  });

  test('the line under a name is its name, else its folder, and a label never replaces the name', () => {
    expect(sessionsBarSubline(sessionView('a', { config: { name: 'Fix the sign-in', label: 'diene-cyan' } }))).toBe(
      'Fix the sign-in',
    );
    expect(sessionsBarSubline(sessionView('b', { config: { name: 'Session b' } }))).toBe('Session b');
    expect(sessionsBarSubline(sessionView('c', { config: { name: undefined as never } }))).toBe('/work/c');
  });

  test('a row is titled by its name, the ferret second; with no name the ferret is the title', () => {
    const names = (config: Record<string, unknown>) => sessionsBarNames(sessionView('a', { config: config as never }));
    expect(names({ teammate: 'hadi', label: undefined, name: 'Diene Work' })).toEqual({
      title: 'Diene Work',
      ferret: 'Hadi',
    });
    expect(names({ teammate: 'hadi', label: undefined, name: '  ' })).toEqual({ title: 'Hadi', ferret: null });
    expect(names({ teammate: 'hadi', label: undefined, name: 'Hadi' })).toEqual({ title: 'Hadi', ferret: null });
    expect(names({ teammate: undefined, label: undefined, name: 'Home Manager' })).toEqual({
      title: 'Home Manager',
      ferret: null,
    });
    expect(names({ teammate: undefined, label: undefined, name: undefined })).toEqual({ title: 'a', ferret: null });
  });

  test('a batch label never takes the row title: a renamed, labelled session shows its new name', () => {
    const names = (name: string) =>
      sessionsBarNames(sessionView('a', { config: { teammate: 'hadi', name, label: 'diene-cyan' } }));
    expect(names('CyanPrint')).toEqual({ title: 'CyanPrint', ferret: 'Hadi' });
    expect(names('CyanPrint, renamed')).toEqual({ title: 'CyanPrint, renamed', ferret: 'Hadi' });
  });

  test('the directory line is the folder, with a home directory written as ~', () => {
    expect(sessionsBarDirectory(sessionView('a', { config: { cwd: '/home/kirin/Workspace/ferretry' } }))).toBe(
      '~/Workspace/ferretry',
    );
    expect(sessionsBarDirectory(sessionView('b', { config: { cwd: '/Users/erng/code' } }))).toBe('~/code');
    expect(sessionsBarDirectory(sessionView('c', { config: { cwd: '/home/kirin' } }))).toBe('~');
    expect(sessionsBarDirectory(sessionView('d', { config: { cwd: '/tmp/wt-session-layout' } }))).toBe(
      '/tmp/wt-session-layout',
    );
    expect(sessionsBarDirectory(sessionView('e', { config: { cwd: '/homestead/kirin' } }))).toBe('/homestead/kirin');
  });
});

describe('the question a waiting ferret asks', () => {
  const asking = (questions: readonly string[], status = 'awaiting_question' as const) =>
    sessionView('q', {
      state: {
        status,
        pendingQuestion: { toolUseId: 'tool-1', questions: questions.map(question => ({ question })) } as never,
      },
    });

  test('previews the first question on one line and says how many more follow', () => {
    expect(pendingQuestionPreview(asking(['Which   branch\nshould I rebase onto?']))).toBe(
      'Which branch should I rebase onto?',
    );
    expect(pendingQuestionPreview(asking(['Ship it?', 'And the docs?', 'And the tests?']))).toBe('Ship it? (+2 more)');
  });

  test('caps a long question so the row never carries a paragraph', () => {
    const preview = pendingQuestionPreview(asking(['x'.repeat(400)])) ?? '';
    expect(preview).toHaveLength(160);
    expect(preview.endsWith('…')).toBe(true);
  });

  test('says nothing when nothing is pending, the question is blank, or the ferret is over', () => {
    expect(pendingQuestionPreview(sessionView('none'))).toBeUndefined();
    expect(pendingQuestionPreview(sessionView('null', { state: { pendingQuestion: null } }))).toBeUndefined();
    expect(pendingQuestionPreview(asking(['   ']))).toBeUndefined();
    expect(pendingQuestionPreview(asking([]))).toBeUndefined();
    expect(pendingQuestionPreview(asking(['Still there?'], 'stopped' as never))).toBeUndefined();
  });
});

describe('guide-builder ferrets', () => {
  const builder = sessionView('builder', { config: { label: PACK_CLEAN_UP_LABEL } });
  const stoppedBuilder = sessionView('old-builder', {
    config: { label: PACK_CLEAN_UP_LABEL },
    state: { status: 'completed' },
  });
  const ordinary = sessionView('plain', { config: { label: 'my-batch' } });

  test('are not listed, whether live or stopped, and do not inflate the stopped tally', () => {
    expect(isGuideBuilder(builder)).toBe(true);
    expect(isGuideBuilder(ordinary)).toBe(false);
    expect(listedBeforeMode(builder, SHOW_STOPPED)).toBe(false);
    expect(listedBeforeMode(stoppedBuilder, SHOW_STOPPED)).toBe(false);
    expect(listedBeforeMode(ordinary, SHOW_STOPPED)).toBe(true);
    const tallies = listTallies([builder, stoppedBuilder, ordinary], ALL_KINDS);
    expect(tallies.counts.all).toBe(1);
    expect(tallies.hiddenStopped).toBe(0);
  });

  test('still show as the open session, so a direct link opens', () => {
    expect(listedBeforeMode(builder, ALL_KINDS, view => view.config.id === 'builder')).toBe(true);
  });
});
