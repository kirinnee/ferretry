// Local probe contract types (adapted from diene's @cyanprint/contracts — no cyanprint runner
// in this repo, so the shapes live here and any harness providing a ProbeRepo can execute them).

export interface ProbeExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProbeRepo {
  exec(command: string, options?: { timeoutMs?: number }): Promise<ProbeExecResult>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  patch(path: string, edit: { find: string; replace: string }): Promise<void>;
  glob(pattern: string): Promise<string[]>;
}

export interface ProbeSandboxConfig {
  readonly snapshot: 'git';
  readonly preserve?: string[];
}

export interface ProbeSetupConfig {
  readonly post?: string[];
}

export interface Probe {
  readonly name: string;
  readonly description: string;
  readonly kind: 'baseline' | 'mutation';
  readonly expectedImpact?: string[];
  run(repo: ProbeRepo): Promise<void>;
}

export interface ProbeDefinition {
  readonly contractVersion: 1;
  readonly sandbox?: ProbeSandboxConfig;
  readonly setup?: ProbeSetupConfig;
  readonly probes: Probe[];
}
