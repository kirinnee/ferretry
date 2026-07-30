import { CommanderError } from 'commander';
import { createProgram, registerDomain } from '../../bin/fy';
import { BunShell } from '../../src/adapters/system/shell';
import type { ICliIo } from '../../src/adapters/terminal/console-io';
import type { IProgressBar } from '../../src/adapters/terminal/progress';
import type { IPrompt } from '../../src/adapters/terminal/prompt';
import type { ISpinner } from '../../src/adapters/terminal/spinner';

export interface CliResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Runs one CLI journey and reports its transport result — the single seam the SIT suite drives. */
export interface CliDriver {
  run(args: string[], env?: Record<string, string>): Promise<CliResult>;
}

/** Black-box driver: spawns the compiled standalone binary. The true SIT tier — no coverage. */
export class BinaryCliDriver implements CliDriver {
  constructor(private readonly bin: string) {}

  async run(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
    const proc = Bun.spawn([this.bin, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...env },
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

/** In-process driver: same journeys via the composition factory with captured IO — instrumentable full-system coverage. */
export class InProcessCliDriver implements CliDriver {
  async run(args: string[], _env: Record<string, string> = {}): Promise<CliResult> {
    let out = '';
    let err = '';
    const io: ICliIo = {
      success: message => {
        out += `${message}\n`;
      },
      warn: message => {
        out += `${message}\n`;
      },
      error: message => {
        err += `${message}\n`;
      },
      setExitCode: code => {
        process.exitCode = code;
      },
      interactive: () => false,
    };
    // ora renders status on stderr in the shipped binary — mirror that so (out+err) assertions match.
    const spinner: ISpinner = {
      start: text => {
        err += `${text}\n`;
      },
      succeed: text => {
        err += `${text}\n`;
      },
      fail: text => {
        err += `${text}\n`;
      },
    };
    const progress: IProgressBar = { start: () => {}, tick: () => {}, stop: () => {} };
    const prompt: IPrompt = {
      ask: () => Promise.reject(new Error('interactive prompt is unavailable in-process')),
    };

    const program = createProgram();
    registerDomain(program, { io, spinner, progress, prompt, shell: new BunShell(), interactive: false });
    program.configureOutput({
      writeOut: str => {
        out += str;
      },
      writeErr: str => {
        err += str;
      },
    });
    program.exitOverride();

    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    let code = 0;
    try {
      await program.parseAsync(['node', 'cli', ...args]);
    } catch (error) {
      // --version/--help throw a zero-code CommanderError; parse errors throw a non-zero one.
      if (error instanceof CommanderError) {
        if (error.exitCode !== 0) process.exitCode = error.exitCode;
      } else {
        // Mirror the composition root: an unexpected throw reports its message on stderr and exits 1.
        err += `${(error as Error).message}\n`;
        process.exitCode = 1;
      }
    } finally {
      code = typeof process.exitCode === 'number' ? process.exitCode : 0;
      process.exitCode = previousExitCode ?? 0; // a journey's exit code must never leak into the test runner
    }
    return { code, out, err };
  }
}
