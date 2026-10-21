/**
 * The Terminal tab's pure layer: the daemon-scoped snapshot read and the two
 * freshness strings its header prints.
 *
 * The original (`ui/src/components/TerminalView.tsx`) reached a page-global
 * `api.snapshot(sessionId, false)`. There is no page-global daemon here: a
 * session id reused across two paired daemons must never resolve to whichever
 * one happens to be selected, so the read takes an explicit `(daemon, scope)`
 * pair and refuses a scope that belongs to a different daemon.
 */

import type { SnapshotScope } from '@ferretry/protocol';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { daemonRequest } from '../lib/daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from '../lib/runtime-models.ts';

/**
 * `live=false` is the original's choice and the reason the header says
 * "cached": the tab shows the snapshot the daemon already holds rather than
 * making every reader poll force a live capture off the pane.
 *
 * `extent` is the daemon's `scope` query: `screen` asks a live capture for the visible frame only,
 * which is all the activity line reads, instead of the whole scrollback every poll would otherwise
 * carry over the relay. It is omitted for `history`, so the default URL is the one it always was.
 */
export const snapshotUrl = (scope: DaemonSessionScope, live = false, extent: SnapshotScope = 'history'): string =>
  `/v1/sessions/${encodeURIComponent(scope.sessionId)}/snapshot?live=${live ? 'true' : 'false'}${
    extent === 'screen' ? '&scope=screen' : ''
  }`;

const failure = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/** Reads one pane snapshot from the daemon that owns the session. */
export const readPaneSnapshot = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  signal?: AbortSignal,
  fetcher: DaemonFetch = browserFetch,
  /** Capture the pane now rather than answer with the stored final frame — the activity line's read. */
  live = false,
  /** How much of a live pane to return; `screen` is the visible frame. */
  extent: SnapshotScope = 'history',
): Promise<string> => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('terminal scope must belong to the requested daemon');
  const target = daemonRequest(daemon, snapshotUrl(scope, live, extent), { signal });
  const response = await fetcher(target.url, target.init);
  if (!response.ok) throw await failure(response);
  return await response.text();
};

/** How the daemon's unreachability is worded when the last good text is kept. */
export const describeSnapshotError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * "<1s" / "12s" / "3m 4s", exactly as the original — the unit never collapses
 * to bare minutes, so a reader can tell 3m 1s from 3m 59s.
 */
export const formatSnapshotAge = (ms: number): string => {
  const clamped = ms < 0 ? 0 : ms;
  if (clamped < 1_000) return '<1s';
  const seconds = Math.floor(clamped / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** The absolute wall clock behind the header's `title`, or '' for a bad instant. */
export const formatSnapshotClock = (at: number): string => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/**
 * FIT TO WIDTH — a phone's default for a pane captured wider than the phone.
 *
 * A host pane is routinely 80+ columns and a 390px phone holds ~45 at 12px, so every line was cut at
 * the right edge behind a sideways scroll ("Switch anyt…", "prompts automa…"). Fit sizes the text so
 * the WIDEST line fits the pane instead: the pane's own columns, never a reflow, because rewrapping a
 * TUI's box-drawing breaks it. Scroll mode is one tap away, and pinch-zoom still works on the page.
 */
export const FIT_MAX_FONT_PX = 12;
/** Below this a monospace face stops being text; the pane scrolls sideways again rather than shrink further. */
export const FIT_MIN_FONT_PX = 6.5;
/** A monospace glyph's advance as a fraction of its size — 0.6em for every face the theme ships, rounded up. */
export const MONO_ADVANCE_EM = 0.61;

/** The widest line's length in characters, trailing blanks ignored — the columns the text really uses. */
export const paneColumns = (text: string): number =>
  text.split('\n').reduce((widest, line) => Math.max(widest, [...line.trimEnd()].length), 0);

/** The font size that fits `columns` into `widthPx`, clamped; 12px when there is nothing to fit. */
export const fitFontPx = (columns: number, widthPx: number): number => {
  if (columns === 0 || widthPx <= 0) return FIT_MAX_FONT_PX;
  const fitted = Math.floor((widthPx / (columns * MONO_ADVANCE_EM)) * 10) / 10;
  return Math.min(FIT_MAX_FONT_PX, Math.max(FIT_MIN_FONT_PX, fitted));
};
