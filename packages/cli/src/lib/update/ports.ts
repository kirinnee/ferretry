import type { DaemonUpdateView, HealthView, InstallFacts, LatestRelease } from '@ferretry/protocol';
import type { InstalledDaemonBinary } from '../daemon/binary.ts';
import type { CommandOutcome } from '../daemon/ports.ts';
import type { UpdateObserver } from './activity.ts';

/**
 * The facts `classifyInstallMethod` reads, gathered from this host for one daemon executable.
 *
 * Total: a fact that cannot be read (no `nix`, no `dpkg`) is simply absent, never a failure, because
 * the only thing riding on it is which sentence a person is shown.
 */
export interface IInstallFactsPort {
  facts(daemon: InstalledDaemonBinary): Promise<InstallFacts>;
}

/** The latest published release, or why it could not be learned. */
export type LatestReleaseAnswer =
  | { readonly kind: 'found'; readonly release: LatestRelease }
  | { readonly kind: 'failed'; readonly reason: string };

/** Asking the release source what the latest version is. Never throws. */
export interface ILatestReleasePort {
  latest(): Promise<LatestReleaseAnswer>;
  /** The newest stable tag, which a source-built install gets before the release is published. */
  newestTag(): Promise<LatestReleaseAnswer>;
}

/**
 * The package managers a self-update drives, one method per command it ever runs.
 *
 * A method per command rather than "run this argv" so the set of things an update can do to a host
 * is written down here and nowhere else — a port that took any argv would let the next change run
 * anything without this interface saying so.
 */
export interface IPackageManagerPort {
  /** Bring the tap clone up to date, tapping it first when it is missing. */
  brewRefresh(tap: string, url: string, observer?: UpdateObserver): Promise<CommandOutcome>;
  brewUpgrade(cask: string, observer?: UpdateObserver): Promise<CommandOutcome>;
  nixProfileUpgrade(element: string, observer?: UpdateObserver): Promise<CommandOutcome>;
  nixProfileRollback(): Promise<CommandOutcome>;
  nixProfileInstall(flake: string, observer?: UpdateObserver): Promise<CommandOutcome>;
}

/** A release unpacked beside the current binaries, verified, and not yet in place. */
export interface StagedRelease {
  readonly directory: string;
  /** The binary names that were staged as `<name>.new`. */
  readonly names: readonly string[];
}

/** Why a standalone release was not staged — said to a person as it is. */
export interface StandaloneRefusal {
  readonly refused: string;
}

/**
 * Replacing a standalone install's binaries with a verified release.
 *
 * `stage` downloads, verifies the signature and the checksum, and unpacks next to the current
 * binaries; nothing a running daemon uses changes until `swap`. `swap` keeps every replaced binary as
 * `<name>.previous`, which is what `rollback` puts back.
 */
export interface IStandaloneReleasePort {
  stage(version: string, directory: string, observer?: UpdateObserver): Promise<StagedRelease | StandaloneRefusal>;
  swap(staged: StagedRelease): Promise<void>;
  rollback(directory: string): Promise<void>;
}

/**
 * The daemon lifecycle, as an update needs it.
 *
 * Every call builds its answer FRESH: an update changes the installed executable under the same path
 * (or, for a profile switch, at a new one), so a lifecycle that remembered which daemon it resolved
 * before the upgrade would restart into the old version's memory of itself.
 */
export interface IUpdateLifecyclePort {
  /** The installed daemon, resolved now. Throws, with the remedy, when there is none. */
  installed(): InstalledDaemonBinary;
  /** What `<path> --version` says now, or `undefined` when it does not answer. */
  versionOf(path: string): string | undefined;
  /** Whether `path` is an executable file. */
  executable(path: string): boolean;
  /** `fy daemon restart`. */
  restart(options?: { readonly ferretsKeepRunning?: number }): Promise<void>;
  /** `fy daemon install`, for this exact executable. */
  installAt(path: string): Promise<void>;
  /**
   * Why the installed service definition has to be rewritten for the daemon to run as intended — a
   * launchd job with no `ProcessType` is throttled by macOS — or `undefined` when it does not.
   */
  staleDefinition(): Promise<string | undefined>;
  /** The local daemon's health, or `undefined` when it does not answer. */
  probe(): Promise<HealthView | undefined>;
}

/** The daemon's own account of its update state; `undefined` from a daemon too old to have one. */
export interface IDaemonUpdateViewPort {
  view(): Promise<DaemonUpdateView | undefined>;
}
