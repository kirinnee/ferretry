/**
 * Pure presentation projections for the sessions dashboard.
 *
 * Ported from kteam's `SessionsListPage.tsx` and `lib/utils.ts`. Keeping these
 * decisions outside React makes the full table, compact table, and phone cards
 * share one status vocabulary and one stable project-colour assignment.
 */

import type { SessionView } from '@ferretry/protocol';
import type { DashboardView, Density } from '../lib/controls.ts';
import type { SessionGroup } from '../lib/fleet-grouping.ts';
import type { BadgeTone } from '../shell/primitives.tsx';
import { TERMINAL_STATUSES } from '../shell/status-mark.tsx';

export const DENSITY_COLUMN_LABELS: Readonly<Record<Density, readonly string[]>> = {
  full: ['Teammate', 'Task', 'Status', 'Runtime', 'Activity', 'Signals'],
  compact: ['Teammate', 'Task', 'Status'],
  minimal: ['Teammate', 'Task'],
};

/** Percentage widths for the fixed table within its own horizontal scroller. */
export const DENSITY_COLUMN_WIDTHS: Readonly<Record<Density, readonly string[]>> = {
  full: ['w-[16%]', 'w-[22%]', 'w-[11%]', 'w-[14%]', 'w-[24%]', 'w-[13%]'],
  compact: ['w-[28%]', 'w-[44%]', 'w-[28%]'],
  minimal: ['w-[38%]', 'w-[62%]'],
};

/** A persisted choice wins; otherwise a narrow viewport defaults to cards. */
export function dashboardMode(preference: DashboardView | null, narrow: boolean): DashboardView {
  return preference ?? (narrow ? 'cards' : 'table');
}

/** The two reachable empty states after daemon-scoped scope recovery. */
export function dashboardEmptyMessage(scope: string | null): string {
  return scope === null ? 'No matching sessions.' : 'No sessions in this folder match the filters.';
}

export const SCOPE_RECOVERY_MESSAGE = 'That folder is no longer available — showing the whole fleet.';

export function sessionCountLabel(count: number): string {
  return `${count} session${count === 1 ? '' : 's'}`;
}

/**
 * The source maps `awaiting_user` to ok before its unreachable accent branch.
 * Preserve that visible behaviour while dropping the dead duplicate test.
 */
export function dashboardTone(status: string): BadgeTone {
  const value = status.toLowerCase();
  if (/(completed|awaiting_user|interrupted|healthy|ready|done)/.test(value)) return 'ok';
  if (/(failed|stalled|stopped|kill_failed|err)/.test(value)) return 'err';
  if (/(running|starting|thinking|tool|retry|rate|waiting|awaiting_question)/.test(value)) return 'warn';
  return 'pend';
}

/** Terse deterministic relative age for a dense cell: `12s`, `4m`, `3h`, `2d`. */
export function sessionAge(value: string | null | undefined, now: number): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.max(0, Math.round((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  created: 'new',
  starting: 'start',
  running: 'run',
  thinking: 'think',
  tool_running: 'tool',
  awaiting_question: 'ask',
  awaiting_user: 'you',
  interrupted: 'paused',
  rate_limited: 'limited',
  retrying: 'retry',
  kill_failed: 'zombie',
  waiting: 'wait',
  completed: 'done',
  failed: 'failed',
  stalled: 'stalled',
  stopped: 'stopped',
};

/** A compact human word; unknown statuses remain visible and unshouted. */
export function statusWord(status: string): string {
  return STATUS_WORDS[status] ?? status.replace(/_/g, ' ');
}

export interface HoistedStatus {
  readonly status: string;
  readonly count: number;
  readonly uniform: boolean;
}

/** Hoist only a strict majority shared by at least two rows. */
export function hoistedStatus(rows: readonly SessionView[]): HoistedStatus | null {
  if (rows.length < 2) return null;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.state.status, (counts.get(row.state.status) ?? 0) + 1);
  let status: string | null = null;
  let count = 0;
  for (const [candidate, candidateCount] of counts) {
    if (candidateCount > count) {
      status = candidate;
      count = candidateCount;
    }
  }
  if (!status || count < 2 || count * 2 <= rows.length) return null;
  return { status, count, uniform: count === rows.length };
}

export const GROUP_HUES = ['read', 'edit', 'write', 'search', 'patch', 'bash', 'plan'] as const;

export function groupHueIndex(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) | 0;
  return Math.abs(hash) % GROUP_HUES.length;
}

/** Stable decorative colour for one project identity. */
export function groupHueVar(key: string): string {
  return `var(--tool-${GROUP_HUES[groupHueIndex(key)]})`;
}

/** Stable group hues with adjacent hash collisions advanced by one token. */
export function groupHueVars(groups: readonly SessionGroup[]): string[] {
  const indexes: number[] = [];
  for (const group of groups) {
    let index = groupHueIndex(group.path || group.name);
    if (indexes.length > 0 && index === indexes[indexes.length - 1]) index = (index + 1) % GROUP_HUES.length;
    indexes.push(index);
  }
  return indexes.map(index => `var(--tool-${GROUP_HUES[index]})`);
}

export interface ActivityLine {
  readonly text: string;
  readonly live: boolean;
}

/** Declared waits outrank stale pane activity; otherwise report activity or a quiet fallback. */
export function activityLine(view: SessionView): ActivityLine {
  const wait = view.state.waiting;
  if (wait) {
    const until = wait.until ? ` (until ${new Date(wait.until).toLocaleTimeString()})` : '';
    return { text: `waiting: ${wait.condition ?? 'external condition'}${until}`, live: true };
  }
  const activity = view.state.activity?.trim();
  if (activity) return { text: activity, live: !TERMINAL_STATUSES.has(view.state.status) };
  return {
    text: TERMINAL_STATUSES.has(view.state.status) ? 'no activity recorded' : 'awaiting activity',
    live: false,
  };
}
