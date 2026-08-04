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
  /** `XDG_STATE_HOME` when set — CLI-owned installation artifacts live under it. */
  readonly stateDirectory?: string | undefined;
  /** The invoking user's numeric id, which names the launchd domain. */
  readonly userId: number;
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
  /** Product namespace carried in every snapshot manifest. */
  readonly product: string;
  readonly stateHome: string;
  readonly logDirectory: string;
  readonly logFile: string;
  /** Daemon-keyed root of the CLI-owned immutable snapshot store. */
  readonly snapshotRoot: string;
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
  /**
   * Where the Nix garbage-collection root for the daemon executable is kept.
   *
   * Deliberately NOT under the state home. The state home is the daemon's, and its layout model
   * refuses any entry it has not declared — a CLI-created directory there is exactly the defect that
   * made the daemon unable to start on a fresh machine. It is also a symbolic link, and the daemon's
   * filesystem port refuses symbolic links anywhere inside the state home. It belongs to the CLI's
   * own installation, so it lives beside the CLI's other installation artifacts.
   */
  readonly nixGcRoot: string;
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
 * Resolve the state home exactly as the daemon does from `FY_HOME` and the invoking user's home.
 *
 * This is exported for the local credential reader too: service management and token discovery
 * must address the same installation, especially when an operator pins `FY_HOME`.
 */
export function resolveDaemonStateHome(homeDirectory: string, stateHome: string | undefined): string {
  const home = requireDirectory(homeDirectory, 'home directory');
  return stateHome === undefined || stateHome.trim().length === 0
    ? join(home, '.ferretry')
    : requireDirectory(stateHome, 'FY_HOME');
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
  const stateHome = resolveDaemonStateHome(homeDirectory, input.stateHome);
  const configHome =
    input.configHome === undefined || input.configHome.trim().length === 0
      ? join(homeDirectory, '.config')
      : requireDirectory(input.configHome, 'XDG_CONFIG_HOME');
  const stateDirectory =
    input.stateDirectory === undefined || input.stateDirectory.trim().length === 0
      ? join(homeDirectory, '.local', 'state')
      : requireDirectory(input.stateDirectory, 'XDG_STATE_HOME');
  const daemonName = requireName(input.daemonName, 'daemon name');
  const product = requireName(input.product, 'product name');
  const userId = requireUserId(input.userId, 'user id');

  const logDirectory = join(stateHome, 'logs');
  const launchdLabel = `com.${product}.${daemonName}`;
  const launchdDomain = `gui/${String(userId)}`;
  const snapshotRoot = join(stateDirectory, product, 'daemon-snapshots', daemonName);

  return {
    manager: managerForPlatform(input.platform),
    daemonName,
    product,
    stateHome,
    logDirectory,
    logFile: join(logDirectory, `${daemonName}.log`),
    snapshotRoot,
    searchPath: input.searchPath,
    systemdUnitName: `${daemonName}.service`,
    systemdUnitFile: join(configHome, 'systemd', 'user', `${daemonName}.service`),
    launchdLabel,
    launchdDomain,
    launchdServiceTarget: `${launchdDomain}/${launchdLabel}`,
    launchAgentFile: join(homeDirectory, 'Library', 'LaunchAgents', `${launchdLabel}.plist`),
    nixGcRoot: join(stateDirectory, product, 'nix', daemonName),
  };
}
