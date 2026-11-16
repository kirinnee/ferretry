import type { SessionRootPinner } from '../../../contract/pinned.ts';
import { PosixSessionRootPinner } from './posix-session-root-pinner.ts';
import { ProcfsSessionRootPinner } from './procfs-session-root-pinner.ts';

export { loadDirectorySyscalls } from './directory-syscalls.ts';
export * from './pin-support.ts';
export * from './posix-session-root-pinner.ts';
export * from './procfs-session-root-pinner.ts';
export { WorkingDirectory } from './working-directory.ts';

/** Today's choice (`fyd.ts`): the procfs alias on Linux, the installed-directory walk everywhere else. */
export function platformRootPinner(platform: string = process.platform): SessionRootPinner {
  return platform === 'linux' ? new ProcfsSessionRootPinner() : new PosixSessionRootPinner();
}
