import type { HarnessInstalledVersion, InstallFacts, LatestRelease } from './recipes.ts';

/** Where `claude` is, by the one rule (`docs/harness-paths.md`): the config's binary, then its search directories, then the inherited `PATH`. */
export type ClaudeLocation =
  | { readonly outcome: 'located'; readonly path: string; readonly rule: string; readonly declaredBy: string }
  | { readonly outcome: 'override-absent'; readonly path: string; readonly declaredBy: string; readonly reason: string }
  | { readonly outcome: 'absent'; readonly searched: readonly string[] };

export interface LocationSource {
  locate(): Promise<ClaudeLocation>;
}

/** The facts `classifyInstall` reads about the file a runtime launches. */
export interface FactsSource {
  facts(launchedPath: string): Promise<InstallFacts>;
}

/** Whether the binary starts: `--help` with no network and a throwaway home. */
export type StartupCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * ASKING THE BINARY ABOUT ITSELF — the one place this plugin runs `claude` outside a ferret. Only when somebody
 * looks (the settings panel, `fy harness claude-code status`) or after an update, never at boot and never on a
 * timer. Each run has an isolated home and a proxy that goes nowhere.
 */
export interface Probe {
  version(path: string): Promise<HarnessInstalledVersion>;
  startup(path: string): Promise<StartupCheck>;
}

export type LatestAnswer =
  | { readonly kind: 'ok'; readonly release: LatestRelease }
  | { readonly kind: 'failed'; readonly reason: string };

/** The newest published version (npm's `latest`). A failure is a sentence. */
export interface LatestSource {
  latest(): Promise<LatestAnswer>;
}

export interface RunRequest {
  readonly program: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** How one package-manager run ended. `tail` is the last lines it printed, kept only to classify and quote a failure. */
export type RunResult =
  | { readonly kind: 'exited'; readonly code: number; readonly tail: readonly string[] }
  | { readonly kind: 'timed-out'; readonly tail: readonly string[] }
  | { readonly kind: 'not-started'; readonly reason: string };

/** Running one program with no stdin, so nothing it asks can wait for an answer. */
export type RunPort = (request: RunRequest) => Promise<RunResult>;

export interface UpdateClock {
  /** Milliseconds since the epoch. */
  now(): number;
}
