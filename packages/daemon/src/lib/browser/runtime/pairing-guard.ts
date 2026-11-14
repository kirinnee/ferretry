import { HOSTED_APP_ORIGIN } from '@ferretry/protocol';
import type { BrowserInputDocument } from '../transport/input-contracts.ts';
import { PAIRING_HISTORY_OVERFLOW } from '../transport/pairing-history.ts';
import type {
  BrowserActGuard,
  BrowserAfterCheck,
  BrowserGuardPage,
  BrowserPairingEvidence,
  BrowserPairingState,
} from './service.ts';

/**
 * THE PAIRING-SCREEN GUARD (docs/pairing.md, "Never show it to an agent").
 *
 * What an agent is handed of a page (its words, markup, picture, log, script result, or whether some text is on it) is
 * refused while a pairing code could be on a Ferretry page the script could reach, and a check BEFORE the operation
 * is not enough: the code can arrive while the operation runs. So a guard hands back an {@link BrowserAfterCheck} and
 * {@link underGuard} runs it once the operation has finished, its answer or its error in hand, and lets neither out
 * when a code was live at any point in between.
 *
 * THE EVIDENCE LIVES OUTSIDE THE PAGE. The app also leaves a marker and a counter in its own DOM, but page script can
 * write those (an agent's own script included) and a navigation resets them, so they are only a hint. What decides is
 * {@link BrowserPairingEvidence}: whether the daemon has a code live now, how many it has ever minted, and what the
 * browser worker saw pages commit — none of it reachable from a page, none of it reset by a navigation.
 */

/** A look that could not be made: it says the marker is there, because a refusal costs one read and a miss a credential. */
const UNKNOWN: BrowserPairingState = { marked: true, epochs: {} };

/** How long one look at a page may take: a page that cannot answer in this is read as marked. */
export const PAIRING_LOOK_MS = 10_000;

/** What the page's pairing documents say now; a page that cannot be asked, or a browser that cannot answer, is marked. */
async function look(page: BrowserGuardPage, limitMs: number): Promise<BrowserPairingState> {
  if (page.pairing === undefined) return UNKNOWN;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<BrowserPairingState>(resolve => {
      timer = setTimeout(() => resolve(UNKNOWN), limitMs);
    });
    return await Promise.race([page.pairing(), late]);
  } catch {
    return UNKNOWN;
  } finally {
    clearTimeout(timer);
  }
}

/** The addresses a machine's own loopback is reached by: one daemon, three spellings of where it is. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

/** The addresses a daemon binds to listen on every interface: loopback is one of the ways in, so it is the app's too. */
const WILDCARD_HOSTS: readonly string[] = ['0.0.0.0', '[::]'];

/**
 * The origins that are Ferretry's app: the hosted app always, the ones given in their canonical form, and for a loopback
 * or a wildcard-bound one (`0.0.0.0`, `[::]`) every spelling of loopback on the same port (`127.0.0.1`, `localhost`,
 * `[::1]`), because the same daemon answers on all of them whatever public address or CORS list is configured beside it.
 * An origin that does not parse is dropped; it could never match a page.
 */
export function appOriginSet(origins: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>([HOSTED_APP_ORIGIN]);
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      found.add(parsed.origin);
      const host = parsed.host.replace(/:\d+$/u, '');
      if (LOOPBACK_HOSTS.includes(host) || WILDCARD_HOSTS.includes(host))
        for (const host of LOOPBACK_HOSTS)
          found.add(`${parsed.protocol}//${host}${parsed.port === '' ? '' : `:${parsed.port}`}`);
    } catch {
      // not an origin: nothing to match
    }
  }
  return found;
}

/**
 * What the daemon and the worker say of one page and the pages its scripts could reach: whether it is the app's, whether
 * a code is live, and the two counts a later look compares. An origin the worker could not tell (`''`, an opaque or
 * blank page) or that overflowed its bound counts as the app's: a page that cannot be told apart may be anyone's.
 */
export function pairingEvidenceOf(
  document: Pick<BrowserInputDocument, 'pairingOrigins' | 'pairingCommits' | 'pairingLinked' | 'pairingLost'>,
  live: { readonly live: boolean; readonly minted: number },
  apps: ReadonlySet<string>,
): BrowserPairingEvidence {
  const isApp = (origin: string): boolean => origin === '' || origin === PAIRING_HISTORY_OVERFLOW || apps.has(origin);
  const origins = document.pairingOrigins;
  return {
    // An answer that names no origins cannot say the page is not the app's.
    app: origins === undefined || origins.length === 0 || origins.some(isApp),
    // Only an origin KNOWN to be the app's: a blank page may be anyone's and an agent may still script it.
    ownApp: origins?.some(origin => apps.has(origin)) === true,
    live: live.live,
    minted: live.minted,
    commits: Object.entries(document.pairingCommits ?? {}).reduce(
      (total, [origin, count]) => (isApp(origin) ? total + count : total),
      0,
    ),
    lost: document.pairingLost ?? 0,
    linked: document.pairingLinked === true,
  };
}

