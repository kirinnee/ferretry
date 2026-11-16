import { createContext, type ReactNode, useContext } from 'react';
import { changeRefusalExplanation } from '../ui/change-authority.ts';

/**
 * WHERE A VIEW IS DRAWN (shell contract S1): the machine a per-daemon view is for, whether it answers, and what this
 * device may do there — read from the shell's ONE per-daemon grants cache (`shell/grants-cache.ts`). The kernel's
 * frozen view props (`PanelProps`, `SettingsProps`) are not widened: a view reads this from a context `PluginView`
 * sets around it, so no plugin's `build` signature changes.
 *
 * THE DAEMON'S REFUSAL IS THE AUTHORITY; THE UI IS THE COURTESY (grants.md: explain, don't grey). A control is hidden
 * only once the daemon said this device may not have it; while the first read is in flight it is disabled with words;
 * on a locked machine it shows and a press asks for the unlock first.
 */

/**
 * Gate's capability names (`gate/contract/policy.ts` `CAPABILITY_NAMES`), mirrored here because `@ferretry/app` does
 * not depend on Gate — the way `CHANGE_REFUSALS` mirrors `GRANT_REFUSALS` — and pinned to Gate's list by
 * `packages/core/gate/tests/unit/app-mirror-parity.test.ts`.
 */
export const CAPABILITY_NAMES = [
  'fleet',
  'terminal',
  'browser',
  'filesystem',
  'warden',
  'pairing',
  'secrets',
  'sharing',
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type Axis = 'use' | 'configure';

/** What this device may do with one (capability, axis) on one machine — the vocabulary of `ui/change-authority.ts`. */
export type Authority =
  /** Enabled. */
  | { readonly kind: 'open' }
  /** Enabled; the press raises the passkey step-up. */
  | { readonly kind: 'step-up' }
  /** Enabled; the machine wants its unlock, and a press raises it FIRST (ruling #54). */
  | { readonly kind: 'locked' }
  /** Hidden: the daemon said this device may not have it. */
  | { readonly kind: 'refused'; readonly refusal: 'not-granted' | 'device-not-granted' }
  /** Disabled with the sentence: the daemon cannot read its own grant document. */
  | { readonly kind: 'refused'; readonly refusal: 'undetermined' }
  /** Disabled with "Checking what this device may do…": the first read is in flight (or the machine never answered). */
  | { readonly kind: 'unknown' }
  /** Disabled with the sentence: the read came back in a shape this app cannot read. */
  | { readonly kind: 'unreadable' };

export interface ViewPlace {
  /** The durable paired id the view is drawn for. */
  readonly daemon: string;
  /** The owner's label for the machine, else its name. */
  readonly machine: string;
  /** The daemon's event feed is live; the view re-renders when it changes. */
  readonly online: boolean;
  readonly authority: (capability: CapabilityName, axis: Axis) => Authority;
  /** The authority of a route a compiled manifest declares; `unknown` for any other, never `open`. */
  readonly authorityOf: (route: string) => Authority;
  /**
   * Runs a press. On a `locked` machine it awaits the explicit unlock FIRST (so a GET-first or socket-first act still
   * asks at once); a dismissed unlock answers `undefined` and `act` is not run. Otherwise it runs `act`.
   */
  readonly press: <T>(act: () => Promise<T>) => Promise<T | undefined>;
}

const ViewPlaceContext = createContext<ViewPlace | null>(null);

/** Sets the place a per-daemon view is drawn in (`PluginView`); `null` hides it (`WithoutShell`). */
export function WithViewPlace({ place, children }: { readonly place: ViewPlace | null; readonly children: ReactNode }) {
  return <ViewPlaceContext.Provider value={place}>{children}</ViewPlaceContext.Provider>;
}

/**
 * Where this view is drawn, or `null` outside a per-daemon view: in a plugin's own harness or suite, on a daemon-less
 * screen, in a device view or a device panel (none of which is any one machine's).
 */
export function useViewPlace(): ViewPlace | null {
  return useContext(ViewPlaceContext);
}

/** The line a control shows while this device does not know yet what it may do. */
export const CHECKING_LINE = 'Checking what this device may do…';
/** The line a control shows when the grants answer could not be read. */
export const UNREADABLE_LINE =
  'This device could not read what it may do on this machine, so this is off until it answers in a shape it can read.';

const ENABLED = Object.freeze({ shown: true, enabled: true });
const HIDDEN = Object.freeze({ shown: false, enabled: false });

/** How a control shows for an authority: the one mapping every plugin uses. */
export function controlState(a: Authority): {
  readonly shown: boolean;
  readonly enabled: boolean;
  readonly note?: string;
} {
  switch (a.kind) {
    case 'open':
    case 'step-up':
    case 'locked':
      return ENABLED;
    case 'refused':
      return a.refusal === 'undetermined'
        ? { shown: true, enabled: false, note: changeRefusalExplanation('undetermined') }
        : HIDDEN;
    case 'unknown':
      return { shown: true, enabled: false, note: CHECKING_LINE };
    case 'unreadable':
      return { shown: true, enabled: false, note: UNREADABLE_LINE };
  }
}
