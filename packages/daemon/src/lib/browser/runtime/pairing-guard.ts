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

/**
 * The origins that are Ferretry's app: the ones given, in their canonical form, and for a loopback one every spelling of
 * loopback on the same port (`127.0.0.1`, `localhost`, `[::1]`), because the same daemon answers on all of them. An
 * origin that does not parse is dropped; it could never match a page.
 */
export function appOriginSet(origins: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      found.add(parsed.origin);
      if (LOOPBACK_HOSTS.includes(parsed.host.replace(/:\d+$/u, '')))
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
  document: Pick<BrowserInputDocument, 'pairingOrigins' | 'pairingCommits' | 'pairingLinked'>,
  live: { readonly live: boolean; readonly minted: number },
  apps: ReadonlySet<string>,
): BrowserPairingEvidence {
  const isApp = (origin: string): boolean => origin === '' || origin === PAIRING_HISTORY_OVERFLOW || apps.has(origin);
  const origins = document.pairingOrigins;
  return {
    // An answer that names no origins cannot say the page is not the app's.
    app: origins === undefined || origins.length === 0 || origins.some(isApp),
    live: live.live,
    minted: live.minted,
    commits: Object.entries(document.pairingCommits ?? {}).reduce(
      (total, [origin, count]) => (isApp(origin) ? total + count : total),
      0,
    ),
    linked: document.pairingLinked === true,
  };
}

/** Whether a document that was counted before has shown a code since: its counter moved, or a new one came with one. */
function showedACodeSince(before: BrowserPairingState, now: BrowserPairingState): boolean {
  return Object.entries(now.epochs).some(([page, epoch]) => epoch !== (before.epochs[page] ?? 0));
}

/**
 * Whether the evidence moved between two looks on a page that is, or became, the app's: a code was minted (live or not
 * by the time of the second look) or a pairing link was opened. Neither can go down, so no navigation, close or script
 * can hide it.
 */
function evidenceMoved(before: BrowserPairingState, now: BrowserPairingState): boolean {
  const first = before.evidence;
  const second = now.evidence;
  if (first === undefined || second === undefined) return false;
  return (first.app || second.app) && (second.minted !== first.minted || second.commits !== first.commits);
}

/**
 * Whether a page must not be answered now. A marker anywhere a script could reach is a refusal. So is the app's page
 * while a code is live, or while its document was entered by a pairing link. A SCRIPT is refused on the app's page for
 * the rest of the browser's life once any pairing link was opened on an app origin: it runs in the document's world
 * and a link may have left its code in the document's state, wherever the page has been since.
 */
function refused(state: BrowserPairingState, script: boolean): boolean {
  if (state.marked) return true;
  const evidence = state.evidence;
  if (evidence === undefined || !evidence.app) return false;
  return evidence.live || evidence.linked || (script && evidence.commits > 0);
}

/** How an operation is told apart from the others the guard covers. */
export interface PairingHold {
  /** The operation runs a script of the agent's own (`browser.eval`): refused for longer, see {@link refused}. */
  readonly script?: boolean;
  /** How long one look at the page may take before it reads as marked; {@link PAIRING_LOOK_MS} when absent. */
  readonly lookMs?: number;
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
  const before = await look(page, limit);
  if (refused(before, script)) throw refusal();
  return async () => {
    const now = await look(page, limit);
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
