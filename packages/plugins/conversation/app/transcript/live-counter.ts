import type { FerretLiveActivity } from '@ferretry/core-ferrets/contract';
import type { PaneActivity } from './pane-activity.ts';

/**
 * THE WORDS OF A LIVE READOUT — the instants, token counts and elapsed times the working line prints, and which of
 * them a turn shows. The clock that drives it (aligned ticks, count-ups) is the shell's (`@ferretry/app`).
 */

/** The instant a turn began, as epoch milliseconds, or `null` when it is missing or unreadable. */
export const instantMs = (instant: string | undefined | null): number | null => {
  if (instant === undefined || instant === null) return null;
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) ? parsed : null;
};

/** A token count as the harness prints it: `980`, `3.1k`, `12k`, `1.2M`. */
export const formatTokenCount = (tokens: number): string => {
  const value = Math.max(0, Math.round(tokens));
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(Math.floor(value / 100) / 10).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.floor(value / 1000)}k`;
  return `${(Math.floor(value / 100_000) / 10).toFixed(1)}M`;
};

/** Elapsed whole seconds as the harnesses print them: `42s`, `5m 45s`, `1h 02m`. */
export const formatElapsedSeconds = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`;
  return `${Math.floor(whole / 3600)}h ${String(Math.floor((whole % 3600) / 60)).padStart(2, '0')}m`;
};

/** The harness's printed output counter (`↓ 3.1k tokens`) as a number, or `null` when there is none to read. */
const paneTokenCount = (printed: string | undefined): number | null => {
  // An `↑` counter is what is being SENT, not written; it is not an output reading.
  if (printed === undefined || printed.includes('↑')) return null;
  const match = /([\d.,]+)\s*([kKmM]?)\s*tokens?/u.exec(printed);
  if (match === null) return null;
  const value = Number((match[1] as string).replaceAll(',', ''));
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] as string).toLowerCase();
  return Math.round(value * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1));
};

/** What the live line shows for one working turn. `null` is unknown, and is printed as `—`. */
export interface LiveReadout {
  /** The turn's start, epoch ms — `null` for a daemon that records no turn boundary. */
  readonly startedAt: number | null;
  /** The harness's own verb, off the pane or the daemon's sample. */
  readonly verb: string | null;
  readonly outputTokens: number | null;
  readonly inputTokens: number | null;
}

export interface LiveReadoutEvidence {
  /** The daemon's `state.turnStateAt` for the working turn. */
  readonly turnStartedAt: string | null;
  /** The latest `live` frame off the session's stream. */
  readonly live: FerretLiveActivity | null;
  /** What this page last read off the pane itself. */
  readonly pane: PaneActivity | null;
}

/**
 * The one reading the live line renders, from the three places that know something.
 *
 * ONE TURN. A `live` sample counts only when it belongs to the turn the session reports working —
 * the same `turnStateAt` the whose-turn watcher wrote — so the last turn's totals never leak into
 * the first second of the next. Output takes the larger of the sample and the pane this page read,
 * because both only grow and the smaller is merely older.
 */
export const liveReadout = ({ turnStartedAt, live, pane }: LiveReadoutEvidence): LiveReadout => {
  const startedAt = instantMs(turnStartedAt);
  const sample = startedAt !== null && live !== null && live.turnStartedAt === turnStartedAt ? live : null;
  const fromSample = sample?.outputTokens ?? null;
  const fromPane = pane === null ? null : paneTokenCount(pane.tokens);
  const outputTokens = fromSample === null ? fromPane : fromPane === null ? fromSample : Math.max(fromSample, fromPane);
  return {
    startedAt,
    verb: pane?.verb ?? sample?.verb ?? null,
    outputTokens,
    inputTokens: sample?.inputTokens ?? null,
  };
};
