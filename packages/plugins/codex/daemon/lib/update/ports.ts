import type { HarnessInstalledVersion } from './types.ts';
import type { InstallFacts } from './install-method.ts';

/** The newest published Codex, or the sentence why it could not be learned. A failure is never a throw. */
export type LatestReleaseAnswer =
  | { readonly kind: 'ok'; readonly release: { readonly version: string; readonly url: string } }
  | { readonly kind: 'failed'; readonly reason: string };

/** The newest published version of Codex (npm's `latest`). */
export interface HarnessLatestSource {
  latest(): Promise<LatestReleaseAnswer>;
}

/** The facts `classifyCodexInstall` reads about the file a runtime launches. */
export interface HarnessFactsSource {
  facts(launchedPath: string): Promise<InstallFacts>;
}

/** Whether Codex starts: `--help` with no network and a throwaway home. */
export type HarnessStartupCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * ASKING THE CODEX BINARY ABOUT ITSELF — the one place this daemon runs `codex` outside a session.
 *
 * Only when somebody looks (Settings, `fy harness codex status`) or after an update, never at boot and never on a
 * timer. Each run has a throwaway `HOME` and a proxy that goes nowhere, so neither question can read a login or reach
 * the network.
 */
export interface HarnessProbe {
  version(path: string): Promise<HarnessInstalledVersion>;
  startup(path: string): Promise<HarnessStartupCheck>;
}

/** What this machine says about where a program is: lookups and stats only, nothing is launched to find out. */
export interface ExecutableResolverPort {
  /** The absolute executable a bare NAME resolves to on this host's `PATH`, or `undefined`. */
  resolve(name: string): Promise<string | undefined>;
  /** Whether this host can run the program at this absolute path right now. */
  runnable(path: string): Promise<boolean>;
}

/** One package-manager run: an absolute executable and its arguments, never a shell string. */
export interface PackageInstallRun {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/**
 * How one run ended. `tail` is the last few lines the manager printed, kept only so a failure can be classified and
 * quoted; it is never stored.
 */
export type PackageInstallResult =
  | { readonly kind: 'exited'; readonly code: number; readonly tail: readonly string[] }
  | { readonly kind: 'timed-out'; readonly tail: readonly string[] }
  | { readonly kind: 'not-started'; readonly reason: string };

/** Running one package manager with no stdin, so nothing it asks can wait for an answer. */
export type PackageInstallPort = (run: PackageInstallRun) => Promise<PackageInstallResult>;

/** Where Codex is on this host, and WHY it is that file. */
export type HarnessLocation =
  | {
      readonly outcome: 'located';
      readonly path: string;
      readonly rule: 'explicit override' | 'extra search path' | 'inherited environment';
      /** The key, directory list or `PATH` the answer came out of. */
      readonly declaredBy: string;
    }
  | { readonly outcome: 'override-absent'; readonly path: string; readonly declaredBy: string; readonly reason: string }
  | { readonly outcome: 'absent'; readonly searched: readonly string[] };
