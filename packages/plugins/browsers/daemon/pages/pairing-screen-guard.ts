import type { NavigationEvidence } from '../target/lib/navigation-evidence.ts';
import type { BrowserActAfter, BrowserActGuard, BrowserGuardPage, BrowserPairingState } from './service.ts';

/**
 * WHAT THE GUARD ASKS OF THE DAEMON'S OWN FACTS, none of which a page script can write (docs/pairing.md, "Never show it to
 * an agent"). Built once from the plugin's ports (`../protection/windows.ts`) and handed to every agent content boundary.
 */
export interface ProtectionWindows {
  /** The daemon's clock, in epoch milliseconds: the same one the credentials' ledgers keep their intervals on. */
  now(): number;
  /**
   * The origins of the Ferretry app this machine serves or advertises (the hosted app, the advertised app and the allowed
   * browser origins, the local listener) — never one hard-coded address. `undefined` when they cannot be said: every
   * page is then taken for an app page (fail closed).
   */
  appOrigins(): ReadonlySet<string> | undefined;
  /**
   * Whether a credential (a pairing code, a share invite) was live at ANY instant from `sinceMs` until now. A provider
   * that is missing, throws or cannot say answers yes: unknown is live.
   */
  liveSince(sinceMs: number): boolean;
}

/** Which agent act the guard stands in front of. A script can run on past its own answer, so it is held to a lifetime rule. */
export type GuardedKind = 'content' | 'script';

/** An origin that is, or cannot be told from, one of the app's. */
const isApp = (origin: string, apps: ReadonlySet<string> | undefined): boolean =>
  apps === undefined || origin === '?' || apps.has(origin);

/** Whether any frame of the target is on an app origin right now. */
const onApp = (nav: NavigationEvidence, apps: ReadonlySet<string> | undefined): boolean =>
  nav.frames.some(origin => isApp(origin, apps));

/** Whether the target has ever, in its life, committed an app origin — or lost the history that could say it did not. */
const everApp = (nav: NavigationEvidence, apps: ReadonlySet<string> | undefined): boolean =>
  nav.overflow || nav.origins.some(entry => isApp(entry.origin, apps));

/** When the target first committed an app origin; the instant it began being watched when that cannot be told. */
function firstApp(nav: NavigationEvidence, apps: ReadonlySet<string> | undefined): number | undefined {
  const times = nav.origins.filter(entry => isApp(entry.origin, apps)).map(entry => entry.firstAt);
  if (nav.overflow) times.push(nav.watchedSince);
  return times.length === 0 ? undefined : Math.min(...times);
}

const anyOnApp = (state: BrowserPairingState, apps: ReadonlySet<string> | undefined): boolean =>
  state.targets.some(target => onApp(target.nav, apps));

/**
 * THE GUARD EVERY AGENT ACT THAT COULD HAND BACK A PAGE'S CONTENT RUNS (docs/pairing.md, "Never show it to an agent").
 *
 * The AUTHORITY is the daemon's own record of when a credential was live (`windows.liveSince`: a pairing code, a share
 * invite), joined with the browser's own record of where each page and frame has been (`NavigationEvidence`): neither is in
 * a page's DOM, so no page script and no navigation can erase them. The DOM marker the app sets is a HINT on top of that —
 * it can add a refusal, never remove one.
 *
 * - BEFORE the act (inside the page's queue): refused when the page, or any window of its opener group, shows the marker;
 *   when the browser cannot say where they are; when a credential is live NOW and any of them is on an app origin; and
 *   when one still sits on an app page a pairing link arrived on.
 * - AFTER the act, success or failure: refused — and then neither the answer nor the failure's own words are shown — when a
 *   credential was live at any instant from before the act began and the act touched an app origin at any point (it began
 *   there, ended there, or a page or a frame of the group moved to one meanwhile, closed or not), when a link of the
 *   pairing grammar was committed meanwhile, or when the hints moved.
 * - A SCRIPT is held to more: on an app target it is refused for the rest of the page's life once any credential was live
 *   since the page first showed the app, and for the rest of the life of one that ever committed a pairing link — a script
 *   that is already running, or that left a callback behind, can read a code that appears after its own answer was
 *   discarded, so only never starting it contains it.
 *
 * `refuse` makes the caller's own refusal (a tool error, an API error): the sentence is the caller's, and it names no
 * content. A person's calls never come here. A page that cannot be asked is one that cannot be shown (fail closed).
 */
export function pairingScreenGuard(
  refuse: () => Error,
  windows: ProtectionWindows,
  kind: GuardedKind = 'content',
): BrowserActGuard {
  return async (page: BrowserGuardPage): Promise<BrowserActAfter> => {
    // Read BEFORE the first look at the page: a credential minted between this instant and the look is inside the window.
    const started = windows.now();
    const before = await page.pairingState?.();
    if (before === undefined || before.marked) throw refuse();
    const apps = windows.appOrigins();
    if (anyOnApp(before, apps) && windows.liveSince(started)) throw refuse();
    // A page that still sits on the app a pairing link arrived on is the screen that holds the link's code.
    if (before.targets.some(target => target.nav.taintSeq > 0 && onApp(target.nav, apps))) throw refuse();
    if (kind === 'script') {
      for (const { nav } of before.targets) {
        if (nav.taintSeq > 0) throw refuse();
        const first = firstApp(nav, apps);
        if (first !== undefined && windows.liveSince(first)) throw refuse();
      }
    }
    return async later => {
      const now = await later.pairingState?.();
      if (now === undefined || now.marked) throw refuse();
      if (now.seen !== before.seen) throw refuse();
      const apps = windows.appOrigins();
      // A window that opened or closed meanwhile is a hint worth a refusal only where an app origin is in the group: the
      // navigation history below covers every window that joined or left, and a group away from the app (a popup a click
      // opened on some other site) has no credential to show.
      if (now.pages !== before.pages && (anyOnApp(before, apps) || anyOnApp(now, apps))) throw refuse();
      const priors = new Map(before.targets.map(target => [target.id, target.nav] as const));
      let involved = anyOnApp(before, apps) || anyOnApp(now, apps);
      for (const { id, nav } of now.targets) {
        const prior = priors.get(id);
        if (prior === undefined) {
          // A window that joined the group meanwhile: whatever it has been is part of the act.
          involved ||= everApp(nav, apps);
          if (nav.taintSeq > 0) throw refuse();
        } else if (nav.seq !== prior.seq) {
          if (nav.taintSeq > prior.seq) throw refuse();
          involved ||=
            nav.overflow || nav.origins.some(entry => isApp(entry.origin, apps) && entry.lastSeq > prior.seq);
        }
      }
      // A window that left the group meanwhile takes its documents, not its history, with it.
      const remaining = new Set(now.targets.map(target => target.id));
      for (const { id, nav } of before.targets) if (!remaining.has(id)) involved ||= everApp(nav, apps);
      if (involved && windows.liveSince(started)) throw refuse();
    };
  };
}
