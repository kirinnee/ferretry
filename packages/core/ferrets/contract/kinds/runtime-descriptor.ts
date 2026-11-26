import type { HarnessInstall, HarnessMissing } from './harness.ts';

/** Public discovery only. Credentials stay behind the login/Vault launch path. */
export interface HarnessRuntimeModels {
  readonly choices: readonly {
    readonly id: string;
    readonly label: string;
    readonly context?: number;
    readonly reasoning?: boolean;
    /** Native variant ids actually reported by this harness; absent means no effort control. */
    readonly variants?: readonly string[];
  }[];
  /** Valid only when it exactly names a choice. No implicit first-choice default. */
  readonly default?: string;
}

/** An opt-in to Runtimes' generic path. It grants no import, settings, MCP, asset or history support. */
export interface HarnessRuntimeDescriptor {
  readonly binary: string;
  /** Environment variable names and paths relative to a private runtime home; never credential values. */
  readonly homeEnv: Readonly<Record<string, string>>;
  readonly detect: () => Promise<HarnessInstall | HarnessMissing>;
  /** Arguments to the named package manager. Missing managers are not offered. */
  readonly install?: Readonly<Partial<Record<'npm' | 'brew', readonly string[]>>>;
  readonly models: (login: string) => Promise<HarnessRuntimeModels>;
}
