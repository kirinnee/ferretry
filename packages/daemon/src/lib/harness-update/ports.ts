import type { Harness, HarnessInstalledVersion, HarnessInstallFacts } from '@ferretry/protocol';
import type { LatestReleaseAnswer } from '../update/ports.ts';

/** The facts `classifyHarnessInstall` reads about the file a runtime launches for one harness. */
export interface HarnessFactsSource {
  facts(harness: Harness, launchedPath: string): Promise<HarnessInstallFacts>;
}

/** Whether a harness binary starts: `--help` with no network and a throwaway home. */
export type HarnessStartupCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * ASKING A HARNESS BINARY ABOUT ITSELF — the one place this daemon runs `claude` or `codex` outside a
 * session.
 *
 * Only when somebody looks (Settings › Agent CLIs, `fy harness status`) or after an update, never at
 * boot and never on a timer: `docs/harness-paths.md`'s "nothing is ever launched to find out" still
 * holds for every report the daemon makes on its own. Each run has a throwaway `HOME` and a proxy that
 * goes nowhere, so neither question can read a login or reach the network.
 */
export interface HarnessProbe {
  version(path: string): Promise<HarnessInstalledVersion>;
  startup(path: string): Promise<HarnessStartupCheck>;
}

/** The newest published version of one harness (npm's `latest`). A failure is a sentence. */
export interface HarnessLatestSource {
  latest(harness: Harness): Promise<LatestReleaseAnswer>;
}
