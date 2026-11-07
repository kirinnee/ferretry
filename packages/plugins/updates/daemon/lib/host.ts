/**
 * What only the running process knows about itself, which `KernelPorts` does not carry yet: its release number, the
 * path it was launched as and how to find its own files, and the means to start the update beside it so it outlives
 * the restart it performs (docs/updating.md). The daemon half takes it from the kernel when the host provides it and
 * answers `503 update_host_unavailable` when it does not: the routes then say so instead of guessing a version.
 */
import type { KernelPorts } from '@ferretry/kernel/contract';

export interface UpdateHost {
  /** The release this daemon runs. */
  readonly version: string;
  /** The product name (`ferretry`): the cask, the flake and the release repository. */
  readonly product: string;
  /** The client binary name (`fy`) the plan's steps are typed with. */
  readonly clientName: string;
  /** The daemon's binary name, which names it to GitHub (`User-Agent`). */
  readonly daemonName: string;
  /** Whether the daemon is a compiled release binary asking for updates (off for a source run or when the operator says so). */
  readonly checks: boolean;
  /** `process.argv0`: the path the daemon was launched as. */
  readonly argv0: string;
  /** `process.execPath`: the executable itself. */
  readonly execPath: string;
  /** `Bun.main`: `/$bunfs/…` inside a compiled binary, a source file otherwise. */
  readonly main: string;
  readonly homeDirectory: string;
  readonly platform: string;
  readonly workingDirectory: string;
  /** A `PATH` search; `undefined` when nothing is found. */
  which(name: string): string | undefined;
  realpath(path: string): Promise<string>;
  /** A link's target, or `undefined` when the path is not a link. */
  readLink(path: string): Promise<string | undefined>;
  /**
   * `<client> update --yes --to <target> --report <file>`, detached; `report` and `log` are the update's own files.
   * Throws a sentence when it cannot be started.
   */
  launchUpdate(target: string, files: { readonly report: string; readonly log: string }): Promise<void>;
  /** Where the update's own files live (`state/updates/update/report.json`, `state/updates/update.log`). */
  readonly files: { readonly report: string; readonly log: string };
}

/** The host's update seam, if the kernel host carries one. */
export function updateHostOf(kernel: KernelPorts): UpdateHost | undefined {
  const maybe = (kernel as KernelPorts & { readonly updateHost?: UpdateHost }).updateHost;
  return maybe;
}
