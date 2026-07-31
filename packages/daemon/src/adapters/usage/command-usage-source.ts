import type { AccountUsage } from '@ferretry/protocol';
import { parseUsageAccounts, type UsageSourcePort } from '../../lib/usage/index.ts';

export interface CommandOutput {
  readonly code: number;
  readonly stdout: string;
}

/** The narrow process seam this source needs. Implemented by {@link BunCommandRunner}. */
export interface CommandRunnerPort {
  run(command: readonly [string, ...string[]], signal?: AbortSignal): Promise<CommandOutput>;
}

export interface BunCommandRunnerOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Runs a command with output captured, inheriting nothing and never touching a terminal. */
export class BunCommandRunner implements CommandRunnerPort {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(
    private readonly environment: Readonly<Record<string, string | undefined>>,
    options: BunCommandRunnerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async run(command: readonly [string, ...string[]], signal?: AbortSignal): Promise<CommandOutput> {
    const child = Bun.spawn([...command], {
      env: this.environment,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: this.timeoutMs,
      maxBuffer: this.maxOutputBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { code, stdout };
  }
}

/**
 * Fallback source for hosts where the collector endpoint is not listening: it runs a configured
 * command and reads the same JSON payload from its standard output.
 *
 * The command is injected rather than hardcoded — the source spelled one tool's name and flags into
 * the daemon, which made the daemon's fallback impossible to change without editing the daemon.
 */
export class CommandUsageSource implements UsageSourcePort {
  constructor(
    private readonly runner: CommandRunnerPort,
    private readonly command: readonly [string, ...string[]],
  ) {}

  async read(signal?: AbortSignal): Promise<readonly AccountUsage[] | undefined> {
    try {
      const { code, stdout } = await this.runner.run(this.command, signal);
      if (code !== 0) return undefined;
      return parseUsageAccounts(JSON.parse(stdout));
    } catch {
      return undefined;
    }
  }
}
