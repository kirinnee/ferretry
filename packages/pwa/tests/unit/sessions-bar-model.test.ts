import { describe, expect, test } from 'bun:test';
import {
  inSessionsBar,
  isRunning,
  needsYou,
  RECENTLY_FINISHED_MS,
  sessionsBarSubline,
  sessionsBarView,
} from '../../src/shell/sessions-bar-model.ts';
import { sessionView } from '../support/sessions.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const ago = (milliseconds: number): string => new Date(NOW - milliseconds).toISOString();

describe('who needs the reader', () => {
  test('a session parked on a person, by any of the three ways it can say so', () => {
    expect(needsYou(sessionView('a', { state: { status: 'awaiting_user' } }))).toBe(true);
    expect(needsYou(sessionView('b', { state: { status: 'awaiting_question' } }))).toBe(true);
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

  test('running is the status mark’s own active class', () => {
    expect(isRunning(sessionView('a'))).toBe(true);
    expect(isRunning(sessionView('b', { state: { status: 'waiting' } }))).toBe(false);
    expect(isRunning(sessionView('c', { state: { status: 'completed' } }))).toBe(false);
  });
});

describe('which sessions the bar lists', () => {
  test('everything alive, anything finished in the last day, and the open one whatever its age', () => {
    const alive = sessionView('alive', { state: { lastActivityAt: ago(10 * RECENTLY_FINISHED_MS) } });
    const fresh = sessionView('fresh', { state: { status: 'completed', lastActivityAt: ago(60_000) } });
    const old = sessionView('old', { state: { status: 'completed', lastActivityAt: ago(2 * RECENTLY_FINISHED_MS) } });
    const undated = sessionView('undated', {
      config: { updatedAt: undefined as never },
      state: { status: 'stopped', lastActivityAt: undefined as never },
    });

    expect(inSessionsBar(alive, NOW, null)).toBe(true);
    expect(inSessionsBar(fresh, NOW, null)).toBe(true);
    expect(inSessionsBar(old, NOW, null)).toBe(false);
    expect(inSessionsBar(old, NOW, 'old')).toBe(true);
    // No sign of life at all reads as long ago rather than as now.
    expect(inSessionsBar(undated, NOW, null)).toBe(false);
  });

  test('groups by project, newest first, and counts each filter over the same pool', () => {
    const sessions = [
      sessionView('a', { config: { cwd: '/work/ferretry' }, state: { lastActivityAt: ago(5_000) } }),
      sessionView('b', {
        config: { cwd: '/work/ferretry/packages' },
        state: { status: 'awaiting_user', lastActivityAt: ago(1_000) },
      }),
      sessionView('c', { config: { cwd: '/work/nitroso' }, state: { status: 'waiting', lastActivityAt: ago(2_000) } }),
      sessionView('gone', { state: { status: 'completed', lastActivityAt: ago(3 * RECENTLY_FINISHED_MS) } }),
    ];
    const projects = [{ name: 'ferretry', path: '/work/ferretry' }];

    const all = sessionsBarView(sessions, projects, 'all', NOW, null);
    expect(all.counts).toEqual({ all: 3, 'needs-you': 1, running: 1 });
    expect(all.groups.map(group => [group.name, group.rows.map(row => row.config.id)])).toEqual([
      ['ferretry', ['b', 'a']],
      ['nitroso', ['c']],
    ]);

    expect(sessionsBarView(sessions, projects, 'needs-you', NOW, null).groups.map(group => group.name)).toEqual([
      'ferretry',
    ]);
    expect(
      sessionsBarView(sessions, projects, 'running', NOW, null).groups.flatMap(group =>
        group.rows.map(row => row.config.id),
      ),
    ).toEqual(['a']);
  });

  test('the line under a name is the task, else its name, else its folder', () => {
    expect(sessionsBarSubline(sessionView('a', { config: { label: 'Fix the sign-in' } }))).toBe('Fix the sign-in');
    expect(sessionsBarSubline(sessionView('b', { config: { name: 'Session b' } }))).toBe('Session b');
    expect(sessionsBarSubline(sessionView('c', { config: { name: undefined as never } }))).toBe('/work/c');
  });
});
