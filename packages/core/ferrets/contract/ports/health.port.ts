import type { FerretId } from '@ferretry/kernel/contract';

/** The health mark the Warden puts on a ferret it judges stuck. */
export interface HealthApi {
  /**
   * Additive (Warden's alone, c58-55): marks a RUNNING ferret's health `stalled` (`stalled` true) or takes the mark off again
   * (`stalled` false: only if its health is still `stalled`; it then returns to `healthy`). Status and every other field are
   * untouched, and a more telling mark (`crashed`, `rate_limited`) is never overwritten. A ferret that is not running, or
   * unknown, or whose health already says what was asked, is a no-op that answers `false`; otherwise `true`. Any other
   * consumer is refused with a 403 `forbidden`.
   */
  markStalled?(ferret: FerretId, stalled: boolean): Promise<boolean>;
}
