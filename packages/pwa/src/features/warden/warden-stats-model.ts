/**
 * The Warden page's numbers, worked out without a browser: the five stat tiles, the two layer lines and
 * the per-day chart.
 *
 * THREE RULES CARRY THEM.
 *
 *   1. A MISSING DAY IS UNKNOWN, NEVER A ZERO. The daemon keeps a record per UTC day; a day it did not
 *      keep is absent from `history`. A seven-day total says how many days it covers, today's tiles read
 *      "—" when today has no record, and the chart labels the day "no record".
 *   2. NEVER INVENT A NUMBER. An older daemon sends no `history`: today's flags come from its own
 *      savings counters and the outcome tiles are counted from the recent actions it listed, and they
 *      say so ("recent"), because that list is capped.
 *   3. ONE ACTOR, ONE COLOUR, ONE NAME. The tiles, the chart and the row chips all read the same
 *      vocabulary (`ACTOR_LABEL`, `ACTOR_DOT`).
 */

import {
  type WardenActor,
  type WardenActorCounts,
  type WardenAction,
  type WardenDayStats,
  type WardenOutcome,
  type WardenStatusView,
  wardenActionActor,
  wardenActionOutcome,
} from '@ferretry/protocol';

import type { MetricChartPoint, MetricChartSeries } from '../analytics/analytics-metric-chart.tsx';
import { usd } from './warden-overview-model.ts';
import { wardenPacedUntil } from './warden-status-model.ts';
import { ACTOR_LABEL } from './warden-vocabulary.ts';

export type WardenPeriod = 'today' | 'week';

export const PERIOD_LABEL: Readonly<Record<WardenPeriod, string>> = { today: 'Today', week: '7 days' };

const ACTOR_ORDER: readonly WardenActor[] = ['auto', 'jev', 'llm', 'owner'];
const OUTCOMES: readonly WardenOutcome[] = ['moved', 'cleared', 'stopped', 'asked'];
const WEEK_DAYS = 7;
const DAY_MS = 86_400_000;

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

// ── Days ────────────────────────────────────────────────────────────────────────────────────────

/** The UTC day of an instant: `2026-07-31`. */
export const utcDay = (instant: number | string): string => new Date(instant).toISOString().slice(0, 10);

/** The UTC day `shift` days from `day`. */
const shiftDay = (day: string, shift: number): string => utcDay(Date.parse(`${day}T00:00:00.000Z`) + shift * DAY_MS);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const dayParts = (day: string): { readonly weekday: string; readonly date: string } => {
  const at = new Date(`${day}T00:00:00.000Z`);
  return {
    weekday: WEEKDAYS[at.getUTCDay()] ?? '',
    date: `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()] ?? ''}`,
  };
};

// ── Counts ──────────────────────────────────────────────────────────────────────────────────────

export interface ActorCount {
  readonly actor: WardenActor;
  readonly label: string;
  readonly count: number;
}

const countOf = (counts: WardenActorCounts, actor: WardenActor): number => counts[actor] ?? 0;

const addCounts = (left: WardenActorCounts, right: WardenActorCounts): WardenActorCounts => ({
  auto: left.auto + right.auto,
  jev: left.jev + right.jev,
  llm: left.llm + right.llm,
  ...(left.owner === undefined && right.owner === undefined ? {} : { owner: (left.owner ?? 0) + (right.owner ?? 0) }),
});

const NO_COUNTS: WardenActorCounts = { auto: 0, jev: 0, llm: 0 };

/** The non-zero actors of one outcome's counts, in the page's order. */
export const actorSplit = (counts: WardenActorCounts): readonly ActorCount[] =>
  ACTOR_ORDER.map(actor => ({ actor, label: ACTOR_LABEL[actor], count: countOf(counts, actor) })).filter(
    entry => entry.count > 0,
  );

const totalOf = (counts: WardenActorCounts): number =>
  ACTOR_ORDER.reduce((sum, actor) => sum + countOf(counts, actor), 0);

