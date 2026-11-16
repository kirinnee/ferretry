import type { JobExit, JobMeta } from '../../../contract/index.ts';
import type { AttachmentsState } from './attachments.ts';

/** A job's folder on disk: its metadata, its log and its exit record. */
export interface JobFilesPort {
  /** Makes the job's private folder; returns its absolute path (what the wrapper in the pane writes into). */
  create(owner: string, id: string): Promise<string>;
  writeMeta(owner: string, id: string, meta: JobMeta): Promise<void>;
  /** Undefined when absent or unreadable (a folder with no usable metadata is not a job). */
  readMeta(owner: string, id: string): Promise<JobMeta | undefined>;
  readExit(owner: string, id: string): Promise<JobExit | undefined>;
  /** Writes `exit.json` atomically (the daemon's fallback only, when the wrapper could not). */
  writeExit(owner: string, id: string, exit: JobExit): Promise<void>;
  /** Asks the wrapper to stop the job: writes `stop`, which the wrapper's watcher turns into SIGTERM on the job's tree. */
  requestStop(owner: string, id: string): Promise<void>;
  outputSize(owner: string, id: string): Promise<number>;
  /** Up to `max` bytes of the log from `from`. */
  readOutput(owner: string, id: string, from: number, max: number): Promise<Uint8Array>;
  /** Every job folder: owner and id. */
  list(): Promise<readonly { readonly owner: string; readonly id: string }[]>;
  /** Deletes a job's folder and what is in it. */
  remove(owner: string, id: string): Promise<void>;
}

/** A job's tmux session, as the runtime lists it. */
export interface RunningJob {
  readonly owner: string;
  readonly id: string;
  readonly tmuxSession: string;
}

/** The keeper: the daemon-owned tmux server. */
export interface JobRuntimePort {
  start(input: {
    readonly owner: string;
    readonly id: string;
    readonly dir: string;
    readonly cwd: string;
    readonly command: string;
    /** Whether to place the job inside the ferret's limits scope (a job an agent started). */
    readonly limited: boolean;
  }): Promise<RunningJob>;
  list(): Promise<readonly RunningJob[]>;
  kill(job: RunningJob): Promise<void>;
}

/** The persisted attachment registry. */
export interface AttachmentStore {
  read(): Promise<AttachmentsState>;
  update(change: (current: AttachmentsState) => AttachmentsState): Promise<AttachmentsState>;
}

/** Proof of which process a pid is: an opaque start reading, or `undefined` when no such process runs, or `'unknown'`. */
export interface ProcessProof {
  startOf(pid: number): Promise<string | undefined | 'unknown'>;
}
