import type { SessionAttachTarget } from '@ferretry/protocol';
import type { TranscriptTailResult } from '../reads/service.ts';

/**
 * Where one of a process's standard streams points, as the kernel reports it.
 *
 * Only a `file` is ever read. Every other kind is the read end of something another process is
 * already reading — the pane's terminal, a pipe into the harness, a socket — and opening it would
 * steal that output from its rightful reader, so the daemon never does.
 */
export type ProcessStreamTarget =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'terminal'; readonly path: string }
  | { readonly kind: 'pipe' }
  | { readonly kind: 'socket' }
  | { readonly kind: 'null' }
  | { readonly kind: 'other'; readonly description: string };

/** One process under the pane, with everything the Processes tab shows about it. */
export interface ProcessDetailRow {
  readonly pid: number;
  readonly ppid: number;
  /** `ProcessIncarnation`'s start value (Linux start ticks, macOS epoch seconds). With `pid`, the identity. */
  readonly start: number;
  readonly startedAtMs: number;
  /** The command line, NULs as spaces, control characters as `?` (as procps prints it). */
  readonly argv: string;
  /** The kernel's one-letter state (`R`, `S`, `D`, `T`, `t`, `Z`, …). */
  readonly state: string;
  /** User + system CPU time consumed so far, in seconds. */
  readonly cpuSeconds?: number;
  readonly rssBytes?: number;
  /** `undefined` where this host cannot see a process's descriptors (macOS: a declared GAP). */
  readonly stdout?: ProcessStreamTarget;
  readonly stderr?: ProcessStreamTarget;
}

export type ProcessTreeRead =
  | { readonly kind: 'read'; readonly rows: readonly ProcessDetailRow[] }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** Reads one pane's process subtree — that subtree only, never the machine's other processes. */
export interface ProcessTreePort {
  /** Descendants of `rootPid`, parents before children. The root itself is not included. */
  tree(rootPid: number): Promise<ProcessTreeRead>;
  /** Which of `pids` hold a listening TCP socket; `undefined` where the host cannot tell. */
  listening(pids: readonly number[]): Promise<ReadonlySet<number> | undefined>;
  /** The start value of `pid` now, read fresh — `undefined` once it has exited. */
  startOf(pid: number): Promise<number | undefined>;
}

/** Which rows the harness owns — itself and its long-lived helpers — by pid. */
export interface ProcessProvenancePort {
  identify(
    rows: readonly ProcessDetailRow[],
    rootPid: number,
  ): Promise<ReadonlyMap<number, { readonly kind: string }>>;
}

/** The pane the attach proof names: pane id, pid and process start, freshly matched. */
export interface SessionPaneProofPort {
  resolve(sessionId: string): Promise<SessionAttachTarget>;
}

export type OutputFileRead =
  | {
      readonly kind: 'read';
      readonly bytes: Uint8Array;
      readonly start: number;
      readonly size: number;
    }
  | { readonly kind: 'gone' }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Reads a byte range of an output file. It opens the PATH, never `/proc/<pid>/fd/<n>`, and only after
 * proving it is a regular file — and again on the opened descriptor — so a FIFO, a terminal or a socket
 * swapped in at that path can never be opened, blocked on or drained.
 */
export interface OutputFilePort {
  read(path: string, from: number | undefined, max: number): Promise<OutputFileRead>;
}

/** Sends SIGTERM to one pid. Resolves `false` when it had already exited. */
export interface ProcessSignalPort {
  terminate(pid: number): Promise<boolean>;
}

/** The session's recent conversation, for what the harness itself recorded about its tool commands. */
export interface SessionTranscriptTailPort {
  tail(sessionId: string, limit: number): Promise<TranscriptTailResult>;
}

/** Masks every stored secret value in text, failing closed when the vault cannot be opened. */
export interface ProcessTextRedactor {
  batch<T>(work: (scrub: { text(text: string): string }) => T): Promise<T>;
}

export interface ProcessClock {
  nowMs(): number;
}
