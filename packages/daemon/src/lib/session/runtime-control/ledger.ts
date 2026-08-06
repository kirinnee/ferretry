/**
 * Request ids this daemon has SPENT, so a retry never drives the harness a second time.
 *
 * THE ID IS SPENT BEFORE THE HARNESS IS TOUCHED, not after the answer is assembled. Recording only
 * successes leaves the dangerous window wide open: `/compact` types into the pane, the harness
 * compacts, and then the journal append or the closing read throws — the caller gets a `500` with
 * nothing recorded, retries with the same id, and the session is compacted twice. The keystrokes are
 * the irreversible part, so the reservation goes in front of them, and an entry with no view means
 * exactly "this was already performed and how it ended was never recorded".
 *
 * THE REQUEST IS KEPT BESIDE THE ANSWER. An id is a claim that two calls are the same call; a second
 * call under it carrying a different target is not a retry, and handing it the first call's session
 * view would report a switch that never happened.
 *
 * BOUNDED, because it is held for the life of the daemon and one whose composer chips are used
 * routinely would otherwise keep a whole session view per control it ever served. Oldest first: a
 * retry arrives seconds after its original, never thousands of controls later.
 */

import type { RuntimeControlRequest, SessionView } from '@ferretry/protocol';
import type { SessionId } from '../../session-id.ts';
import { SessionRuntimeError } from './types.ts';

/** How many spent ids are remembered. Far beyond any real retry window, far below a leak. */
export const RUNTIME_LEDGER_LIMIT = 512;

interface LedgerEntry {
  /** The control this id was spent on, so a second one carrying a different target is caught. */
  readonly request: string;
  /** Absent means "spent, outcome unrecorded" — the `unsettled` case. */
  readonly view?: SessionView;
}

/**
 * The control itself, in its parsed form.
 *
 * Two bodies that differ only in key order or whitespace are the same request, and a retry may well
 * re-serialize them — so the comparison is over the fields the union actually carries rather than
 * over the bytes that arrived.
 */
export function runtimeRequestFingerprint(request: RuntimeControlRequest): string {
  return JSON.stringify([
    request.action,
    request.action === 'compact' ? null : (request.effort ?? null),
    request.action === 'model' ? (request.model ?? null) : null,
  ]);
}

export class RuntimeRequestLedger {
  readonly #entries = new Map<string, LedgerEntry>();

  constructor(private readonly limit: number = RUNTIME_LEDGER_LIMIT) {}

  /** One session's use of one caller-supplied id. */
  #key(id: SessionId, requestId: string): string {
    return `${id}:${requestId}`;
  }

  /**
   * What this id already means, if anything.
   *
   * Returns the first call's answer for a genuine replay, and throws for the two cases a caller must
   * be told apart: an id reused for a different control, and an id whose outcome nobody recorded.
   */
  replay(id: SessionId, requestId: string, fingerprint: string): SessionView | undefined {
    const already = this.#entries.get(this.#key(id, requestId));
    if (already === undefined) return undefined;
    if (already.request !== fingerprint)
      throw new SessionRuntimeError(
        'conflict',
        `request id ${JSON.stringify(requestId)} was already spent on a different runtime control for this session`,
      );
    if (already.view !== undefined) return already.view;
    // Spent, and how it ended was never recorded — the first attempt reached the harness and then
    // failed on its own bookkeeping. Repeating it is the one thing that must not happen, so the
    // caller is told plainly to read the session rather than handed a second `/compact`.
    throw new SessionRuntimeError(
      'unsettled',
      `request id ${JSON.stringify(requestId)} was already performed on this session and its outcome was not recorded; read the session rather than retrying`,
    );
  }

  /** Reserve the id against a control, before the harness is touched. */
  spend(id: SessionId, requestId: string, fingerprint: string): void {
    this.#remember(this.#key(id, requestId), { request: fingerprint });
  }

  /** Record how it ended, so a later retry can be answered instead of refused. */
  settle(id: SessionId, requestId: string, fingerprint: string, view: SessionView): void {
    this.#remember(this.#key(id, requestId), { request: fingerprint, view });
  }

  #remember(key: string, entry: LedgerEntry): void {
    // Deleted first so a re-recorded key moves to the END of the insertion order, which is what makes
    // the eviction below oldest-first rather than "oldest by first sighting".
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.limit) break;
      this.#entries.delete(oldest);
    }
  }
}
