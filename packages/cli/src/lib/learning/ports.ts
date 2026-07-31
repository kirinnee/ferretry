import type {
  IFyApiClient,
  LearningActionRequest,
  LearningConfig,
  LearningPatchResponse,
  LearningStatus,
  ProposalState,
  ProposalView,
  RunManifest,
} from '@ferretry/protocol';

/**
 * Presentation port for the learning commands — the narrowest slice of the shipped `ConsoleIo`
 * adapter this context uses, so the production adapter satisfies it structurally. Failures travel as
 * thrown errors; the composition root turns those into stderr and a non-zero exit code.
 */
export interface ILearningOutput {
  success(message: string): void;
}

/**
 * The daemon calls the learning commands need. Declared here so the controller never sees a URL or a
 * status code: the CLI reaches `fyd` only over the protocol client.
 */
export interface ILearningGateway {
  /** Whether mining is enabled, what is pending, and how the last run went. */
  status(): Promise<LearningStatus>;
  /** The proposal board, optionally narrowed to one lifecycle state. */
  proposals(state?: ProposalState): Promise<readonly ProposalView[]>;
  /** Accept, reject or reword one proposal and return it as the daemon left it. */
  act(id: string, request: LearningActionRequest): Promise<ProposalView>;
  /** Ask the daemon to mine now; `spawn` also launches the miner sessions. */
  run(spawn: boolean): Promise<RunManifest>;
  /** The mining schedule and the agent that performs it. */
  config(): Promise<LearningConfig>;
  /** The guidance file an accepted proposal edits, rendered whole for the human to apply. */
  patch(id: string): Promise<LearningPatchResponse>;
}

/** The only client capability the learning gateway consumes. */
export type LearningApiClient = Pick<IFyApiClient, 'request'>;
