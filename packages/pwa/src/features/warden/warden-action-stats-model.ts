/**
 * The Warden's actions as the page counts them: how many revives (today, 7 and 30 days) split by who
 * decided them, whether they took, and a fourteen-day chart of every action by who decided it.
 *
 * Two rules carry it, the same two as `warden-stats-model.ts`:
 *
 *   1. A DAY THE DAEMON DID NOT TALLY IS UNKNOWN, NEVER A ZERO. A day without `acts` (an older daemon, or
 *      a day before it learned to) is left out of every sum and said so in the coverage line.
 *   2. NEVER INVENT A RATE. The success rate counts only revives that were settled (they showed progress or
 *      ran out of their window); with none settled it is "—", not 0% and not 100%.
 */

import {
  WARDEN_REVIVE_ACTIONS,
  WARDEN_REVIVE_PROGRESS_MINUTES,
  type WardenActionTally,
  type WardenActor,
  type WardenDayStats,
  type WardenStatActionKind,
  type WardenStatusView,
} from '@ferretry/protocol';

import type { MetricChartPoint } from '../analytics/analytics-metric-chart.tsx';
import { type ActorCount, actorSplit, utcDay, wholeNumberTicks } from './warden-stats-model.ts';
import { ACTOR_LABEL } from './warden-vocabulary.ts';

export { wholeNumberTicks };

/** The days the chart draws, today last. */
export const ACTION_CHART_DAYS = 14;

const DAY_MS = 86_400_000;
const REVIVE_SPANS = [
  { key: 'today', label: 'Today', days: 1 },
  { key: 'week', label: '7 days', days: 7 },
  { key: 'month', label: '30 days', days: 30 },
] as const;

type ReviveSpanKey = (typeof REVIVE_SPANS)[number]['key'];

/** The actors the chart stacks, bottom first — the same order and colours as the page's other chart. */
const STACK = ['auto', 'jev', 'llm'] as const;

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

const shiftDay = (day: string, shift: number): string => utcDay(Date.parse(`${day}T00:00:00.000Z`) + shift * DAY_MS);

// ── What an action is called ────────────────────────────────────────────────────────────────────

/** The filter on the chart: one word per thing the Warden does. `revived` is a revive or a resume. */
export type ActionFilterKey = 'all' | 'revived' | 'nudge' | 'restart' | 'failover' | 'stop' | 'bless' | 'escalate';

interface ActionFilter {
  readonly key: ActionFilterKey;
  readonly label: string;
  /** Singular noun for a readout: `1 revive`, `2 nudges`. */
  readonly noun: string;
  readonly kinds: readonly WardenStatActionKind[];
}

const ALL_KINDS: readonly WardenStatActionKind[] = [
  'revive',
  'resume',
  'nudge',
  'restart',
  'failover',
  'stop',
  'bless',
  'escalate',
];

const ACTION_FILTERS: readonly ActionFilter[] = [
  { key: 'all', label: 'All', noun: 'action', kinds: ALL_KINDS },
  { key: 'revived', label: 'Revived', noun: 'revive', kinds: WARDEN_REVIVE_ACTIONS },
  { key: 'nudge', label: 'Nudged', noun: 'nudge', kinds: ['nudge'] },
  { key: 'restart', label: 'Restarted', noun: 'restart', kinds: ['restart'] },
  { key: 'failover', label: 'Switched login', noun: 'login switch', kinds: ['failover'] },
  { key: 'stop', label: 'Stopped', noun: 'stop', kinds: ['stop'] },
  { key: 'bless', label: 'Left alone', noun: 'leave-alone', kinds: ['bless'] },
  { key: 'escalate', label: 'Asked you', noun: 'escalation', kinds: ['escalate'] },
];

const filterOf = (key: ActionFilterKey): ActionFilter =>
  ACTION_FILTERS.find(f => f.key === key) ?? { key: 'all', label: 'All', noun: 'action', kinds: ALL_KINDS };

// ── Counting ────────────────────────────────────────────────────────────────────────────────────

const countOf = (tally: WardenActionTally | undefined, actor: WardenActor): number => tally?.[actor] ?? 0;

