/**
 * WHAT CROSSES BETWEEN THE DAEMON AND ITS HOUSEKEEPING WORKER (S176).
 *
 * The worker reads one sign-in store and makes the free usage read with a token from that one read. The daemon
 * (main) keeps everything that lasts: the per-credential lock, the status heads, the usage cache and every write.
 *
 * NOTHING HERE CAN CARRY CREDENTIAL MATERIAL. A job names a store by its path inside the `credentials` root, and an
 * answer is facts: a status, an expiry, a truncated digest, a usage reading. No type in this file has a field a blob or
 * a token could travel in, and a type test holds that (`tests/integration/rows/secrets-rows.test.ts`). A
 * failure is a member of {@link HousekeepingFailure}, never a caught error's message, because a JSON parser's message
 * can quote the very bytes it failed on.
 *
 * Type-only: the protocol costs the worker nothing at run time.
 */
import type { ActiveUsageRead } from './credential-status.ts';

/** One piece of work: the free usage read of one sign-in. */
export interface ActiveUsageJob {
  readonly kind: 'credential.active';
  readonly harness: 'claude' | 'codex';
  /** The sign-in file, relative to the `credentials` root. Never absolute: the grant refuses a path outside the root. */
  readonly file: string;
  /** The daemon's clock, read on main: a worker has no clock of its own to read. */
  readonly nowMs: number;
}

/** Why a job has no answer, as a closed set: it threw, and what it threw is not said. */
type HousekeepingFailure = 'internal';

/** Main → worker. `{ probe: true }` is `fyd --check`'s: the worker answers `{ probe: true }`. */
export type HousekeepingRequest =
  | { readonly probe: true }
  | { readonly type: 'job'; readonly id: number; readonly job: ActiveUsageJob };

/** Worker → main. */
export type HousekeepingResponse =
  | { readonly type: 'result'; readonly id: number; readonly ok: true; readonly value: ActiveUsageRead }
  | { readonly type: 'result'; readonly id: number; readonly ok: false; readonly failure: HousekeepingFailure }
  | { readonly probe: true };
