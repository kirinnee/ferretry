import { definePort, defineEvent } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import { z } from 'zod';
import type { ProjectId, ProjectInfo, ProjectRefusal, RegisterProjectRequest } from './wire.ts';
import { ProjectIdSchema } from './wire.ts';

/**
 * The project list, read and written through one port (§2.3). Board and the project pickers read it; the folder a
 * ferret may open is NOT decided here, it is checked by the core (`WorkFolders`).
 */
export interface ProjectsApi {
  /** Every registered project, oldest first. */
  list(): Promise<readonly ProjectInfo[]>;
  find(id: ProjectId): Promise<ProjectInfo | undefined>;
  /**
   * Registers a folder. A folder (or git repository) already registered answers with the record that is already
   * there (the daemon's own dedupe), so the call is idempotent.
   */
  register(request: RegisterProjectRequest): Promise<Result<ProjectInfo, ProjectRefusal>>;
  remove(id: ProjectId): Promise<Result<ProjectInfo, ProjectRefusal>>;
}

export const ProjectsPort = definePort<ProjectsApi>('projects');

/** Wake-ups, published after the write landed (§7.4). The truth is `ProjectsApi.list()`. */
export const ProjectRegistered = defineEvent('projects.registered', z.strictObject({ id: ProjectIdSchema }));
export const ProjectRemoved = defineEvent('projects.removed', z.strictObject({ id: ProjectIdSchema }));

/**
 * Insights seam, DECLARED with no implementation (r9 B5; "a later phase"): what a project could tell about its pull
 * requests, repositories and branches once a source for it is built (track E). Nothing in this plugin implements or calls
 * it; a later unit provides the implementation.
 */
export interface ProjectInsightsSource {
  /** Free-form, source-defined facts about one project; the shape is that phase's to decide. */
  insights(project: ProjectInfo): Promise<unknown>;
}