/** Whether a document that was counted before has shown a code since: its counter moved, or a new one came with one. */
function showedACodeSince(before: BrowserPairingState, now: BrowserPairingState): boolean {
  return Object.entries(now.epochs).some(([page, epoch]) => epoch !== (before.epochs[page] ?? 0));
}

/**
 * Whether the evidence moved between two looks. A pairing link committed on an app origin, or a navigation the browser
 * lost track of, discards the operation WHEREVER IT STARTED AND ENDED: an operation can begin outside the app, capture
 * the app's page on the way and finish outside it, and its endpoints say nothing of where it has been. Neither count can
 * go down, so no navigation, close or script can hide it. A code minted (live or not by the second look) discards one
 * that is, or became, on the app.
 */
function evidenceMoved(before: BrowserPairingState, now: BrowserPairingState): boolean {
  const first = before.evidence;
  const second = now.evidence;
  if (first === undefined || second === undefined) return false;
  if (second.commits !== first.commits || second.lost !== first.lost) return true;
  return (first.app || second.app) && second.minted !== first.minted;
}

/**
 * Whether a page must not be answered now. A marker anywhere a script could reach is a refusal. So is the app's page
 * while a code is live, or while its document was entered by a pairing link (or the browser's history is blind). A SCRIPT
 * is refused on a page of a Ferretry app origin ALWAYS (see {@link scriptOnApp}): it shares the document's DOM with the
 * app, which the app's own evidence and its codes sit in, so no state of the page makes it safe. On a page that is only
 * possibly the app's (blank, opaque) it is refused for the rest of the browser's life once any pairing link was opened
 * on an app origin: a link may have left its code in the document's state, wherever the page has been since.
 */
function refused(state: BrowserPairingState, script: boolean): boolean {
  if (state.marked) return true;
  const evidence = state.evidence;
  if (evidence === undefined || !evidence.app) return false;
  return evidence.live || evidence.linked || (script && evidence.commits > 0);
}

/** Whether an agent's script was asked to run where Ferretry's own app is, or ended there: the rule has no exception. */
function scriptOnApp(state: BrowserPairingState): boolean {
  return state.evidence?.ownApp === true;
}

/** How an operation is told apart from the others the guard covers. */
export interface PairingHold {
  /** The operation runs a script of the agent's own (`browser.eval`): refused for longer, see {@link refused}. */
  readonly script?: boolean;
  /** How long one look at the page may take before it reads as marked; {@link PAIRING_LOOK_MS} when absent. */
  readonly lookMs?: number;
  /** The refusal for a script on an app page, which says why (it is not about a code); `refusal` when absent. */
  readonly scriptRefusal?: () => Error;
}

/**
 * Refuses (with the error `refusal` builds) when a pairing code could be on the page now, and otherwise gives back the
 * check to run after the operation: it refuses when one could be then, or the evidence moved in between (a code minted, a
 * pairing link opened, a counter that moved) — however briefly, whichever page it happened on, and whatever the page did
 * to its own DOM or its navigation history in the meantime.
 */
export async function holdPairingScreen(
  page: BrowserGuardPage,
  refusal: () => Error,
  hold: PairingHold = {},
): Promise<BrowserAfterCheck> {
  const script = hold.script === true;
  const limit = hold.lookMs ?? PAIRING_LOOK_MS;
  const refuseScript = hold.scriptRefusal ?? refusal;
  const before = await look(page, limit);
  if (!before.marked && script && scriptOnApp(before)) throw refuseScript();
  if (refused(before, script)) throw refusal();
  return async () => {
    const now = await look(page, limit);
    if (!now.marked && script && (scriptOnApp(before) || scriptOnApp(now))) throw refuseScript();
    if (refused(now, script) || showedACodeSince(before, now) || evidenceMoved(before, now)) throw refusal();
  };
}

/**
 * Runs `work` under a guard, inside the page's queue: the guard first (it may refuse), then the work, then the check the
 * guard handed back — for a failure as well as an answer, since a script's error text is page content too. A refusal
 * from that check replaces both, and nothing the page said gets out.
 */
export async function underGuard<T>(
  guard: BrowserActGuard | undefined,
  page: BrowserGuardPage,
  work: () => Promise<T>,
): Promise<T> {
  const after = await guard?.(page);
  if (typeof after !== 'function') return await work();
  let done: T;
  try {
    done = await work();
  } catch (error) {
    await after();
    throw error;
  }
  await after();
  return done;
}
