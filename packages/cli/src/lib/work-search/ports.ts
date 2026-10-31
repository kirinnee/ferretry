import type {
  BoardProjectsResponse,
  WorkRelatedRequest,
  WorkRelatedResponse,
  WorkSearchQueryInput,
  WorkSearchResponse,
} from '@ferretry/protocol';
import type { SessionDirectoryEntry } from '../board/ports';

/**
 * The daemon calls the work search needs. `as` is the session the CLI acts as, so the daemon can tell a
 * ferret from the owner; the controllers never see a URL.
 */
export interface IWorkSearchGateway {
  search(query: WorkSearchQueryInput, as: string | undefined): Promise<WorkSearchResponse>;
  /** `undefined` when the daemon has no related check yet (it answers 404), so a create goes on without one. */
  related(request: WorkRelatedRequest, as: string | undefined): Promise<WorkRelatedResponse | undefined>;
  projects(as: string | undefined): Promise<BoardProjectsResponse>;
  sessions(): Promise<readonly SessionDirectoryEntry[]>;
}

/** `ConsoleIo` satisfies this structurally; the notice goes to stderr so stdout stays the answer. */
export interface IWorkSearchOutput {
  success(message: string): void;
  diagnostic(message: string): void;
}
