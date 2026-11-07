import type { ProjectInfo, ProjectsApi, RegisterProjectRequest } from '@ferretry/plugin-projects/contract';
import type { ProjectRegistrar, ProjectRegistry } from '../../lib/lanes/ports.ts';

/**
 * The project list, through Projects when that plugin is on. Off, there are no registered projects: only the Unfiled
 * board exists, and a repository cannot be registered (adoption then leaves a ferret Unfiled).
 */
export class UsedProjects implements ProjectRegistry, ProjectRegistrar {
  constructor(private readonly used: () => ProjectsApi | undefined) {}

  async projects(): Promise<readonly ProjectInfo[]> {
    return (await this.used()?.list()) ?? [];
  }

  async register(request: RegisterProjectRequest): Promise<ProjectInfo> {
    const projects = this.used();
    if (projects === undefined) throw new Error('Projects is off, so no folder can be registered as a project');
    const registered = await projects.register(request);
    if (!registered.ok) throw new Error(registered.error.message);
    return registered.value;
  }
}
