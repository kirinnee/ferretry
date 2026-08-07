import { basename, dirname, isAbsolute, join, normalize, parse } from 'node:path';

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
   * The directory holding ONE Nix garbage-collection root per retained daemon snapshot.
   *
   * A directory rather than a single link, because a root's lifetime is its SNAPSHOT's lifetime. One
   * root per daemon could protect only the closure of whatever was promoted last, so the snapshot a
   * rollback would select kept its verified executable and lost the loader and shared libraries that
   * executable still needs — `nix-collect-garbage` deleted them, and the rollback the store was built
   * to make safe stopped being runnable. Every retained snapshot gets its own root and keeps it.
   *
   * Deliberately NOT under the state home. The state home is the daemon's, and its layout model
   * refuses any entry it has not declared — a CLI-created directory there is exactly the defect that
   * made the daemon unable to start on a fresh machine. These are also symbolic links, and the
   * daemon's filesystem port refuses symbolic links anywhere inside the state home. They belong to
   * the CLI's own installation, so they live beside the CLI's other installation artifacts.
   */
  readonly nixGcRootDirectory: string;
  /**
   * The one-per-daemon root earlier releases kept, which the per-snapshot roots above replace.
   *
   * Named so it can be RELEASED rather than left holding a store path nothing can account for. It is
   * a sibling of the per-snapshot directory instead of its parent on purpose: a symbolic link cannot
   * also be the directory the new roots live in, so reusing that name would have made an upgraded
   * install unable to create any root at all.
   */
  readonly supersededNixGcRoot: string;
  /**
   * The claims that serialize this daemon's mutating lifecycle commands across separate invocations.
   *
   * **Keyed on every ownership target the verbs may actually use, not on where this CLI keeps its own
   * files.** Under a state-directory key, one shell exporting `XDG_STATE_HOME` and another taking the
   * default took two different claims, contended for nothing, and interleaved the root update and the
   * definition write over the SAME unit file and the same daemon — the precise failure the claims
   * exist to prevent, reachable in spite of them. A systemd host therefore claims its unit file and
   * logical user-manager unit; a launchd host claims its plist and domain/label. Both also claim the
   * daemon-qualified state home because either platform falls back to a direct child when no
   * definition is installed. Finally, the snapshot store stands for itself and the roots derived from
   * the same state directory, so two environments cannot share those artifacts without excluding one
   * another.
   *
   * The array is already in one SEMANTIC acquisition order: manager target, snapshot/root ownership,
   * manager definition, direct daemon. Ordering by role rather than unresolved path spelling keeps
   * alias paths and different locale settings from reversing two physical claims into a deadlock.
   * Category-qualified hidden names prevent two roles from aliasing one claim accidentally. Two
   * daemon names remain independent.
   */
  readonly lifecycleLocks: readonly [string, ...string[]];
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
 *
 * THE PRODUCT NAME IS AN INPUT, not a literal, and that is a fix rather than tidiness. Three
 * derivations of the default state home exist — this one, `resolveFleetLayout` in
 * `../fleet/layout.ts`, and the daemon's own `resolveStateHome` — and this one used to spell
 * `.ferretry` while the fleet one derived `.${product}` from the root manifest. They agree today only
 * because the product happens to be named `ferretry`. `scripts/local/rename.sh --product` rewrites
 * the manifest and a fixed list of static files; it does not rewrite this literal, so the sanctioned
 * rename path would have split one installation in two: `fy fleet` writing `~/.newname` while
 * `fy daemon` and the daemon itself used `~/.ferretry`. That is the same "two writers, no agreement"
 * defect this file's neighbours exist to prevent, and the claim added on top of it would have made
 * the split harder to see rather than easier — the CLI would claim one directory and provision into
 * another. Pinning `FY_HOME` masks it entirely, which is why it survived.
 */
