/**
 * The filesystem this client needs in order to claim a state home, and nothing more.
 *
 * Deliberately the narrowest surface that can express a claim: look at the home, read the marker,
 * create the home, write the marker. It cannot delete, cannot move, and cannot read the CONTENTS of
 * anything else under the home — which matters because this client does not otherwise read the
 * daemon's state, and a port that could would invite it to start. Listing names is the one exception,
 * and it is the minimum a claim needs to tell an empty scaffold from a populated installation.
 */
export interface IStateHomeFilePort {
  /**
   * Every entry directly inside the home, or `undefined` when the home does not exist.
   *
   * The distinction is the whole point: an absent home is one this client may create, an empty one
   * is one it may claim, and neither is the same as a home holding a stranger's files.
   */
  listHome(home: string): Promise<readonly StateHomeEntry[] | undefined>;
  /**
   * Every entry directly inside a directory BELOW the home, or `undefined` when it does not exist.
   *
   * Names and kinds only, never contents: it is how a claim proves that a marker-less home holds
   * nothing but empty Ferretry directories and logs before adopting it unattended.
   */
  listDirectory(path: string): Promise<readonly StateHomeEntry[] | undefined>;
  /** The marker's contents, or `undefined` when there is no marker. */
  readMarker(path: string): Promise<string | undefined>;
  /** Create the directory and every missing parent with this mode. Existing is success. */
  ensureDirectory(path: string, mode: number): Promise<void>;
  /**
   * Write the marker so that a reader never sees a partial one.
   *
   * Atomic because a half-written marker is worse than none: `1` truncated to nothing reads as an
   * unclaimed home, but a marker containing a stray byte reads as `invalid-version`, which is a
   * refusal this repair path cannot clear.
   */
  writeMarkerAtomic(path: string, contents: string, mode: number): Promise<void>;
}

/** One entry directly inside the state home, or inside a directory below it. */
export interface StateHomeEntry {
  readonly name: string;
  readonly directory: boolean;
  /**
   * An ordinary file — not a directory, link, socket or device. A recognised NAME is not enough to
   * accept a log: a symbolic link called `fyd.log` is somebody else's arrangement.
   */
  readonly regularFile: boolean;
}
