import type { InputEcho } from '@ferretry/protocol';

/** Reads whether a TTY echoes what is typed. `unknown` when it cannot be read; the service treats that as `on`. */
export interface TerminalModes {
  echo(ttyPath: string): Promise<InputEcho>;
}

/** Runs one program with argv (no shell) and answers its stdout, or `undefined` when it failed or is missing. */
export type ProgramRunner = (argv: readonly string[]) => Promise<string | undefined>;

const TTY_PATH = /^\/dev\/[A-Za-z0-9._/-]+$/u;

/** `stty` reads another terminal's modes with `-F` on Linux and `-f` on macOS. */
export function sttyArguments(platform: string, ttyPath: string): readonly string[] | undefined {
  if (!TTY_PATH.test(ttyPath)) return undefined;
  if (platform === 'linux') return ['stty', '-F', ttyPath, '-a'];
  if (platform === 'darwin') return ['stty', '-f', ttyPath, '-a'];
  return undefined;
}

/** `echo` / `-echo` from `stty -a`; every other word (`echoe`, `echok`, …) is a different flag. */
export function parseEcho(output: string): InputEcho {
  const words = output.split(/[\s;]+/u);
  if (words.includes('-echo')) return 'off';
  if (words.includes('echo')) return 'on';
  return 'unknown';
}

export class SttyTerminalModes implements TerminalModes {
  constructor(
    private readonly platform: string,
    private readonly run: ProgramRunner,
  ) {}

  async echo(ttyPath: string): Promise<InputEcho> {
    const argv = sttyArguments(this.platform, ttyPath);
    if (argv === undefined) return 'unknown';
    const output = await this.run(argv);
    return output === undefined ? 'unknown' : parseEcho(output);
  }
}