// ── The tiles ───────────────────────────────────────────────────────────────────────────────────

type StatTileKey = 'flagged' | WardenOutcome;

export interface StatTile {
  readonly key: StatTileKey;
  readonly label: string;
  /** `null` is unknown (no record), shown as an em dash; it is never a zero. */
  readonly value: number | null;
  /** Who did it, non-zero actors only. Empty for Flagged. */
  readonly split: readonly ActorCount[];
  /** Flagged only: `Jev decided 5 · LLM investigated 2`. */
  readonly sub?: string;
  /** `recent` when the figure is counted from the capped action list of an older daemon. */
  readonly qualifier?: 'recent';
}

export interface WardenStats {
  readonly period: WardenPeriod;
  /** `history` from a daemon that keeps days, `recent` from one that does not. */
  readonly source: 'history' | 'recent';
  readonly tiles: readonly StatTile[];
  /** Said under the tiles when they do not cover the whole period: `5 of 7 days recorded`. */
  readonly coverage?: string;
}

const TILE_LABEL: Readonly<Record<StatTileKey, string>> = {
  flagged: 'Flagged',
  moved: 'Moved',
  cleared: 'Cleared',
  stopped: 'Stopped',
  asked: 'Asked you',
};

const TILE_ORDER: readonly StatTileKey[] = ['flagged', 'moved', 'cleared', 'stopped', 'asked'];

const decidedBy = (jevDecisions: number, investigations: number): string =>
  `Jev decided ${jevDecisions} · LLM investigated ${investigations}`;

const tilesFromDays = (days: readonly WardenDayStats[]): readonly StatTile[] => {
  const sum = (outcome: WardenOutcome): WardenActorCounts =>
    days.reduce<WardenActorCounts>((total, day) => addCounts(total, day[outcome]), NO_COUNTS);
  const flags = days.reduce((total, day) => total + day.flags, 0);
  const jev = days.reduce((total, day) => total + day.jevDecisions, 0);
  const llm = days.reduce((total, day) => total + day.investigations, 0);
  return TILE_ORDER.map(key =>
    key === 'flagged'
      ? { key, label: TILE_LABEL[key], value: flags, split: [], sub: decidedBy(jev, llm) }
      : { key, label: TILE_LABEL[key], value: totalOf(sum(key)), split: actorSplit(sum(key)) },
  );
};

const unknownTiles = (): readonly StatTile[] =>
  TILE_ORDER.map(key => ({ key, label: TILE_LABEL[key], value: null, split: [] }));

/** The actions an older daemon listed for `day`, counted the way a newer daemon rolls them up. */
const countActions = (
  actions: readonly WardenAction[],
  day: string,
): Readonly<Record<WardenOutcome, WardenActorCounts>> => {
  const counts: Record<WardenOutcome, Record<WardenActor, number>> = {
    moved: { auto: 0, jev: 0, llm: 0, owner: 0 },
    cleared: { auto: 0, jev: 0, llm: 0, owner: 0 },
    stopped: { auto: 0, jev: 0, llm: 0, owner: 0 },
    asked: { auto: 0, jev: 0, llm: 0, owner: 0 },
  };
  for (const action of actions) {
    if (!Number.isFinite(Date.parse(action.at)) || utcDay(action.at) !== day) continue;
    const outcome = wardenActionOutcome(action);
    if (outcome !== undefined) counts[outcome][wardenActionActor(action)] += 1;
  }
  const own = (outcome: WardenOutcome): WardenActorCounts => {
    const { auto, jev, llm, owner } = counts[outcome];
    return owner === 0 ? { auto, jev, llm } : { auto, jev, llm, owner };
  };
  return { moved: own('moved'), cleared: own('cleared'), stopped: own('stopped'), asked: own('asked') };
};

