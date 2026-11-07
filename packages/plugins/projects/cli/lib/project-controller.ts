import { isAbsolute, resolve } from 'node:path';
import type { ProjectInfo, ProjectList, RegisterProjectRequest } from '../../contract/index.ts';

/** A refusal the user caused: a missing path, a name nobody has. The verb prints it and exits 1. */
export class ProjectInputError extends Error {
  override readonly name = 'ProjectInputError';
}

const refuse = (message: string): never => {
  throw new ProjectInputError(message);
};

/**
 * The project registry routes `fy project` needs, declared here so the decision layer never sees a route key.
 * `register` is the daemon's own dedupe: a folder already registered (by path, or by the git repository it belongs to)
 * answers with the record that is already there.
 */
export interface ProjectGateway {
  projects(): Promise<ProjectList>;
  register(request: RegisterProjectRequest): Promise<ProjectInfo>;
  remove(id: string): Promise<ProjectInfo>;
}

export interface ProjectOutput {
  success(message: string): void;
}

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

/** One project on one line: what a person types to name it, its id, and where it lives. */
const renderProject = (project: ProjectInfo): string => `${project.name}  ${project.id}  ${project.path}`;

export const renderProjects = (projects: ProjectList, binary: string): string =>
  projects.length === 0
    ? `no projects yet; register one with: ${binary} project add <path>`
    : [...projects]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(renderProject)
        .join('\n');

export interface ProjectAddOptions {
  readonly name?: string | undefined;
  readonly json?: boolean | undefined;
}

/**
 * `fy project add|list|remove`: the registry a board belongs to. `add` sends an absolute path, because a relative one
 * would resolve against the daemon's directory rather than the caller's.
 */
export class ProjectController {
  constructor(
    private readonly gateway: ProjectGateway,
    private readonly output: ProjectOutput,
    private readonly cwd: string,
    private readonly binary: string,
  ) {}

  async add(path: string, options: ProjectAddOptions): Promise<void> {
    const folder = path.trim();
    if (folder === '') refuse(`say which folder: ${this.binary} project add <path>`);
    const name = options.name?.trim();
    if (options.name !== undefined && name === '') refuse('--name must not be blank');
    const absolute = isAbsolute(folder) ? folder : resolve(this.cwd, folder);
    const before = new Set((await this.gateway.projects()).map(project => project.id));
    const project = await this.gateway.register({
      kind: 'existing-folder',
      path: absolute,
      ...(name === undefined ? {} : { name }),
    } as RegisterProjectRequest);
    const existed = before.has(project.id);
    if (options.json === true) return this.output.success(asJson({ project, created: !existed }));
    this.output.success(`${existed ? 'already registered' : 'registered'}: ${renderProject(project)}`);
  }

  async list(options: { readonly json?: boolean | undefined }): Promise<void> {
    const projects = await this.gateway.projects();
    this.output.success(options.json === true ? asJson(projects) : renderProjects(projects, this.binary));
  }

  /** `fy project remove <project>`: forget a registered project by its id, its name or its folder; the folder stays. */
  async remove(typed: string, options: { readonly json?: boolean | undefined }): Promise<void> {
    const wanted = typed.trim();
    if (wanted === '') refuse(`say which project: ${this.binary} project remove <name|id|path>`);
    const projects = await this.gateway.projects();
    const folded = wanted.toLowerCase();
    const absolute = isAbsolute(wanted) ? wanted : resolve(this.cwd, wanted);
    const found =
      projects.find(project => project.id === wanted) ??
      projects.find(project => project.name.toLowerCase() === folded) ??
      projects.find(project => project.path === absolute);
    if (found === undefined) {
      refuse(`no project "${wanted}"; see \`${this.binary} project list\``);
      return;
    }
    const removed = await this.gateway.remove(found.id);
    if (options.json === true) return this.output.success(asJson({ project: removed }));
    this.output.success(`removed: ${renderProject(removed)} (the folder itself is left alone)`);
  }
}
