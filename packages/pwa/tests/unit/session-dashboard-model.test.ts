import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import {
  activityLine,
  DENSITY_COLUMN_LABELS,
  DENSITY_COLUMN_WIDTHS,
  dashboardEmptyMessage,
  dashboardMode,
  dashboardTone,
  GROUP_HUES,
  groupHueIndex,
  groupHueVar,
  groupHueVars,
  hoistedStatus,
  SCOPE_RECOVERY_MESSAGE,
  sessionAge,
  sessionCountLabel,
  statusWord,
} from '../../src/components/session-dashboard-model.ts';
import type { SessionGroup } from '../../src/lib/fleet-grouping.ts';
import { sessionView } from '../support/sessions.ts';

const at = Date.parse('2026-08-01T12:00:00.000Z');

const view = (
  id: string,
  status: SessionView['state']['status'],
  state: Partial<SessionView['state']> = {},
): SessionView => sessionView(id, { state: { status, ...state } });

describe('session dashboard model', () => {
  it('keeps the original density labels and fixed percentage columns', () => {
    expect(DENSITY_COLUMN_LABELS).toEqual({
      full: ['Teammate', 'Task', 'Status', 'Runtime', 'Activity', 'Signals'],
      compact: ['Teammate', 'Task', 'Status'],
      minimal: ['Teammate', 'Task'],
    });
    expect(DENSITY_COLUMN_WIDTHS.full).toEqual(['w-[16%]', 'w-[22%]', 'w-[11%]', 'w-[14%]', 'w-[24%]', 'w-[13%]']);
    expect(DENSITY_COLUMN_WIDTHS.compact).toEqual(['w-[28%]', 'w-[44%]', 'w-[28%]']);
    expect(DENSITY_COLUMN_WIDTHS.minimal).toEqual(['w-[38%]', 'w-[62%]']);
  });

  it('derives view, empty copy, recovery notice, and pluralized counts', () => {
    expect(dashboardMode(null, true)).toBe('cards');
    expect(dashboardMode(null, false)).toBe('table');
    expect(dashboardMode('table', true)).toBe('table');
    expect(dashboardMode('cards', false)).toBe('cards');
    expect(dashboardEmptyMessage(null)).toBe('No matching sessions.');
    expect(dashboardEmptyMessage('/work/project')).toBe('No sessions in this folder match the filters.');
    expect(SCOPE_RECOVERY_MESSAGE).toBe('That folder is no longer available — showing the whole fleet.');
    expect(sessionCountLabel(0)).toBe('0 sessions');
    expect(sessionCountLabel(1)).toBe('1 session');
    expect(sessionCountLabel(2)).toBe('2 sessions');
  });

  it('projects badge tones without reviving the source dead awaiting-user branch', () => {
    expect([
      dashboardTone('completed'),
      dashboardTone('AWAITING_USER'),
      dashboardTone('failed'),
      dashboardTone('session_err'),
      dashboardTone('running'),
      dashboardTone('awaiting_question'),
      dashboardTone('created'),
    ]).toEqual(['ok', 'ok', 'err', 'err', 'warn', 'warn', 'pend']);
  });

  it('formats all dense age bands against an explicit clock', () => {
    expect(sessionAge(undefined, at)).toBe('—');
    expect(sessionAge('not-a-date', at)).toBe('not-a-date');
    expect(sessionAge('2026-08-01T12:00:05.000Z', at)).toBe('0s');
    expect(sessionAge('2026-08-01T11:59:48.000Z', at)).toBe('12s');
    expect(sessionAge('2026-08-01T11:56:00.000Z', at)).toBe('4m');
    expect(sessionAge('2026-08-01T09:00:00.000Z', at)).toBe('3h');
    expect(sessionAge('2026-07-30T12:00:00.000Z', at)).toBe('2d');
  });

  it('uses terse known status words and a readable unknown fallback', () => {
    expect([
      statusWord('created'),
      statusWord('awaiting_user'),
      statusWord('kill_failed'),
      statusWord('brand_new_state'),
    ]).toEqual(['new', 'you', 'zombie', 'brand new state']);
  });

  it('hoists only a strict majority shared by at least two rows', () => {
    expect(hoistedStatus([view('one', 'running')])).toBeNull();
    expect(hoistedStatus([view('a', 'running'), view('b', 'failed')])).toBeNull();
    expect(hoistedStatus([view('a', 'running'), view('b', 'running')])).toEqual({
      status: 'running',
      count: 2,
      uniform: true,
    });
    expect(
      hoistedStatus([view('a', 'running'), view('b', 'failed'), view('c', 'running'), view('d', 'running')]),
    ).toEqual({ status: 'running', count: 3, uniform: false });
  });

  it('assigns stable theme-token hues and de-collides adjacent groups', () => {
    const index = groupHueIndex('same');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(GROUP_HUES.length);
    expect(groupHueVar('same')).toBe(`var(--tool-${GROUP_HUES[index]})`);
    const groups: SessionGroup[] = [
      { name: 'same', path: '', rows: [] },
      { name: 'same', path: '', rows: [] },
      { name: 'other', path: '/work/other', rows: [] },
    ];
    const hues = groupHueVars(groups);
    expect(hues).toHaveLength(3);
    expect(hues[0]).toBe(groupHueVar('same'));
    expect(hues[1]).not.toBe(hues[0]);
    expect(hues[2]).toMatch(/^var\(--tool-/);
  });

  it('lets a declared wait outrank activity and otherwise reports live or quiet state', () => {
    const waiting = activityLine(
      view('wait', 'running', {
        activity: 'stale pane text',
        waiting: { since: '2026-08-01T10:00:00.000Z', until: '2026-08-01T13:00:00.000Z' },
      }),
    );
    expect(waiting.text).toStartWith('waiting: external condition (until ');
    expect(waiting.live).toBe(true);
    expect(activityLine(view('live', 'running', { activity: '  Writing tests  ' }))).toEqual({
      text: 'Writing tests',
      live: true,
    });
    expect(activityLine(view('done-activity', 'completed', { activity: 'Settled' }))).toEqual({
      text: 'Settled',
      live: false,
    });
    expect(activityLine(view('idle', 'running'))).toEqual({ text: 'awaiting activity', live: false });
    expect(activityLine(view('done', 'completed'))).toEqual({ text: 'no activity recorded', live: false });
  });
});
