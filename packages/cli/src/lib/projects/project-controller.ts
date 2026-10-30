import { isAbsolute, resolve } from 'node:path';
import type { ProjectInfo, ProjectList } from '@ferretry/protocol';
import { refuse } from '../tasks/errors';
import type { IProjectGateway, IProjectOutput } from './ports';

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
  readonly name?: string;
  readonly json?: boolean;
}

/**
 * `fy project add|ls`: the registry a board belongs to. `add` sends an absolute path, because a relative one
 * would resolve against the daemon's directory rather than the caller's.
 */
export class ProjectController {
  constructor(
    private readonly gateway: IProjectGateway,
    private readonly output: IProjectOutput,
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
    });
    const existed = before.has(project.id);
    if (options.json === true) return this.output.success(asJson({ project, created: !existed }));
    this.output.success(`${existed ? 'already registered' : 'registered'}: ${renderProject(project)}`);
  }

  async list(options: { readonly json?: boolean }): Promise<void> {
    const projects = await this.gateway.projects();
    this.output.success(options.json === true ? asJson(projects) : renderProjects(projects, this.binary));
  }
}
