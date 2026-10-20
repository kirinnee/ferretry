import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LIST_FILTER,
  isStopped,
  listTallies,
  matchesMode,
  needsYou,
  pendingQuestionPreview,
  sessionsBarDirectory,
  sessionsBarNames,
  sessionsBarSubline,
  sessionsBarView,
} from '../../src/shell/sessions-bar-model.ts';
import { sessionView } from '../support/sessions.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const ago = (milliseconds: number): string => new Date(NOW - milliseconds).toISOString();
const DAY = 24 * 60 * 60 * 1000;

describe('who needs the reader', () => {
  test('a session parked on a person, by any of the three ways it can say so', () => {
    expect(needsYou(sessionView('a', { state: { status: 'awaiting_user' } }))).toBe(true);
    expect(needsYou(sessionView('b', { state: { status: 'awaiting_question' } }))).toBe(true);
    expect(needsYou(sessionView('n', { state: { status: 'running', turnState: 'needs-input' } }))).toBe(true);
    expect(needsYou(sessionView('y', { state: { status: 'running', turnState: 'your-turn' } }))).toBe(false);
    expect(
      needsYou(
        sessionView('c', {
          state: { status: 'running', pendingQuestion: { toolUseId: 'q', questions: [] } as never },
        }),
      ),
    ).toBe(true);
    expect(needsYou(sessionView('d', { state: { status: 'running', needsHuman: 'approve the deploy' } }))).toBe(true);
  });

  test('never a session that is simply working, or one that is over', () => {
    expect(needsYou(sessionView('a'))).toBe(false);
    expect(needsYou(sessionView('b', { state: { status: 'running', needsHuman: '' } }))).toBe(false);
    expect(needsYou(sessionView('c', { state: { status: 'completed', needsHuman: 'stale ask' } }))).toBe(false);
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

const SHOW_STOPPED = { ...DEFAULT_LIST_FILTER, showStopped: true };

describe('which sessions the bar lists', () => {
  test('stopped sessions are hidden by default, however recently they stopped', () => {
    const alive = sessionView('alive');
    const done = sessionView('done', { state: { status: 'completed', lastActivityAt: ago(1_000) } });
    const view = sessionsBarView([alive, done], [], DEFAULT_LIST_FILTER);
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
    expect(listTallies(sessions, DEFAULT_LIST_FILTER).hiddenStopped).toBe(2);
    expect(listTallies(sessions, { mode: 'auto', showStopped: false }).hiddenStopped).toBe(1);
    expect(listTallies(sessions, { mode: 'interactive', showStopped: false }).hiddenStopped).toBe(1);
    expect(listTallies(sessions, SHOW_STOPPED).hiddenStopped).toBe(0);

    const open = (view: (typeof sessions)[number]) => view.config.id === 'agent-done';
    const kept = sessionsBarView(sessions, [], DEFAULT_LIST_FILTER, open);
    expect(kept.groups.flatMap(group => group.rows.map(row => row.config.id)).sort()).toEqual(['agent-done', 'live']);
    expect(kept.counts.all).toBe(2);
    expect(kept.hiddenStopped).toBe(1);
  });

  test('the line under a name is the task, else its name, else its folder', () => {
    expect(sessionsBarSubline(sessionView('a', { config: { label: 'Fix the sign-in' } }))).toBe('Fix the sign-in');
    expect(sessionsBarSubline(sessionView('b', { config: { name: 'Session b' } }))).toBe('Session b');
    expect(sessionsBarSubline(sessionView('c', { config: { name: undefined as never } }))).toBe('/work/c');
  });

  test('a row is titled by its task, the ferret second; with no task the ferret is the title', () => {
    const names = (config: Record<string, unknown>) => sessionsBarNames(sessionView('a', { config: config as never }));
    expect(names({ teammate: 'hadi', label: 'Home Manager' })).toEqual({ title: 'Home Manager', ferret: 'Hadi' });
    expect(names({ teammate: 'hadi', label: undefined, name: 'Diene Work' })).toEqual({
      title: 'Diene Work',
      ferret: 'Hadi',
    });
    expect(names({ teammate: 'hadi', label: '  ', name: undefined })).toEqual({ title: 'Hadi', ferret: null });
    expect(names({ teammate: 'hadi', label: 'Hadi' })).toEqual({ title: 'Hadi', ferret: null });
    expect(names({ teammate: undefined, label: 'Home Manager' })).toEqual({ title: 'Home Manager', ferret: null });
    expect(names({ teammate: undefined, label: undefined, name: undefined })).toEqual({ title: 'a', ferret: null });
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