/** What `kinds` did on `day` with `outcome`, per actor. */
const doneBy = (
  day: WardenDayStats,
  kinds: readonly WardenStatActionKind[],
  outcome: WardenActionTally['outcome'] = 'done',
): Readonly<Record<WardenActor, number>> => {
  const totals: Record<WardenActor, number> = { auto: 0, jev: 0, llm: 0, owner: 0 };
  for (const tally of day.acts ?? []) {
    if (tally.outcome !== outcome || !kinds.includes(tally.action)) continue;
    for (const actor of Object.keys(totals) as WardenActor[]) totals[actor] += countOf(tally, actor);
  }
  return totals;
};

const sumActors = (counts: Readonly<Record<WardenActor, number>>): number =>
  counts.auto + counts.jev + counts.llm + counts.owner;

const tallied = (days: readonly WardenDayStats[]): readonly WardenDayStats[] =>
  days.filter(day => day.acts !== undefined);

// ── Revives ─────────────────────────────────────────────────────────────────────────────────────

export interface ReviveSpan {
  readonly key: ReviveSpanKey;
  readonly label: string;
  /** `null` is unknown (no tallied day), shown as an em dash; never a zero. */
  readonly total: number | null;
  /** Who decided them, non-zero actors only. */
  readonly split: readonly ActorCount[];
  /** `5 of 7 days tallied`, when the span is not fully covered. */
  readonly coverage?: string;
}

export interface ReviveSuccess {
  /** 0–1, or `null` when no revive has been settled yet. */
  readonly rate: number | null;
  readonly progressed: number;
  readonly stalled: number;
  /** `80%`, or `—`. */
  readonly percent: string;
  /** `8 of 10 revives did real work within 10 minutes`. */
  readonly sentence: string;
  /** Per decider, non-zero: `Auto 6 of 7`. */
  readonly byActor: readonly string[];
}

export interface WardenActionStats {
  /** `false` when no day carries a tally: an older daemon, so the block says it is not recorded. */
  readonly recorded: boolean;
  readonly revives: readonly ReviveSpan[];
  readonly success: ReviveSuccess;
}

const withinDays = (history: readonly WardenDayStats[], today: string, days: number): readonly WardenDayStats[] => {
  const first = shiftDay(today, -(days - 1));
  return history.filter(entry => entry.day >= first && entry.day <= today);
};

const reviveSpan = (
  history: readonly WardenDayStats[],
  today: string,
  span: (typeof REVIVE_SPANS)[number],
): ReviveSpan => {
  const days = tallied(withinDays(history, today, span.days));
  if (days.length === 0) return { key: span.key, label: span.label, total: null, split: [] };
  const counts = days.reduce<Record<WardenActor, number>>(
    (sum, day) => {
      const one = doneBy(day, WARDEN_REVIVE_ACTIONS);
      return {
        auto: sum.auto + one.auto,
        jev: sum.jev + one.jev,
        llm: sum.llm + one.llm,
        owner: sum.owner + one.owner,
      };
    },
    { auto: 0, jev: 0, llm: 0, owner: 0 },
  );
  return {
    key: span.key,
    label: span.label,
    total: sumActors(counts),
    split: actorSplit(counts),
    ...(days.length === span.days ? {} : { coverage: `${days.length} of ${span.days} days tallied` }),
  };
};

const reviveSuccess = (history: readonly WardenDayStats[]): ReviveSuccess => {
  const total = { progressed: { auto: 0, jev: 0, llm: 0 }, stalled: { auto: 0, jev: 0, llm: 0 } };
  for (const day of history) {
    for (const actor of STACK) {
      total.progressed[actor] += day.reviveResults?.progressed[actor] ?? 0;
      total.stalled[actor] += day.reviveResults?.stalled[actor] ?? 0;
    }
  }
  const progressed = STACK.reduce((sum, actor) => sum + total.progressed[actor], 0);
  const stalled = STACK.reduce((sum, actor) => sum + total.stalled[actor], 0);
  const settled = progressed + stalled;
  const rate = settled === 0 ? null : progressed / settled;
  return {
    rate,
    progressed,
    stalled,
    percent: rate === null ? '—' : `${Math.round(rate * 100)}%`,
    sentence:
      settled === 0
        ? `No revive has been settled yet: each gets ${WARDEN_REVIVE_PROGRESS_MINUTES} minutes to do real work.`
        : `${progressed} of ${plural(settled, 'revive')} did real work within ${WARDEN_REVIVE_PROGRESS_MINUTES} minutes`,
    byActor: STACK.flatMap(actor => {
      const done = total.progressed[actor];
      const all = done + total.stalled[actor];
      return all === 0 ? [] : [`${ACTOR_LABEL[actor]} ${done} of ${all}`];
    }),
  };
};

