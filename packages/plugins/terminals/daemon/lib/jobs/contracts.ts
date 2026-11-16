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
  /**
   * The processes the wrapper has tracked for this job, as it wrote them (`pid=start`, one per line): what a stop must not
   * leave running. Empty when the wrapper has tracked none, or its file is absent.
   */
  readTracked(owner: string, id: string): Promise<readonly TrackedProcess[]>;
  /** Whether the ferret was told how this job ended (a live attachment read its end, or a message was queued). */
  isReported(owner: string, id: string): Promise<boolean>;
  /** Records that the ferret was told: an empty `reported` file in the job's folder, gone with the folder. */
  markReported(owner: string, id: string): Promise<void>;
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

/** One process of a job's tree, by incarnation: its pid and the start reading the wrapper took of it. */
export interface TrackedProcess {
  readonly pid: number;
  readonly start: string;
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
  /**
   * The nearest ancestor of `pid` that runs a harness CLI, with the start read for it — or `undefined` when none does
   * (a person's own terminal) or this host cannot walk ancestry. It is read once, when an attachment registers.
   */
  /**
   * The command line of a running process (`undefined` when none runs, `'unknown'` when the host cannot say). The keeper
   * registers ONLY a process that runs `<fy> job attach|run`: a forged registry entry for any other program would otherwise
   * make the move gate call it safe.
   */
  argvOf(pid: number): Promise<string | undefined | 'unknown'>;
  harnessOf?(pid: number): Promise<{ readonly pid: number; readonly start: string } | undefined>;
  /** SIGKILL to one pid. The caller has just re-proved with `startOf` which process that pid is. */
  kill(pid: number): Promise<void>;
}
