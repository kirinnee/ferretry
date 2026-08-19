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
  /** Product namespace this installation's CLI-owned directories are keyed by. */
  readonly product: string;
  /**
   * The invoking user's home directory, as this invocation resolved it.
   *
   * Carried on the layout rather than re-read because one verb has to REFUSE against it: a reset
   * derives the trees it destroys from this layout, and an `FY_HOME` pointing at the home directory
   * itself would make that verb delete everything the user owns. A guard cannot compare against a
   * value it was never given, and re-reading the home here would be a second derivation of the fact
   * the state home was already resolved from.
   */
  readonly homeDirectory: string;
  readonly stateHome: string;
  /**
   * The one tree of CLI-owned installation artifacts, keyed by `XDG_STATE_HOME` and the product.
   *
   * **Every other state-directory path below is derived from this one**, and that is the fix rather
   * than tidiness: three of them were spelled independently from `stateDirectory` and `product`, so a
   * fourth reader — a verb that removes them — would have been a fourth spelling with nothing making
   * the four agree. This is also the SECOND of the two roots a Ferretry installation occupies, and the
   * one nobody looks in: an owner who cleared only the state home kept running an ancient daemon,
   * because the pinned executable lived here.
   */
  readonly stateArtifactRoot: string;
  readonly logDirectory: string;
  readonly logFile: string;
  /**
   * The daemon snapshot store an earlier release kept, named ONLY so it can be removed.
   *
   * Nothing writes here any more. Ferretry runs the daemon executable this host has installed, at the
   * absolute path a unit file records, and every property the store added on top of that — content
   * addressing, verification, immutability, an atomic pointer, rollback — is one `/nix/store` already
   * provides for a Nix installation and one a package manager owns for every other. An upgraded host
   * still has the directory, and roughly 100MB of copied executables inside it, so a lifecycle verb
   * that has launched the installed daemon retires it rather than leaving it there forever.
   */
  readonly legacySnapshotRoot: string;
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
   * The ONE Nix garbage-collection root this daemon holds: the closure of the executable it runs.
   *
   * There is exactly one, because there is exactly one thing to protect — the absolute path the unit
   * file records. A `nix shell` store path is a root only while that shell is open, so a later
   * `nix-collect-garbage` can delete the very executable an installed user service names, and the
   * service then fails to launch at the next login with nobody present to read the error. That is a
   * different failure from a person's own shell going stale, and this link is what prevents it.
   *
   * Deliberately NOT under the state home. The state home is the daemon's, and its layout model
   * refuses any entry it has not declared — a CLI-created directory there is exactly the defect that
   * made the daemon unable to start on a fresh machine. This is also a symbolic link, and the
   * daemon's filesystem port refuses symbolic links anywhere inside the state home. It belongs to
   * the CLI's own installation, so it lives beside the CLI's other installation artifacts.
   */
  readonly nixGcRoot: string;
  /**
   * The directory of per-snapshot roots the retired snapshot store kept, named ONLY to release them.
   *
   * One root per retained snapshot existed because a snapshot's copied executable still loaded its
   * ELF interpreter and shared libraries from the store output it was copied FROM, so each rollback
   * candidate needed that output held. With no snapshots there are no rollback candidates and no
   * copies, and every one of those roots holds a closure nothing on this host can run.
   */
  readonly legacySnapshotGcRootDirectory: string;
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
   * definition is installed. Finally, one claim stands for every CLI-owned artifact derived from the
   * same state directory — the garbage-collection root and the retired snapshot store — so two
   * environments cannot share those artifacts without excluding one another.
   *
   * The array is already in one SEMANTIC acquisition order: manager target, state-artifact ownership,
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
  const stateArtifactRoot = join(stateDirectory, product);
  const legacySnapshotRoot = join(stateArtifactRoot, 'daemon-snapshots', daemonName);
  const manager = managerForPlatform(input.platform);
  const systemdUnitName = `${daemonName}.service`;
  const systemdUnitFile = join(configHome, 'systemd', 'user', systemdUnitName);
  const launchAgentFile = join(homeDirectory, 'Library', 'LaunchAgents', `${launchdLabel}.plist`);

  return {
    manager,
    daemonName,
    product,
    homeDirectory,
    stateHome,
    stateArtifactRoot,
    logDirectory,
    logFile: join(logDirectory, `${daemonName}.log`),
    legacySnapshotRoot,
    searchPath: input.searchPath,
    systemdUnitName,
    systemdUnitFile,
    launchdLabel,
    launchdDomain,
    launchdServiceTarget: `${launchdDomain}/${launchdLabel}`,
    launchAgentFile,
    nixGcRoot: join(stateArtifactRoot, 'nix', daemonName),
    legacySnapshotGcRootDirectory: join(stateArtifactRoot, 'nix', 'snapshots', daemonName),
    lifecycleLocks: lifecycleLocksFor(manager, {
      systemdUnitName,
      systemdUnitFile,
      launchdLabel,
      launchAgentFile,
      legacySnapshotRoot,
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
  readonly legacySnapshotRoot: string;
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
 * is absent, and the artifact claim covers everything derived from the same `XDG_STATE_HOME`: the Nix
 * garbage-collection root, and the retired snapshot store a verb removes.
 *
 * **The artifact claim keeps the path and qualifier the snapshot store gave it**, which is deliberate
 * rather than leftover. During an upgrade an older `fy` is still on this host and still takes that
 * exact claim, and the older one is precisely the invocation that might be writing into the store this
 * one is about to delete. Renaming the claim to match the new vocabulary would make the two versions
 * contend for nothing at the one moment exclusion actually matters.
 *
 * Checking which owner is active before acquiring would merely move the race. The fixed role order
 * below is therefore load-bearing: unresolved aliases can spell the same directories in opposite
 * lexical orders, but they cannot move a physical claim from one semantic position to another.
 */
function lifecycleLocksFor(manager: DaemonManagerKind, artifacts: LifecycleArtifacts): readonly [string, ...string[]] {
  const snapshots = claimBeside(artifacts.legacySnapshotRoot, 'snapshot-store');
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