const recentTiles = (status: WardenStatusView, today: string): readonly StatTile[] => {
  const known = status.savings.day === today;
  const counts = countActions(status.actions, today);
  return TILE_ORDER.map(key =>
    key === 'flagged'
      ? {
          key,
          label: TILE_LABEL[key],
          value: known ? status.savings.flags : null,
          split: [],
          ...(known ? { sub: decidedBy(status.savings.jevDecisions, status.savings.investigations) } : {}),
        }
      : {
          key,
          label: TILE_LABEL[key],
          value: totalOf(counts[key]),
          split: actorSplit(counts[key]),
          qualifier: 'recent' as const,
        },
  );
};

/** Whether a daemon sent a day record at all; the period switch is only offered when it did. */
export const hasHistory = (status: WardenStatusView): boolean => status.history !== undefined;

export const wardenStats = (status: WardenStatusView, period: WardenPeriod, now: number): WardenStats => {
  const today = utcDay(now);
  const { history } = status;
  if (history === undefined) return { period: 'today', source: 'recent', tiles: recentTiles(status, today) };
  if (period === 'today') {
    const day = history.find(entry => entry.day === today);
    return { period, source: 'history', tiles: day === undefined ? unknownTiles() : tilesFromDays([day]) };
  }
  const first = shiftDay(today, -(WEEK_DAYS - 1));
  const days = history.filter(entry => entry.day >= first && entry.day <= today);
  return {
    period,
    source: 'history',
    tiles: days.length === 0 ? unknownTiles() : tilesFromDays(days),
    ...(days.length === WEEK_DAYS ? {} : { coverage: `${days.length} of ${WEEK_DAYS} days recorded` }),
  };
};

// ── The layers ──────────────────────────────────────────────────────────────────────────────────

export interface LayerLine {
  readonly key: 'jev' | 'llm';
  readonly name: string;
  /** `42 decisions · $0.31 of $0.50 today`, with the pacing words when the layer is paused. */
  readonly summary: string;
  /** A muted clause after the summary, such as what Jev saved. */
  readonly clause?: string;
  /** Spend over cap, 0–1; undefined when the cap is not a positive number. */
  readonly ratio?: number;
  /** The layer is capped or paced: the bar and the words take the warning tone. */
  readonly warn: boolean;
}

const ratioOf = (spent: number, cap: number): number | undefined =>
  cap > 0 && Number.isFinite(spent) ? Math.min(1, Math.max(0, spent / cap)) : undefined;

/** One compact line per layer the owner has switched on, from today's figures. */
export const layerLines = (status: WardenStatusView): readonly LayerLine[] => {
  const { spend, savings, config } = status;
  const today = status.history?.find(entry => entry.day === spend.day);
  const decisions = today?.jevDecisions ?? savings.jevDecisions;
  const investigations = today?.investigations ?? savings.investigations;
  const lines: LayerLine[] = [];
  if (config.layers.jev) {
    const paced = wardenPacedUntil(status, 'jev');
    const capped = spend.capsHit.includes('jev');
    const pause = paced !== undefined ? ` · paused until ${paced}` : capped ? ' · cap hit, back at midnight UTC' : '';
    const ratio = ratioOf(spend.jevUsd, spend.jevCapUsd);
    lines.push({
      key: 'jev',
      name: 'Jev',
      summary: `${plural(decisions, 'decision')} · ${usd(spend.jevUsd)} of ${usd(spend.jevCapUsd)} today${pause}`,
      ...(savings.savedUsd === undefined ? {} : { clause: `~${usd(savings.savedUsd)} saved vs investigating all` }),
      ...(ratio === undefined ? {} : { ratio }),
      warn: capped || paced !== undefined,
    });
  }
  if (config.layers.llm) {
    const paced = wardenPacedUntil(status, 'investigation');
    const capped = spend.capsHit.includes('investigation');
    const pause = paced !== undefined ? ` · paused until ${paced}` : capped ? ' · cap hit, back at midnight UTC' : '';
    const pending = spend.pendingInvestigations > 0 ? ` · ${spend.pendingInvestigations} pending` : '';
    const ratio = ratioOf(spend.investigationUsd, spend.investigationCapUsd);
    lines.push({
      key: 'llm',
      name: 'LLM',
      summary: `${plural(investigations, 'investigation')} · ${usd(spend.investigationUsd)} of ${usd(spend.investigationCapUsd)} today${pending}${pause}`,
      ...(ratio === undefined ? {} : { ratio }),
      warn: capped || paced !== undefined,
    });
  }
  return lines;
};

