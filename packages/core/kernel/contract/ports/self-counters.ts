/**
 * The daemon's OWN process counters, for a plugin that reports on the daemon itself (Usage's `fy daemon profile`). A port of
 * its own rather than a grant of `hostFacts`: `hostFacts` reaches any pid's command line, the process list, descriptors and
 * machine facts, and none of that is needed (or allowed) here. The two methods name their one file; no pid, path or file name
 * crosses, so there is nothing to widen. Each throws as the read it replaces does (a missing file, a platform without `/proc`).
 */
export interface SelfCountersPort {
  /** `process.platform`. */
  readonly platform: string;
  /** `/proc/self/io`: read and write system-call counts (`syscr`, `syscw`). */
  io(): Promise<string>;
  /** `/proc/self/stat`: CPU times, including the reaped children's (`cutime`, `cstime`). */
  stat(): Promise<string>;
}
