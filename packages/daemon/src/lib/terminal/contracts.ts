import type { SurfaceOpener, TerminalSize } from '@ferretry/protocol';

export interface TerminalRecord extends TerminalSize {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly root: string;
  readonly tmuxSession: string;
  readonly createdAtMs: number;
  readonly lastActivityAtMs: number;
  /**
   * Who opened this shell. ABSENT MEANS UNRECORDED — a pane created before the
   * daemon recorded provenance, or one whose stored opener this build cannot
   * read — and it travels to the wire as an absent field rather than a default.
   */
  readonly openedBy?: SurfaceOpener;
}

export interface TerminalSession {
  readonly id: string;
  readonly cwd: string;
}

export interface TerminalSessionResolver {
  resolve(sessionReference: string): Promise<TerminalSession | undefined>;
}

export interface TerminalRuntimePort {
  list(): Promise<readonly TerminalRecord[]>;
  create(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly title: string;
    readonly cwd: string;
    readonly size: TerminalSize;
    /** Omitted when nothing about the caller could be attested. */
    readonly openedBy?: SurfaceOpener;
  }): Promise<TerminalRecord>;
  rename(record: TerminalRecord, title: string): Promise<void>;
  resize(record: TerminalRecord, size: TerminalSize): Promise<void>;
  write(record: TerminalRecord, bytes: Uint8Array): Promise<void>;
  capture(record: TerminalRecord): Promise<Uint8Array>;
  kill(record: TerminalRecord): Promise<void>;
}

export interface TerminalClock {
  now(): number;
}

export interface TerminalIdSource {
  next(): string;
}
