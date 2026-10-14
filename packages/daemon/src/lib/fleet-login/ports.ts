/**
 * The seams a daemon-side harness login needs, and nothing that decides anything.
 *
 * Two of these carry the whole property change this feature makes. A terminal sign-in inherits all
 * three of the child's streams and reads none of them; a remotable login has
 * to PIPE them, which makes the daemon a reader of harness output for the first time. So the port is
 * shaped to bound that: the child is delivered as LINES to a callback, one at a time, and the only thing
 * a caller can do with the child besides read it is write one value and kill it. There is no method that
 * yields the raw stream, no buffer to inspect, and nothing to journal.
 */

import type { CodexCallbackDelivery } from './codex-link.ts';

/** Every flow state carries these, whichever harness it is. Facts about the FLOW, not about a harness. */
export interface HarnessLoginFlowBase {
  readonly flowId: string;
  /** The account-model credential being signed in. */
  readonly credentialId: string;
  readonly identity: string;
  readonly startedAt: string;
  readonly expiresAt: string;
}

/** A submission that may not go ahead, in words. Both flows answer with these. */
type HarnessLoginSubmitRefusal =
  | { readonly decision: 'refused'; readonly reason: string }
  | { readonly decision: 'conflict'; readonly reason: string };

/**
 * Whether Claude's value may be written to the child now.
 *
 * The value itself never reaches Claude's flow module: it answers `write` or refuses, and the service
 * does the writing. That is what makes "the submitted value is write-only" a property of the shape
 * rather than a rule a future author has to remember — there is no parameter it could arrive through.
 */
export type HarnessLoginSubmitDecision = { readonly decision: 'write' } | HarnessLoginSubmitRefusal;

/**
 * What may be done with what a person sent to a Codex flow.
 *
 * Codex's link sign-in is the one place a flow module sees a submitted value, because the value is an
 * ADDRESS that has to be checked against the one Codex printed. The flow answers `deliver` with the
 * single request to make, built from the checked parts, and the service hands it to
 * {@link HarnessLoginCallbackDeliver} and drops it. `switch` is "use a link instead" for a device code.
 */
export type CodexSubmitDecision =
  | { readonly decision: 'deliver'; readonly delivery: CodexCallbackDelivery }
  | { readonly decision: 'switch' }
  | HarnessLoginSubmitRefusal;

/**
 * Delivers one checked address to Codex's own listener on THIS machine, the way the browser would have.
 *
 * The adapter fixes the host to the loopback address; this port can name only a port, a path and a
 * query, so there is no shape of call that sends the address anywhere else. It never follows a redirect
 * and never returns what Codex answered:
 *
 * - `delivered` — Codex answered. Whether the sign-in worked is told by how the child exits.
 * - `refused` — Codex answered that it was not waiting for this (a stale `state`) and is still waiting.
 * - `unreachable` — nothing answered, so nobody can say whether the address arrived.
 */
export type HarnessLoginCallbackDeliver = (
  delivery: CodexCallbackDelivery,
) => Promise<'delivered' | 'refused' | 'unreachable'>;

/** Writes one value to the child's stdin. `false` means the child was no longer reading. */
type HarnessLoginWrite = (value: string) => Promise<boolean>;

/** One running harness login child. */
export interface HarnessLoginChild {
  readonly write: HarnessLoginWrite;
  /**
   * Ends the child AND everything it started — a harness launcher that spawned the real binary is one
   * sign-in, and the binary is what holds the callback port. `SIGTERM` unless told otherwise.
   * Idempotent: cancelling twice is not an error.
   */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
  /** The exit code, once it has one. */
  readonly exited: Promise<number>;
}

export interface HarnessLoginChildSpec {
  /** Absolute executable first, then the harness's own arguments. Never a shell string. */
  readonly command: readonly string[];
  /** Already sanitized by the caller: a login must not inherit another account's credentials. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /**
   * One line of the child's output, exactly as written, escapes and all.
   *
   * Raw on purpose. Each harness's flow strips escapes itself, which is what lets a flow test feed the
   * bytes the real CLI was OBSERVED to emit rather than a cleaned-up version of them.
   */
  readonly onLine: (line: string) => void;
}

/** Launching one harness login child with piped stdio. The only seam here that starts a program. */
export type HarnessLoginSpawn = (spec: HarnessLoginChildSpec) => HarnessLoginChild;

/**
 * A one-shot timer, so a flow nobody polls still ends.
 *
 * Injected rather than `setTimeout` in place for the ordinary reason — a test must be able to reach the
 * deadline without waiting for it — and because the production implementation has to be unreferenced:
 * a pending timer that keeps the event loop alive would delay this daemon's shutdown by the whole login
 * window.
 */
export interface HarnessLoginTimer {
  after(milliseconds: number, run: () => void): () => void;
}
