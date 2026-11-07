import { join } from 'node:path';

export interface CliResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Runs one CLI journey and reports its transport result: the single seam the SIT suite drives. */
export interface CliDriver {
  run(args: string[], env?: Record<string, string>): Promise<CliResult>;
}

/** The ambient environment minus every `FY_*` variable: a journey must not inherit this machine's daemon or credential. */
export function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith('FY_')) base[name] = value;
  return { ...base, NO_COLOR: '1', ...extra };
}

/**
 * Black-box driver: spawns the entry as a separate process. `command` is the compiled binary when `CLI_BIN` names
 * one, else `bun <package>/bin/<bin>.ts`: the same file the compiled binary is built from.
 */
export class ProcessCliDriver implements CliDriver {
  constructor(private readonly command: readonly string[]) {}

  async run(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
    const proc = Bun.spawn([...this.command, ...args], {
      env: cleanEnvironment(env),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  }
}

export function defaultCommand(binEntry: string, packageDirectory: string): readonly string[] {
  const compiled = process.env.CLI_BIN;
  return compiled !== undefined && compiled !== '' ? [compiled] : ['bun', join(packageDirectory, binEntry)];
}
