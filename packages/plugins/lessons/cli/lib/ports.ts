import type {
  AgentLessonToolResult,
  LessonsActionRequest,
  LessonsApplyPreview,
  LessonsConfig,
  LessonsPatchResponse,
  LessonsScanEstimate,
  LessonsScanProgress,
  LessonsScanRequest,
  LessonsStatus,
  ProposalState,
  ProposalView,
  RunManifest,
} from '../../contract/index.ts';

/**
 * Presentation port for the lesson commands: the narrowest slice of the shell's terminal this context uses. Failures
 * travel as thrown errors; the half turns those into stderr and a non-zero exit code.
 */
export interface ILessonsOutput {
  success(message: string): void;
}

/**
 * The daemon calls the lesson commands need. Declared here so the controller never sees a URL or a status code: the CLI
 * reaches the daemon only through the generated client.
 */
export interface ILessonsGateway {
  /** Whether mining is enabled, what is pending, and how the last run went. */
  status(): Promise<LessonsStatus>;
  /** The proposal board, optionally narrowed to one lifecycle state. */
  proposals(state?: ProposalState): Promise<readonly ProposalView[]>;
  /** Accept, reject or reword one proposal and return it as the daemon left it. */
  act(id: string, request: LessonsActionRequest): Promise<ProposalView>;
  /** Ask the daemon to mine now; `spawn` also launches the miner ferrets. */
  run(spawn: boolean): Promise<RunManifest>;
  /** The mining schedule and the agent that performs it. */
  config(): Promise<LessonsConfig>;
  /** The guidance file an accepted proposal edits, rendered whole for the human to apply. */
  patch(id: string): Promise<LessonsPatchResponse>;
  /** Exactly what Apply would write, and the etag that pins it. */
  applyPreview(id: string): Promise<LessonsApplyPreview>;
  /** Writes the lesson into its target file; refused if the file moved since the etag was read. */
  apply(id: string, etag: string): Promise<ProposalView>;
  /** What a scan would cost, worked out without reading anything. */
  scanEstimate(request: LessonsScanRequest): Promise<LessonsScanEstimate>;
  /** Starts a scan. Explicit only: nothing here ever starts one by itself. */
  scan(request: LessonsScanRequest): Promise<LessonsScanProgress>;
  /** A ferret files one lesson as itself. */
  suggest(rule: string, scope: string): Promise<AgentLessonToolResult>;
}
