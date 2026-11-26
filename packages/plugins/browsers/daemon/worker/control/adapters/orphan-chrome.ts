/**
 * Finding and reaping a Chrome a dead daemon left behind on the shared agent profile.
 *
 * A pid alone proves nothing: it may have been recycled by an unrelated process, or belong to the
 * owner's own browser. So a process is only ever called Ferretry's orphan when its OWN command line
 * names this exact `--user-data-dir`, and only a profile lease with no live daemon behind it lets the
 * caller ask. Anything unreadable is never signalled.
 */

/** What a process's command line says about the profile, read from the process itself. */
type ProfileHolder = 'holds-profile' | 'other-process' | 'unknown';

export interface OrphanChromeInspector {
  /** The process's arguments, or `undefined` when they cannot be read (gone, or no permission). */
  readonly readArguments: (pid: number) => Promise<readonly string[] | undefined>;
  /** Asks the process to exit and reports whether it is really gone within the budget. */
  readonly terminate: (pid: number) => Promise<boolean>;
}

/** Whether `pid` runs Chrome on `profile`: exactly the `--user-data-dir` this store hands out. */
export async function profileHolder(
  inspector: Pick<OrphanChromeInspector, 'readArguments'>,
  pid: number,
  profile: string,
): Promise<ProfileHolder> {
  const args = await inspector.readArguments(pid);
  if (args === undefined || args.length === 0) return 'unknown';
  return args.some(arg => arg === `--user-data-dir=${profile}` || arg === `--user-data-dir=${profile}/`)
    ? 'holds-profile'
    : 'other-process';
}
