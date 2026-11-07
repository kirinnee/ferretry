import type {
  BoardMergeGateResponse,
  BoardProject,
  BoardProjectId,
  BoardProjectsResponse,
  BoardQueryInput,
  BoardResponse,
  BoardSkipRequest,
  BoardSkipResponse,
  BoardSwitch,
  CardActionRequestInput,
  CardCreateRequestInput,
  CardResponse,
  LaneSetActionRequestInput,
  LaneSetChangeResponse,
} from '../../contract/index.ts';
import type { RelatedGateway } from './related.ts';

/** A ferret as the board commands need to name it: its id, and the name a person types. */
export interface FerretDirectoryEntry {
  readonly id: string;
  readonly name: string | undefined;
}

/**
 * Everything the board commands need from the daemon, declared here so the decision layer never sees a route key.
 * The acting ferret is the caller's own credential: the daemon derives ferret-or-owner from it, so a write without a
 * ferret's credential is the owner's.
 */
export interface BoardGateway extends RelatedGateway {
  board(query: BoardQueryInput): Promise<BoardResponse>;
  card(id: string): Promise<CardResponse>;
  create(request: CardCreateRequestInput): Promise<CardResponse>;
  act(id: string, request: CardActionRequestInput): Promise<CardResponse>;
  /** `fy card skip`: records on the calling ferret why its work has no card. The daemon refuses an owner. */
  skip(request: BoardSkipRequest): Promise<BoardSkipResponse>;
  projects(): Promise<BoardProjectsResponse>;
  ferrets(): Promise<readonly FerretDirectoryEntry[]>;
  mergeGate(pr: string): Promise<BoardMergeGateResponse>;
}

export interface LaneGateway {
  projects(): Promise<BoardProjectsResponse>;
  project(projectId: BoardProjectId): Promise<BoardProject>;
  change(projectId: BoardProjectId, request: LaneSetActionRequestInput): Promise<LaneSetChangeResponse>;
  switchOf(projectId: BoardProjectId): Promise<BoardSwitch>;
  /** The owner switching it; the daemon refuses a ferret. */
  setSwitch(projectId: BoardProjectId, on: boolean): Promise<BoardSwitch>;
}

/** The terminal, as the controllers use it: stdout is the answer, stderr the notices. */
export interface BoardOutput {
  success(message: string): void;
  diagnostic(message: string): void;
}

/** Reading `--brief-file`, `--how-to-test-file` and `fy card patch --file` is IO; `-` is standard input. */
export interface TextFiles {
  readText(path: string): Promise<string>;
}
