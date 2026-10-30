import type { ProjectInfo, ProjectList, RegisterProjectRequest } from '@ferretry/protocol';

/**
 * The project registry routes `fy project` needs, declared here so the decision layer never sees a URL.
 * `register` is the daemon's own dedupe: a folder already registered (by path, or by the git repository
 * it belongs to) answers with the record that is already there.
 */
export interface IProjectGateway {
  projects(): Promise<ProjectList>;
  register(request: RegisterProjectRequest): Promise<ProjectInfo>;
}

/** The slice of the terminal port the project commands use; `ConsoleIo` satisfies it structurally. */
export interface IProjectOutput {
  success(message: string): void;
}
