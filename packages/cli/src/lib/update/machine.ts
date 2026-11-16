/**
 * What the update needs of THIS machine, which only the `fy` shell can give it (no half of a plugin touches a file or
 * a process directly): the installed daemon executable, a command run, a prompt, the clock, a private file, the
 * service manager's restart. Copied from today's `lib/daemon/{binary,ports}.ts`, narrowed to what the update reads.
 */

/** The daemon executable a lifecycle verb will record and launch. */
export interface InstalledDaemonBinary {
  /** ABSOLUTE, always. */
  readonly path: string;
  /** How this host found it, so a report can say why it is that one. */
  readonly source: 'FY_DAEMON_BIN' | 'PATH';
  readonly version?: string | undefined;
}

/** One finished command. */
export interface CommandOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface IDaemonPrompt {
  ask(message: string): Promise<string>;
}

export interface IClockPort {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

/** The narrowest slice of the terminal the update prints with. */
export interface IDaemonOutput {
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** A file only its owner reads. */
export interface IServiceFilePort {
  writePrivate(path: string, contents: string): Promise<void>;
}
