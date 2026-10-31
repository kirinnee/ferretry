import type { InputEcho } from '@ferretry/protocol';

/** Reads whether a TTY echoes what is typed. `unknown` when it cannot be read; the service treats that as `on`. */
export interface TerminalModes {
  echo(ttyPath: string): Promise<InputEcho>;
  /** Whether the TTY is in canonical (line) mode; `undefined` when it cannot be read. */
  canonical?(ttyPath: string): Promise<boolean | undefined>;
  /** Whether the program `pid` runs from an executable root owns and only root can write. */
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

/** Where a running program's executable is, and who may change it. */
export interface ExecutableLookup {
  path(pid: number): Promise<string | undefined>;
  owner(path: string): Promise<{ readonly uid: number; readonly mode: number } | undefined>;
}

export class SttyTerminalModes implements TerminalModes {
  constructor(
    private readonly platform: string,
    private readonly run: ProgramRunner,
    private readonly executables?: ExecutableLookup,
  ) {}

  async canonical(ttyPath: string): Promise<boolean | undefined> {
    const argv = sttyArguments(this.platform, ttyPath);
    if (argv === undefined) return undefined;
    const output = await this.run(argv);
    return output === undefined ? undefined : parseCanonical(output);
  }

  /** Root owns the executable and neither its group nor others may write it; anything unreadable is not trusted. */
  async trusted(pid: number): Promise<boolean> {
    if (this.executables === undefined || !Number.isSafeInteger(pid) || pid <= 0) return false;
    const path = await this.executables.path(pid).catch(() => undefined);
    if (path === undefined || !path.startsWith('/')) return false;
    const owner = await this.executables.owner(path).catch(() => undefined);
    return owner !== undefined && owner.uid === 0 && (owner.mode & 0o022) === 0;
  }

  async echo(ttyPath: string): Promise<InputEcho> {
    const argv = sttyArguments(this.platform, ttyPath);
    if (argv === undefined) return 'unknown';
    const output = await this.run(argv);
    return output === undefined ? 'unknown' : parseEcho(output);
  }
}
