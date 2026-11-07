/**
 * The seam the `fy` shell fills so `fy update --run` can do the one thing no plugin half may: drive this machine's
 * package managers, files and service manager. The daemon starts that process detached (`UpdateHost.launchUpdate`), so
 * it outlives the restart it performs. A shell that does not carry the seam answers `--run` honestly instead of
 * pretending (exit 69).
 */
import type { DaemonUpdaterDeps } from './updater.ts';
import type { IDaemonUpdateViewPort } from './ports.ts';

export interface UpdateMachine {
  /** The transaction's ports over this machine, reading the daemon's update view through `view`. */
  deps(view: IDaemonUpdateViewPort): { readonly deps: DaemonUpdaterDeps; exitCode(): number };
}
