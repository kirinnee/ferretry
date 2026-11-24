/**
 * THE DOT ON A FERRET'S ROW for a page its agent opened where the owner was not looking: another ferret's page was on screen,
 * or a sign-in card was open on the phone, so the Browser panel did not jump (`panel-reveal.ts` in the app).
 * It clears when the owner brings that ferret's Browser panel on screen. Drawn through `ferrets.list-row-mark`.
 */

import { usePanelRevealMark } from '@ferretry/app';
import './browser.css';

export interface PageOpenedMarkProps {
  readonly daemon: string;
  /** The ferret whose row this is. */
  readonly ferret: string;
}

export function PageOpenedMark({ daemon, ferret }: PageOpenedMarkProps) {
  if (!usePanelRevealMark(daemon, ferret)) return null;
  return (
    <span
      aria-label="The agent opened a browser page"
      className="fy-browser-opened-mark"
      data-browser-opened-mark=""
      role="img"
    >
      <span aria-hidden="true" className="fy-browser-opened-mark__dot" />
      Browser page
    </span>
  );
}
