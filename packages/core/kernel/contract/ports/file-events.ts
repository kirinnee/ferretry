/** One directory the host polls instead of watching, and why: a system error code (`EMFILE`, `ENOENT`), or `failed`. */
export interface PolledDirectory {
  readonly directory: string;
  readonly reason: string;
  /** How often the host looks at it, in milliseconds. */
  readonly everyMs: number;
}

/**
 * What the host's file events could not watch, for a plugin that reports on the daemon itself (Usage's performance
 * profile). READ-ONLY and no subscribe: it lists the directories the host polls (every few seconds a `stat` sweep instead
 * of an event) so a report can say so; it watches nothing for the caller and takes no path.
 */
export interface FileEventsPort {
  /** The directories polled right now, in the order they began to be. */
  polled(): readonly PolledDirectory[];
}
