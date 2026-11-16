/**
 * What Updates takes from the kernel's `UpdateHostPort` (the release, whether this is a compiled build, the running
 * executable and the one detached launch) plus the few facts the kernel does not carry: the names of the product and
 * its binaries, the machine user's home, and a search of `PATH` (a link's target is read by the bounded `readlink`). The port itself is the kernel's contract; nothing
 * here restates its shape.
 */
import type { UpdateHostPort } from '@ferretry/kernel/contract';

/** The names the plan's steps and the release request are typed with. */
export interface UpdateNames {
  /** The product name (`ferretry`): the cask, the flake and the release repository. */
  readonly product: string;
  /** The client binary name (`fy`) the plan's steps are typed with. */
  readonly client: string;
  /** The daemon's binary name (`fyd`), which names it to GitHub (`User-Agent`). */
  readonly daemon: string;
}

/** What the daemon half reads off the machine beside the port. */
export interface InstallSeams {
  readonly homeDirectory: string;
  /** A `PATH` search; `undefined` when nothing is found. */
  which(name: string): string | undefined;
}

/** The kernel's port with everything `HostInstallFacts` reads. */
export interface InstallHost extends InstallSeams {
  readonly port: UpdateHostPort;
  readonly product: string;
}

/**
 * `kernel.updateHost` answered nothing usable: the host did not give this plugin a build to read (the kernel's
 * `undeclaredUpdateHost`, whose executable facts refuse). The routes answer `503 update_host_unavailable`.
 */
export async function updateHostUsable(port: UpdateHostPort): Promise<boolean> {
  try {
    await port.executable();
    return true;
  } catch {
    return false;
  }
}
