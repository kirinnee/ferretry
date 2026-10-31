import type { InputEcho } from '@ferretry/protocol';

/** Reads whether a TTY echoes what is typed. `unknown` when it cannot be read; the service treats that as `on`. */
export interface TerminalModes {
  echo(ttyPath: string): Promise<InputEcho>;
  /** Whether the TTY is in canonical (line) mode; `undefined` when it cannot be read. */
  canonical?(ttyPath: string): Promise<boolean | undefined>;
  /** Whether the program `pid` runs setuid root: effective uid 0 while its real uid is not. */
  trusted?(pid: number): Promise<boolean>;
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

/** `icanon` / `-icanon` from `stty -a`, or `undefined` when neither is there. */
export function parseCanonical(output: string): boolean | undefined {
  const words = output.split(/[\s;]+/u);
  if (words.includes('-icanon')) return false;
  if (words.includes('icanon')) return true;
  return undefined;
}

/**
 * `ps -o uid=,ruid=`: the effective and the real uid. A program runs setuid root when the first is 0 and the second is
 * not: the kernel granted it root from a root-owned setuid file, which a script or a binary the ferret wrote cannot
 * get. `undefined` when the line is not two numbers.
 */
export function parseUids(output: string): { readonly effective: number; readonly real: number } | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(output);
  return match === null ? undefined : { effective: Number(match[1]), real: Number(match[2]) };
}

export class SttyTerminalModes implements TerminalModes {
  constructor(
    private readonly platform: string,
    private readonly run: ProgramRunner,
  ) {}

  async canonical(ttyPath: string): Promise<boolean | undefined> {
    const argv = sttyArguments(this.platform, ttyPath);
    if (argv === undefined) return undefined;
    const output = await this.run(argv);
    return output === undefined ? undefined : parseCanonical(output);
  }

  /** The program runs setuid root (effective uid 0, real uid not); anything unreadable is not trusted. */
  async trusted(pid: number): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    const output = await this.run(['ps', '-o', 'uid=,ruid=', '-p', String(pid)]).catch(() => undefined);
    const uids = output === undefined ? undefined : parseUids(output);
    return uids !== undefined && uids.effective === 0 && uids.real !== 0;
  }

  async echo(ttyPath: string): Promise<InputEcho> {
    const argv = sttyArguments(this.platform, ttyPath);
    if (argv === undefined) return 'unknown';
    const output = await this.run(argv);
    return output === undefined ? 'unknown' : parseEcho(output);
  }
}