export function resolveDaemonStateHome(homeDirectory: string, stateHome: string | undefined, product: string): string {
  const home = requireDirectory(homeDirectory, 'home directory');
  return stateHome === undefined || stateHome.trim().length === 0
    ? join(home, `.${requireName(product, 'product name')}`)
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
  const stateHome = resolveDaemonStateHome(homeDirectory, input.stateHome, input.product);
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
  const manager = managerForPlatform(input.platform);
  const systemdUnitName = `${daemonName}.service`;
  const systemdUnitFile = join(configHome, 'systemd', 'user', systemdUnitName);
  const launchAgentFile = join(homeDirectory, 'Library', 'LaunchAgents', `${launchdLabel}.plist`);

  return {
    manager,
    daemonName,
    product,
    stateHome,
    logDirectory,
    logFile: join(logDirectory, `${daemonName}.log`),
    snapshotRoot,
    searchPath: input.searchPath,
    systemdUnitName,
    systemdUnitFile,
    launchdLabel,
    launchdDomain,
    launchdServiceTarget: `${launchdDomain}/${launchdLabel}`,
    launchAgentFile,
    nixGcRootDirectory: join(stateDirectory, product, 'nix', 'snapshots', daemonName),
    supersededNixGcRoot: join(stateDirectory, product, 'nix', daemonName),
    lifecycleLocks: lifecycleLocksFor(manager, {
      systemdUnitName,
      systemdUnitFile,
      launchdLabel,
      launchAgentFile,
      snapshotRoot,
      stateHome,
      daemonName,
      userId,
    }),
  };
}

/** The artifacts a lifecycle claim can be keyed on, one per way of owning the daemon. */
interface LifecycleArtifacts {
  readonly systemdUnitName: string;
  readonly systemdUnitFile: string;
  readonly launchdLabel: string;
  readonly launchAgentFile: string;
  readonly snapshotRoot: string;
  readonly stateHome: string;
  readonly daemonName: string;
  readonly userId: number;
}

/**
 * Where the claims live, decided by everything the mutating verbs may own on this host.
 *
 * The shared manager target covers commands sent to one systemd unit or launchd label even when two
 * environments resolve different definition paths. `/tmp` is the one stable cross-environment
 * directory on both supported platforms; the uid keeps users independent, and its sticky bit means
 * another user can at worst occupy the predictable name and make the lifecycle fail closed. The
 * definition claim covers the actual file, the direct claim covers the state home used when that file
 * is absent, and the snapshot claim covers both the store and the root directory derived from the same
 * `XDG_STATE_HOME`.
 *
 * Checking which owner is active before acquiring would merely move the race. The fixed role order
 * below is therefore load-bearing: unresolved aliases can spell the same directories in opposite
 * lexical orders, but they cannot move a physical claim from one semantic position to another.
 */
function lifecycleLocksFor(manager: DaemonManagerKind, artifacts: LifecycleArtifacts): readonly [string, ...string[]] {
  const snapshots = claimBeside(artifacts.snapshotRoot, 'snapshot-store');
  const direct = claimBeside(artifacts.stateHome, `${artifacts.daemonName}.direct`);
  if (manager === 'direct') return [snapshots, direct];
  const definition = claimBeside(
    manager === 'systemd' ? artifacts.systemdUnitFile : artifacts.launchAgentFile,
    'definition',
  );
  const target = join(
    '/tmp',
    `.${String(artifacts.userId)}.${manager}.${
      manager === 'systemd' ? artifacts.systemdUnitName : artifacts.launchdLabel
    }.target.lifecycle.lock`,
  );
  return [target, snapshots, definition, direct];
}

/**
 * A hidden, injective identity beside an artifact.
 *
 * Length-prefix BOTH components before joining them. Merely adding a leading dot collapses `foo` and
 * `.foo`, while punctuation-delimited tuples collapse boundaries such as `(a, b.c)` and `(a.b, c)`.
 * A claim residue must never make either pair look like the same owner and block an unrelated daemon.
 */
function claimBeside(artifact: string, qualifier: string): string {
  const name = basename(artifact);
  return join(dirname(artifact), `.${claimComponent(name)}.${claimComponent(qualifier)}.lifecycle.lock`);
}

/** A filename-safe, exactly decodable component; the length makes punctuation inside it irrelevant. */
function claimComponent(value: string): string {
  return `${String(value.length)}-${value}`;
}

/**
 * The garbage-collection root that holds one snapshot's runtime closure.
 *
 * THE ONLY place a snapshot identity becomes a root path. The controller decides which snapshots need
 * roots and the adapter registers them, and neither may spell this join itself: a root the CLI writes
 * under one rule and reads back under another is a root that protects a closure nobody can find
 * again, which is the same defect as no root at all. Discovering held roots therefore returns the
 * paths it found rather than re-deriving them, so this function is the sole writer of the mapping.
 *
 * The identity is checked as a plain name because it becomes a filename: a snapshot id is
 * `sha256-<64 hex digits>`, and anything carrying a separator would silently retarget the write.
 */
export function daemonSnapshotGcRoot(rootDirectory: string, snapshotId: string): string {
  return join(requireDirectory(rootDirectory, 'nix root directory'), requireName(snapshotId, 'snapshot id'));
}