export const wardenActionStats = (status: WardenStatusView, now: number): WardenActionStats => {
  const history = status.history ?? [];
  const today = utcDay(now);
  return {
    recorded: tallied(history).length > 0,
    revives: REVIVE_SPANS.map(span => reviveSpan(history, today, span)),
    success: reviveSuccess(withinDays(history, today, 30)),
  };
};

// ── The chart ───────────────────────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const dayName = (day: string): { readonly weekday: string; readonly date: string; readonly short: string } => {
  const at = new Date(`${day}T00:00:00.000Z`);
  const date = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()] ?? ''}`;
  return { weekday: WEEKDAYS[at.getUTCDay()] ?? '', date, short: String(at.getUTCDate()) };
};

export interface ActionChart {
  readonly points: readonly MetricChartPoint[];
  /** Days with no tally, so the chart can say what its `?` means. */
  readonly missing: number;
  /** Filters with something to show in the window; `all` is always offered. */
  readonly filters: readonly ActionFilter[];
  readonly title: string;
}

const readout = (day: WardenDayStats, filter: ActionFilter): string => {
  const { weekday, date } = dayName(day.day);
  const done = doneBy(day, filter.kinds);
  const total = sumActors(done);
  const who = (['auto', 'jev', 'llm', 'owner'] as const)
    .filter(actor => done[actor] > 0)
    .map(actor => `${ACTOR_LABEL[actor]} ${done[actor]}`)
    .join(', ');
  const failed = sumActors(doneBy(day, filter.kinds, 'failed'));
  const held = sumActors(doneBy(day, filter.kinds, 'held'));
  const extras = [...(failed > 0 ? [`${failed} failed`] : []), ...(held > 0 ? [`${held} held for you`] : [])];
  const head = total === 0 ? `no ${filter.noun}s` : `${plural(total, filter.noun)} — ${who}`;
  return [`${weekday} ${date}`, head, ...extras].join(' · ');
};

/** Fourteen bars, today last: the chosen action, stacked by who decided it. */
export const wardenActionChart = (
  status: WardenStatusView,
  now: number,
  filterKey: ActionFilterKey,
): ActionChart | undefined => {
  const { history } = status;
  if (history === undefined || tallied(history).length === 0) return undefined;
  const filter = filterOf(filterKey);
  const today = utcDay(now);
  const window = withinDays(history, today, ACTION_CHART_DAYS);
  const byDay = new Map(window.map(entry => [entry.day, entry]));
  let missing = 0;
  const points = Array.from({ length: ACTION_CHART_DAYS }, (_, index): MetricChartPoint => {
    const day = shiftDay(today, index - (ACTION_CHART_DAYS - 1));
    const { weekday, date, short } = dayName(day);
    const entry = byDay.get(day);
    if (entry?.acts === undefined) {
      missing += 1;
      return { key: day, label: `${short}?`, values: [0, 0, 0], readout: `${weekday} ${date} · not tallied` };
    }
    const done = doneBy(entry, filter.kinds);
    const values = STACK.map(actor => done[actor]);
    return {
      key: day,
      label: short,
      values,
      ...(values.every(value => value === 0) ? { empty: true } : {}),
      readout: readout(entry, filter),
    };
  });
  const present = ACTION_FILTERS.filter(
    f => f.key === 'all' || window.some(day => sumActors(doneBy(day, f.kinds)) > 0),
  );
  return {
    points,
    missing,
    filters: present.some(f => f.key === filterKey) ? present : [...present, filter],
    title: filter.key === 'all' ? 'Warden actions per day' : `${filter.label} per day`,
  };
};
