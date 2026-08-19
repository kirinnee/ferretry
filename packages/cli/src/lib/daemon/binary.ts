import { isAbsolute } from 'node:path';

/** The daemon executable a lifecycle verb will record and launch. */
export interface InstalledDaemonBinary {
  /** ABSOLUTE, always — see `resolveDaemonBinaryPath`. */
  readonly path: string;
  /** How this host found it, so a report can say why it is that one. */
  readonly source: 'FY_DAEMON_BIN' | 'PATH';
  readonly version?: string | undefined;
}

/** Raised when this host has no daemon executable a service definition could name. */
export class DaemonBinaryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonBinaryUnavailableError';
  }
}

/** What the composition root discovered, before any rule is applied to it. */
export interface DaemonBinaryDiscovery {
  /** Base name of the daemon executable, used in the remedy this error hands a person. */
  readonly daemonName: string;
  /** `FY_DAEMON_BIN` exactly as the environment gave it, or `undefined` when it is unset. */
  readonly pinned: string | undefined;
  /** What a `PATH` search found, or `undefined` when it found nothing. */
  readonly found: string | undefined;
  /**
   * Whether a path is an executable file on this host, asked of the composition root.
   *
   * A FACT the composition root supplies, so this module stays the one place the RULES live. A
   * `PATH` search already implies it, but a pinned path is whatever somebody exported — and a
   * `FY_DAEMON_BIN` left over from a build directory that has since been deleted otherwise surfaces
   * as "the daemon did not become ready", sixty seconds later, blaming the daemon.
   */
  readonly executable: (path: string) => boolean;
}

/**
 * Decide which executable this host's daemon is, and refuse anything a service manager cannot load.
 *
 * **The absolute-path rule is the whole reason this is a function rather than two lines at the call
 * site.** `systemd` refuses a unit whose `ExecStart` is not an absolute path and fails it with
 * 203/EXEC; `launchd` behaves the same way about `ProgramArguments`. A relative `FY_DAEMON_BIN` is
 * therefore not a daemon this host can supervise, and it has to be refused where the path is chosen —
 * not discovered later, by a unit that will not load, at boot, with nobody watching.
 *
 * The refusal names the remedy rather than the rule, because the person who typed a relative path did
 * not do anything unreasonable; they just cannot be supervised that way.
 */
export function resolveDaemonBinaryPath(discovery: DaemonBinaryDiscovery): InstalledDaemonBinary {
  const pinned = discovery.pinned?.trim() ?? '';
  const chosen: InstalledDaemonBinary =
    pinned === '' ? { path: discovery.found ?? '', source: 'PATH' } : { path: pinned, source: 'FY_DAEMON_BIN' };
  if (chosen.path === '') {
    throw new DaemonBinaryUnavailableError(
      `cannot find ${discovery.daemonName} on PATH — install it or point FY_DAEMON_BIN at the executable`,
    );
  }
  if (!isAbsolute(chosen.path)) {
    throw new DaemonBinaryUnavailableError(
      `${discovery.daemonName} must be an absolute path for a user service to launch it, but ` +
        `${chosen.source} is ${chosen.path} — point FY_DAEMON_BIN at the executable's full path`,
    );
  }
  if (!discovery.executable(chosen.path)) {
    throw new DaemonBinaryUnavailableError(
      `${chosen.source} names ${chosen.path}, which is not an executable file — install ` +
        `${discovery.daemonName} or point FY_DAEMON_BIN at one`,
    );
  }
  return chosen;
}
