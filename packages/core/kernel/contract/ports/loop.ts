/**
 * The event loop's own account of its lateness, from the 250 ms tick that also feeds `GET /healthz`. Read-only: there is
 * no write, no restart lever and no way to reach the meter's detail from here, so it needs no permission.
 */
export interface LoopPort extends WorkPort {
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

/**
 * What the kernel tells a work observer: names, counts and durations, never an argument, a path, a body or a value.
 * A route is named by its declared template (`GET /v1/ferrets/:ferretId`) or `<METHOD> [unrouted]`, never by the caller's
 * path; a child by its program's name alone; a file operation by the host filesystem method that ran.
 */
export interface WorkObserver {
  route(route: string, wallMs: number, status: number, bytes: number): void;
  childStarted(program: string): void;
  /** Only for a child the daemon waits on; a detached one is never waited on, so it has no exit. */
  childExited(program: string, wallMs: number): void;
  file(operation: string, wallMs: number): void;
}

/** Whether anyone is listening, then who: the kernel measures only while an observer is attached. */
export interface WorkPort {
  /**
   * Hears every route the dispatcher served, every child the host's spawn adapter ran and every call on the host
   * filesystem seam (`node:fs` is used nowhere else), each with its wall time. Read only, open to every plugin like
   * {@link LoopPort.observe}; nothing is measured while no observer is attached. Calls made through a held directory
   * descriptor are not counted. The function it returns stops the hearing.
   */
  observeWork(observer: WorkObserver): () => void;
}
