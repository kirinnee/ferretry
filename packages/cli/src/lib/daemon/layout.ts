import { isAbsolute, join, normalize, parse } from 'node:path';

/** The service managers this CLI knows how to drive, plus the no-manager fallback. */
export type DaemonManagerKind = 'systemd' | 'launchd' | 'direct';

/**
 * Everything the daemon-control commands need from the outside world, captured once by the
 * composition root.
 *
 * Nothing here is read ambiently. kteam's service class defaulted `home`, `platform` and its
 * command runner to the live ones whenever a caller omitted them, then bolted on an env-sniffing
 * "hermetic" guard because a test that passed positional arguments had already overwritten the
 * production unit file and crash-looped the real daemon. A required input cannot be defaulted into
 * the live installation, so the guard has nothing left to protect and is gone.
 */
export interface DaemonEnvironmentInput {
  /** The host platform, as the runtime reports it. */
  readonly platform: string;
  /** The invoking user's home directory. */
  readonly homeDirectory: string;
  /** `FY_HOME` when the operator pinned a state home; the default is derived from the home directory. */
  readonly stateHome?: string | undefined;
  /** `XDG_CONFIG_HOME` when set — systemd user units live under it. */
  readonly configHome?: string | undefined;
  /** The invoking user's numeric id, which names the launchd domain. */
  readonly userId: number;
  /** The daemon executable this CLI supervises. */
  readonly daemonBinary: string;
  /** Base name of that executable: it names the systemd unit and the launchd label. */
  readonly daemonName: string;
  /** The product name, which prefixes the reverse-DNS launchd label. */
  readonly product: string;
  /** `PATH` to hand the supervised daemon — a service manager starts it with almost none. */
  readonly searchPath: string;
}

/** Every path, label and domain target the daemon-control commands address. */
export interface DaemonLayout {
  /** Which manager owns the daemon on this host, before asking whether a unit is installed. */
  readonly manager: DaemonManagerKind;
  /** Base name of the daemon executable — what a human calls the thing these commands manage. */
  readonly daemonName: string;
  readonly stateHome: string;
  readonly logDirectory: string;
  readonly logFile: string;
  readonly daemonBinary: string;
  readonly searchPath: string;
  /** `fyd.service` — the unit name every `systemctl --user` verb takes. */
  readonly systemdUnitName: string;
  readonly systemdUnitFile: string;
  /** `com.ferretry.fyd` — the launchd job label, also the plist file's base name. */
  readonly launchdLabel: string;
  /** `gui/501` — the domain a launchd job is bootstrapped into. */
  readonly launchdDomain: string;
  /** `gui/501/com.ferretry.fyd` — the service target every other launchd verb takes. */
  readonly launchdServiceTarget: string;
  readonly launchAgentFile: string;
}

export class InvalidDaemonEnvironmentError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`invalid daemon environment: ${field} ${reason}`);
    this.name = 'InvalidDaemonEnvironmentError';
  }
}

/** A directory we will write into must be a real absolute path, and never the filesystem root. */
function requireDirectory(value: string, field: string): string {
  if (value.trim().length === 0) throw new InvalidDaemonEnvironmentError(field, 'must not be empty');
  if (!isAbsolute(value)) throw new InvalidDaemonEnvironmentError(field, 'must be an absolute path');
  const resolved = normalize(value);
  if (resolved === parse(resolved).root)
    throw new InvalidDaemonEnvironmentError(field, 'must not be a filesystem root');
  return resolved;
}

/**
 * Names that become a filename, a systemd unit or a launchd label. A path separator or whitespace
 * here would silently retarget the write — the unit file is the one artifact whose path must never
 * be attacker- or typo-steerable.
 */
function requireName(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new InvalidDaemonEnvironmentError(field, 'must be a plain name of letters, digits, dot, dash or underscore');
  }
  return value;
}

function requireUserId(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidDaemonEnvironmentError(field, 'must be a non-negative integer');
  }
  return value;
}

/** The manager a platform implies. Anything else gets the direct-spawn fallback, never a guess. */
export function managerForPlatform(platform: string): DaemonManagerKind {
  if (platform === 'linux') return 'systemd';
  if (platform === 'darwin') return 'launchd';
  return 'direct';
}

/**
 * Derives every daemon-control path from captured inputs.
 *
 * The state home is resolved the same way the daemon resolves its own, because `FY_HOME` is the
 * published contract between the two — not because the CLI reads anything the daemon owns inside it.
 * The only file under it this CLI touches is the log it configured the service manager to write.
 */
export function resolveDaemonLayout(input: DaemonEnvironmentInput): DaemonLayout {
  const homeDirectory = requireDirectory(input.homeDirectory, 'home directory');
  const stateHome =
    input.stateHome === undefined || input.stateHome.trim().length === 0
      ? join(homeDirectory, '.ferretry')
      : requireDirectory(input.stateHome, 'FY_HOME');
  const configHome =
    input.configHome === undefined || input.configHome.trim().length === 0
      ? join(homeDirectory, '.config')
      : requireDirectory(input.configHome, 'XDG_CONFIG_HOME');
  const daemonName = requireName(input.daemonName, 'daemon name');
  const product = requireName(input.product, 'product name');
  const daemonBinary = requireDirectory(input.daemonBinary, 'daemon binary');
  const userId = requireUserId(input.userId, 'user id');

  const logDirectory = join(stateHome, 'logs');
  const launchdLabel = `com.${product}.${daemonName}`;
  const launchdDomain = `gui/${String(userId)}`;

  return {
    manager: managerForPlatform(input.platform),
    daemonName,
    stateHome,
    logDirectory,
    logFile: join(logDirectory, `${daemonName}.log`),
    daemonBinary,
    searchPath: input.searchPath,
    systemdUnitName: `${daemonName}.service`,
    systemdUnitFile: join(configHome, 'systemd', 'user', `${daemonName}.service`),
    launchdLabel,
    launchdDomain,
    launchdServiceTarget: `${launchdDomain}/${launchdLabel}`,
    launchAgentFile: join(homeDirectory, 'Library', 'LaunchAgents', `${launchdLabel}.plist`),
  };
}
