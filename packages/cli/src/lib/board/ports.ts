import type {
  BoardProjectsResponse,
  BoardQueryInput,
  BoardResponse,
  BoardTaskActionRequestInput,
  BoardTaskCreateRequestInput,
  BoardTaskResponse,
} from '@ferretry/protocol';

/** A session as the board commands need to name it: its id, and the callsign a person types. */
export interface SessionDirectoryEntry {
  readonly id: string;
  readonly callsign: string | undefined;
}

/**
 * Everything the board commands need from the daemon, declared here so the decision layer never sees a
 * URL or a header. `as` is the session the CLI acts as: the daemon derives ferret-or-owner from it, so a
 * write without one is the owner's.
 */
export interface IBoardGateway {
  board(query: BoardQueryInput): Promise<BoardResponse>;
  task(id: string): Promise<BoardTaskResponse>;
  create(as: string | undefined, request: BoardTaskCreateRequestInput): Promise<BoardTaskResponse>;
  act(as: string | undefined, id: string, request: BoardTaskActionRequestInput): Promise<BoardTaskResponse>;
  /** `current` is the project of `as`, so the caller's session rides along. */
  projects(as: string | undefined): Promise<BoardProjectsResponse>;
  sessions(): Promise<readonly SessionDirectoryEntry[]>;
}

/** `ConsoleIo` satisfies this structurally; the notice goes to stderr so stdout stays the answer. */
export interface IBoardOutput {
  success(message: string): void;
  report(message: string): void;
  diagnostic(message: string): void;
}
