/**
 * The event loop's own account of its lateness, from the 250 ms tick that also feeds `GET /healthz`. Read-only: there is
 * no write, no restart lever and no way to reach the meter's detail from here, so it needs no permission.
 */
export interface LoopPort {
  /**
   * The total milliseconds the loop has been unable to run anything since this daemon started, through NOW (a late tick
   * that has not fired yet is counted). Never decreasing, so the blocked time over a window is the difference of two
   * readings. `0` on a host whose composition root does not run the tick (a suite).
   */
  blockedMs(): number;
}
