/**
 * THE PURE POLICY BEHIND THE PERSISTENT AGENT SIDEBAR. Ported from the
 * non-rendering half of kteam `ui/src/components/AgentSidebar.tsx`.
 *
 * The sidebar is the fleet, always on screen, and it is where the most
 * destructive action in the app lives. Everything here is the part of it that
 * decides rather than draws — gesture thresholds, which menu entries exist, what
 * a bulk stop will hit, which run is still current, and where focus goes when
 * the drawer opens. Kept separate so those contracts are asserted without a
 * browser and so the row and the confirmation cannot drift apart.
 *
 * Daemon scope: nothing here is stored or cached. Every function is given the
 * session list it should reason about, so one daemon's fleet can never leak into
 * another's menu or sweep.
 */

// ---------------------------------------------------------------------------
// Row gesture policy
//
// A session row is a nav link, NOT selectable prose, so a long-press here is
// free to open a menu — unlike the transcript, where long-press IS selection.
// Desktop opens on the native `contextmenu`; touch opens on a held press. That
// includes Android, which ALSO fires `contextmenu` on a long-press, so both
// paths share one opener and a suppression window stops the trailing tap from
// navigating into the session underneath the menu that just opened.
// ---------------------------------------------------------------------------

/** How long a finger must dwell before the row menu opens. */
export const LONG_PRESS_MS = 500;
/** A press that drifts more than this is a scroll, not a long-press — cancel. */
export const MOVE_CANCEL_PX = 10;
/** After the menu opens from a press, swallow the click the same gesture fires. */
export const CLICK_SUPPRESS_MS = 700;

export interface PressPoint {
  readonly x: number;
  readonly y: number;
}

/** True when a press has drifted far enough to be a scroll rather than a dwell. */
export const cancelsRowLongPress = (start: PressPoint, point: PressPoint): boolean =>
  Math.abs(point.x - start.x) > MOVE_CANCEL_PX || Math.abs(point.y - start.y) > MOVE_CANCEL_PX;

/**
 * True while the click produced by the menu-opening gesture must be ignored. `firedAt` 0 is "no menu
 * opened": `performance.now()` also starts at zero, so without that case every click in the first 700ms
 * of a page read as a long-press's trailing tap and was swallowed.
 */
export const suppressesRowClick = (firedAt: number, now: number): boolean =>
  firedAt !== 0 && now - firedAt < CLICK_SUPPRESS_MS;

// ---------------------------------------------------------------------------
// Row and bulk menu contents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bulk stop run identity
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ordering and focus
// ---------------------------------------------------------------------------
