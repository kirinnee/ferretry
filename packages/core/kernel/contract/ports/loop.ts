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
  /**
   * Hears every tick (a quarter second apart) with how late it fired in ms, the epoch ms it fired at, and a function that
   * names the work in flight (the boot step, or the jobs still running) when the late tick finally ran. Hearing a tick
   * costs no allocation: the observer is called with shared values, and `during` builds its labels only when called. Read
   * only, like `blockedMs`. The function it returns stops the hearing. Nothing is heard on a host whose composition root
   * does not run the tick (a suite), and it is called with no argument that could name a path, a value or a secret.
   */
  observe(observer: (lagMs: number, atMs: number, during: () => readonly string[]) => void): () => void;
}
