/**
 * THE ONE SEAM to the app shell's shared UI. Every component in this half takes its primitives from here and from
 * nowhere else. `@ferretry/app/ui` is the one home for them (lead decision D2 #4), so what it has is re-exported as is:
 * Badge, Button, RouteLink and `cn`. The clock is the browser's: a browser app half may read time and set timers
 * (D2 #4: `banned-globals` bans neither in app halves).
 *
 * The transcript card is drawn with `@ferretry/app`'s Markdown and reference surface, and with three small parts of its
 * own (`components/card-parts.tsx`: PeerName, MessageFooter, ToolGroup), because the chat's are Conversation's files. The
 * configuration-file port the settings page saves through is not here: the page builds it from its own per-daemon client
 * (`lib/config-files-client.ts`).
 */

export { Markdown, useReferenceSurface } from '@ferretry/app';
export { Badge, type BadgeTone, Button, cn, RouteLink } from '@ferretry/app/ui';
export { MessageFooter, PeerName, ToolGroup } from './components/card-parts.tsx';

/** The clock and timers a view reads time with. `after` and `every` return the function that cancels them. */
export interface ShellClock {
  now(): number;
  after(ms: number, run: () => void): () => void;
  every(ms: number, run: () => void): () => void;
}

const browserClock: ShellClock = {
  now: () => Date.now(),
  after: (ms, run) => {
    const handle = setTimeout(run, ms);
    return () => clearTimeout(handle);
  },
  every: (ms, run) => {
    const handle = setInterval(run, ms);
    return () => clearInterval(handle);
  },
};

/** The browser's clock, for a reader that is not a component (a feed shared by many cards). */
export const shellClock: ShellClock = browserClock;

export const useShellClock = (): ShellClock => browserClock;
