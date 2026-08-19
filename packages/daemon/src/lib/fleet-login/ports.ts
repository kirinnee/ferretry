/**
 * The seams a daemon-side harness login needs, and nothing that decides anything.
 *
 * Two of these carry the whole property change this feature makes. `fy fleet login` today inherits all
 * three of the child's streams and reads none of them (`process-login.ts:89-97`); a remotable login has
 * to PIPE them, which makes the daemon a reader of harness output for the first time. So the port is
 * shaped to bound that: the child is delivered as LINES to a callback, one at a time, and the only thing
 * a caller can do with the child besides read it is write one value and kill it. There is no method that
 * yields the raw stream, no buffer to inspect, and nothing to journal.
 */

/** Every flow state carries these, whichever harness it is. Facts about the FLOW, not about a harness. */
export interface HarnessLoginFlowBase {
  readonly flowId: string;
  readonly accountId: string;
  readonly identity: string;
  readonly startedAt: string;
  readonly expiresAt: string;
}

/**
 * Whether the person's value may be written to the child now.
 *
 * The value itself never reaches a flow module: a flow answers `write` or refuses, and the service does
 * the writing. That is what makes "the submitted value is write-only" a property of the shape rather
 * than a rule a future author has to remember — there is no parameter here it could arrive through.
 */
export type HarnessLoginSubmitDecision =
  | { readonly decision: 'write' }
  | { readonly decision: 'refused'; readonly reason: string }
  | { readonly decision: 'conflict'; readonly reason: string };

/** Writes one value to the child's stdin. `false` means the child was no longer reading. */
type HarnessLoginWrite = (value: string) => Promise<boolean>;

/** One running harness login child. */
export interface HarnessLoginChild {
  readonly write: HarnessLoginWrite;
  /** Ends the child. Idempotent: cancelling twice is not an error. */
  kill(): void;
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

/** Reading a generated wrapper, so the sanitizer learns which variables it deliberately references. */
export type HarnessLoginWrapperSource = (path: string) => Promise<string | undefined>;
