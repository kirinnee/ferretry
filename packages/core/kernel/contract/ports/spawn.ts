import type { Duration } from '@ferretry/std';
import type { ChildEnvironment, FencedPath } from '../bound.ts';
import type { FerretId } from '../ids.ts';
import type { PinnedWorkingDirectory } from '../pinned.ts';

export interface SpawnOptions {
  /**
   * A fenced folder, or a directory held open by `RootHandle.pin` (`policyCwd`): the child starts INSIDE the held
   * object, installed for the instant of the spawn. A pin this plugin's roots did not mint is refused.
   */
  readonly cwd?: FencedPath | PinnedWorkingDirectory;
  /**
   * Plain values the half owns, or a Vault {@link ChildEnvironment} (secrets resolved for this child). A handle is
   * opened inside the kernel's adapter at exec time; its values never pass through the plugin (lead decision 9).
   */
  readonly env?: Readonly<Record<string, string>> | ChildEnvironment;
  readonly stdin?: string | Uint8Array;
  readonly timeout?: Duration;
  readonly signal?: AbortSignal;
  /**
   * A SEALED child (a secure copy's command capture): it sees only the host's sealed environment (the nine names a
   * child may inherit: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM`) and what its caller
   * hands over in `env`. The host's tool environment (the proxy, ssh-agent and config variables a `git` or `gh` child is given)
   * is NEVER added, whatever the program is called: a name is no evidence that a program is the trusted tool.
   */
  readonly sealed?: true;
  /** Runs inside this ferret's limits. */
  readonly forFerret?: FerretId;
  /**
   * `start` only: this many extra pipes beyond stdio 0-2, the child's fds 3, 4, … (today's Chrome launch,
   * `--remote-debugging-pipe` on 3 and 4). The daemon's ends are {@link ChildHandle.pipes}. At most 4.
   */
  readonly extraPipes?: number;
  /**
   * `start` only: the child gets its own session and process group (setsid), its stdio is ignored and it is
   * unreferenced, so it outlives this daemon (Browsers' platform link opener). Only for a program the manifest lists in
   * `permissions.detached` (a subset of `permissions.spawn`). Refused, before anything starts, with `run`/`runBytes`,
   * `forFerret`, `extraPipes`, `stdin`, a pinned `cwd`, `timeout`, `signal` or a Vault {@link ChildEnvironment}. The
   * handle's streams are empty and closed, `write` and `kill` throw, and `exited` is `null` at once: the kernel never
   * waits on it. The kernel logs the program's name and pid, never its arguments.
   */
  readonly detached?: true;
  /**
   * `start` only: the child leads its OWN process group (its stdio stays piped and the daemon still waits on it), and
   * `ChildHandle.kill` signals the whole group, so a manager's descendants end with it. It needs no manifest
   * entry: it only widens what `kill` reaches, to processes the child itself started. GAPS: Bun's `detached` is setsid,
   * so the group is its own session and on macOS (launchd stop, a terminal Ctrl-C) the manager can OUTLIVE the daemon,
   * which no longer signals it; and a descendant that calls setsid() itself leaves the group and escapes the group kill.
   */
  readonly ownGroup?: true;
}

/**
 * What `run` answers. A child that ended by a SIGNAL (its `timeout` ran out, its abort `signal` fired, or something
 * killed it) has no exit code of its own: `exitCode` is `null` and `signal` names the signal (`'SIGTERM'`). A child that
 * exited by itself answers its code and `signal: null`. So `exitCode === null` means a signal ended the child. It is
 * not a perfect timeout test: a child that catches the signal and exits by itself (say, with 143) still answers its own
 * code, so a timeout is not always told apart from a program's own non-zero verdict.
 */
export interface SpawnResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** `runBytes`: caps on what is kept of each stream (today's Git runner). */
export interface SpawnBytesOptions extends SpawnOptions {
  /** Default 1 MiB. Bytes past it are dropped and `stdoutTruncated` is set. */
  readonly maxStdoutBytes?: number;
  /** Default 64 KiB. */
  readonly maxStderrBytes?: number;
}

/** A finished child's raw stdout, capped (today's `GitExecution`). A timeout kills it (`SIGKILL`). */
export interface SpawnBytesResult {
  /** `-1` when the child was abandoned at its timeout. */
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
}

export interface ChildHandle {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  write(chunk: string | Uint8Array): void;
  kill(signal?: string): void;
  readonly exited: Promise<number | null>;
  /**
   * The daemon's ends of the {@link SpawnOptions.extraPipes}, in order (the child's fd 3 first); empty without any.
   * Close-on-exec, so no other child inherits one. Hand them on (a worker's transport) and close with `closePipes`.
   */
  readonly pipes: readonly number[];
  /** Closes the daemon's ends of the extra pipes, once; later calls do nothing. */
  closePipes(): void;
}

export interface SpawnPort {
  /** Only programs the manifest declared in `permissions.spawn`. */
  run(program: string, args: readonly string[], options?: SpawnOptions): Promise<SpawnResult>;
  /** The same, keeping stdout as bytes up to a cap and saying whether it was cut. */
  runBytes(program: string, args: readonly string[], options?: SpawnBytesOptions): Promise<SpawnBytesResult>;
  start(program: string, args: readonly string[], options?: SpawnOptions): ChildHandle;
}