// ── The chart ───────────────────────────────────────────────────────────────────────────────────

/** Bottom first: Auto, then Jev, then LLM — the same order and colours as everywhere on the page. */
export const CHART_SERIES: readonly MetricChartSeries[] = [
  { key: 'auto', label: ACTOR_LABEL.auto, tone: 'pend' },
  { key: 'jev', label: ACTOR_LABEL.jev, tone: 'info' },
  { key: 'llm', label: ACTOR_LABEL.llm, tone: 'accent' },
];

const dayActors = (day: WardenDayStats): Readonly<Record<WardenActor, number>> => {
  const total = (actor: WardenActor): number =>
    OUTCOMES.reduce((sum, outcome) => sum + countOf(day[outcome], actor), 0);
  return { auto: total('auto'), jev: total('jev'), llm: total('llm'), owner: total('owner') };
};

export interface WardenDayChart {
  readonly points: readonly MetricChartPoint[];
  /** How many of the seven days have no record, so the chart can say what its `?` means. */
  readonly missing: number;
}

const readoutFor = (day: WardenDayStats): string => {
  const { weekday, date } = dayParts(day.day);
  const actors = dayActors(day);
  const total = actors.auto + actors.jev + actors.llm;
  const who = (['auto', 'jev', 'llm', 'owner'] as const)
    .filter(actor => actors[actor] > 0)
    .map(actor => `${ACTOR_LABEL[actor]} ${actors[actor]}`)
    .join(', ');
  const head =
    total === 0 && actors.owner === 0 ? 'no actions' : `${plural(total, 'action')}${who === '' ? '' : ` — ${who}`}`;
  return `${weekday} ${date} · ${head} · ${plural(day.flags, 'flag')}`;
};

/**
 * Seven bars, the last seven UTC days with today last. A day with no record gets a bar of no height and
 * the label `Mon?`, so it reads as "not known", while a known quiet day is a drawn zero. No chart at all
 * when the daemon sent no history.
 */
export const wardenDayChart = (status: WardenStatusView, now: number): WardenDayChart | undefined => {
  const { history } = status;
  if (history === undefined || history.length === 0) return undefined;
  const today = utcDay(now);
  const byDay = new Map(history.map(entry => [entry.day, entry]));
  let missing = 0;
  const points = Array.from({ length: WEEK_DAYS }, (_, index): MetricChartPoint => {
    const day = shiftDay(today, index - (WEEK_DAYS - 1));
    const { weekday, date } = dayParts(day);
    const entry = byDay.get(day);
    if (entry === undefined) {
      missing += 1;
      return { key: day, label: `${weekday}?`, values: [0, 0, 0], readout: `${weekday} ${date} · no record` };
    }
    const actors = dayActors(entry);
    const values = [actors.auto, actors.jev, actors.llm];
    return {
      key: day,
      label: weekday,
      values,
      ...(values.every(value => value === 0) ? { empty: true } : {}),
      readout: readoutFor(entry),
    };
  });
  return { points, missing };
};

/** Whole-number ticks from zero to at least `max`: 0-1-2-3, or steps of 2, 5, 10… once the day is busy. */
export const wholeNumberTicks = (max: number): readonly number[] => {
  const top = Math.max(1, Math.ceil(max));
  const step = top <= 4 ? 1 : top <= 10 ? 2 : Math.ceil(top / 5 / 5) * 5;
  const last = Math.ceil(top / step) * step;
  return Array.from({ length: last / step + 1 }, (_, index) => index * step);
};
