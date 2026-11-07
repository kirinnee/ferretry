import type { InstallFacts, LatestRelease, UpdateCheck, UpdateReport } from '../../contract/index.ts';

/**
 * The facts `classifyInstallMethod` reads about the running daemon's own executable.
 *
 * Asked once, lazily: reading them spawns `nix profile list` and a package manager's ownership query,
 * which a boot must never wait on.
 */
export interface InstallFactsSource {
  facts(): Promise<InstallFacts>;
}

/** One answer from the release source; a failure is a sentence, never a throw. */
export type LatestReleaseAnswer =
  | { readonly kind: 'ok'; readonly release: LatestRelease }
  | { readonly kind: 'failed'; readonly reason: string };

/** Where the latest published release is read from. */
export interface LatestReleaseSource {
  latest(): Promise<LatestReleaseAnswer>;
}

/**
 * The update's two documents in the state home. A missing, unreadable or damaged document reads as `undefined`, which
 * the domain treats as "never written": the worst a damaged file can do is ask GitHub again.
 */
export interface UpdateDocuments {
  readLatest(): Promise<UpdateCheck | undefined>;
  writeLatest(check: UpdateCheck): Promise<void>;
  readReport(): Promise<UpdateReport | undefined>;
  /** Removes the report; absent is success. */
  removeReport(): Promise<void>;
}

/** Whether installing unasked is on: `config/updates.yaml`, live. */
export interface AutoInstallSetting {
  current(): boolean;
}

/** What starting the update did. */
export type UpdateLaunchOutcome = { readonly kind: 'started' } | { readonly kind: 'failed'; readonly reason: string };

/**
 * Starting the update detached, so it outlives the restart it performs. The report it writes when it finishes is the
 * `report` document.
 */
export interface UpdateLauncher {
  launch(target: string): Promise<UpdateLaunchOutcome>;
}

/** How many ferrets are mid-turn right now (state `working`). */
export interface UpdateActivity {
  midTurn(): Promise<number>;
}

/** Wall-clock milliseconds. */
export interface UpdateClock {
  now(): number;
}
