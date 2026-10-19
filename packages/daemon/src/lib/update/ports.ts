import type { InstallFacts, LatestRelease } from '@ferretry/protocol';

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

/** The three small documents the update keeps in the state home. */
export type UpdateDocumentName = 'latest' | 'settings' | 'report';

/**
 * The update's documents. A missing, unreadable or non-JSON document reads as `undefined`, which
 * the domain treats as "never written": the worst a damaged file can do is ask GitHub again.
 */
export interface UpdateDocuments {
  read(name: UpdateDocumentName): Promise<unknown>;
  write(name: Exclude<UpdateDocumentName, 'report'>, document: unknown): Promise<void>;
  /** Removes a document; absent is success. */
  remove(name: 'report'): Promise<void>;
}

/** What starting the client's update did. */
export type UpdateLaunchOutcome = { readonly kind: 'started' } | { readonly kind: 'failed'; readonly reason: string };

/**
 * Starting `<client> daemon update` detached, so it outlives the restart it performs. The report it
 * writes when it finishes is the `report` document.
 */
export interface UpdateLauncher {
  launch(target: string): Promise<UpdateLaunchOutcome>;
}

/** How many ferrets are mid-turn right now (`turnState: working`). */
export interface UpdateActivity {
  midTurn(): Promise<number>;
}

/** Wall-clock milliseconds. */
export interface UpdateClock {
  now(): number;
}

/** Runs `tick` every `intervalMs`; answers the disarm. */
export interface UpdateScheduler {
  every(intervalMs: number, tick: () => void): () => void;
}
