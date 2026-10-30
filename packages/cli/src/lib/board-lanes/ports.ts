import type {
  BoardProject,
  BoardProjectId,
  BoardProjectsResponse,
  LaneSetActionRequest,
  LaneSetChangeResponse,
} from '@ferretry/protocol';

/**
 * Everything the lane commands need from the daemon, declared here so the decision layer never sees a
 * URL. The adapter that implements it speaks `@ferretry/protocol` over HTTP.
 */
export interface ILaneGateway {
  projects(): Promise<BoardProjectsResponse>;
  project(projectId: BoardProjectId): Promise<BoardProject>;
  change(projectId: BoardProjectId, request: LaneSetActionRequest): Promise<LaneSetChangeResponse>;
}

/** The slice of the terminal port the lane controllers use; `ConsoleIo` satisfies it structurally. */
export interface ILaneOutput {
  success(message: string): void;
}
