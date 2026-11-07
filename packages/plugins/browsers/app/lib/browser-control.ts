/**
 * WHO IS DRIVING A BROWSER PAGE, AND WHO HAS TAKEN ONE OVER — the session's control facts as the daemon reports
 * them (`GET …/surfaces/browser/control`), as questions a page can ask.
 *
 * A view is the daemon's COMPLETE answer, so a new one replaces the last outright; nothing here is a guess. A view
 * the daemon has not answered (not read yet, or no `browser` grant) is `null`, which reads as "nobody is driving,
 * nothing is held" only because that is the one reading that offers no control the daemon would refuse.
 *
 * DRIVING LAPSES ON ITS OWN. A `driving` record carries `until`, and the marker is shown only while `now < until`:
 * the daemon republishes before then while the agent keeps acting, and says nothing when it stops. So every question
 * about driving takes `now`, and {@link nextDrivingLapse} says when the answer next changes without any news.
 *
 * A PAGE IS ADDRESSED BY ITS ID OR ITS NAME. The daemon keys everything by id (a name can be reused by the next page
 * opened after this one closes), while a `%browser:app` reference may hold either; `key` matches the id, or the name
 * when the record carries one.
 */

import type { SurfaceControlView, SurfaceDriving } from './wire/control.ts';

const addresses = (record: { readonly id: string; readonly name?: string }, key: string): boolean =>
  record.id === key || record.name === key;

/** A view for another session is not this session's answer — a crossed or late response — and changes nothing. */
export const withControlView = (
  current: SurfaceControlView | null,
  sessionId: string,
  next: SurfaceControlView,
): SurfaceControlView | null => (next.sessionId === sessionId ? next : current);

/** The person's hold on a page, if one stands. */
export const takeoverFor = (view: SurfaceControlView | null, key: string) =>
  view?.takeovers.find(takeover => addresses(takeover, key));

/** The agent driving a page right now — its marker unlapsed, and nobody holding the page. */
export const drivingFor = (view: SurfaceControlView | null, key: string, now: number): SurfaceDriving | undefined => {
  if (takeoverFor(view, key) !== undefined) return undefined;
  return view?.driving.find(driving => addresses(driving, key) && Date.parse(driving.until) > now);
};

/** The agent's hand-over of a page nobody has taken yet. */
export const askedFor = (view: SurfaceControlView | null, key: string) => {
  if (takeoverFor(view, key) !== undefined) return undefined;
  return view?.asked.find(asked => addresses(asked, key));
};

/**
 * When the next standing marker lapses, as epoch milliseconds — the instant the answer to "who is driving" changes
 * with no news at all — or undefined when no marker is standing.
 */
export const nextDrivingLapse = (view: SurfaceControlView | null, now: number): number | undefined => {
  const lapses = (view?.driving ?? [])
    .filter(driving => drivingFor(view, driving.id, now) === driving)
    .map(driving => Date.parse(driving.until));
  return lapses.length === 0 ? undefined : Math.min(...lapses);
};

/** What a person calls the agent driving a page: its name, or a plain stand-in when it has none. */
export const drivingAgentName = (driving: SurfaceDriving): string => driving.agentName ?? 'The agent';
