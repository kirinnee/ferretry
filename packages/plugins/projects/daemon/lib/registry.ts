import { basename, resolve } from 'node:path';
import { err, ok, type Result } from '@ferretry/std';
import {
  ProjectCloneUrlSchema,
  ProjectCloneUrlUnsupportedMessage,
  type ProjectId,
  type ProjectInfo,
  ProjectPathSchema,
  type ProjectRefusal,
  type RegisterProjectRequest,
} from '../../contract/index.ts';
import type { ProjectFolders, RegistryClock, RegistryStore } from './ports.ts';

/** A registration that did not become a record: the sentence is the daemon's own and goes back as a 422. */
class RegistrationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationRefused';
  }
}

export interface RegistryDeps {
  readonly store: RegistryStore;
  readonly folders: ProjectFolders;
  readonly clock: RegistryClock;
  readonly newId: () => string;
  /** Said after the write landed (§7.4). */
  readonly registered: (id: ProjectId) => void;
  readonly removed: (id: ProjectId) => void;
}

/**
 * The daemon's authoritative project registry (today's `FileProjectCatalog`). This deliberately has no scan method: a
 * folder observed in a ferret is a discovery, not a project, until the caller explicitly confirms it through
 * `register`.
 */
export class ProjectRegistry {
  constructor(private readonly deps: RegistryDeps) {}

  async list(): Promise<readonly ProjectInfo[]> {
    return await this.deps.store.read();
  }

  async find(id: ProjectId): Promise<ProjectInfo | undefined> {
    return (await this.list()).find(project => project.id === id);
  }

  /**
   * Registers a folder. A folder (or git repository) already registered answers with the record that is already
   * there, so the call is idempotent. The read-dedupe-write is one serial step in the store, so two registrations at
   * once (an owner's `fy project add` and a ferret's first card in the same repository) make one record.
   */
  async register(request: RegisterProjectRequest): Promise<Result<ProjectInfo, ProjectRefusal>> {
    let root: string;
    let git: ProjectInfo['git'] | undefined;
    try {
      root = await this.materialize(request);
      const commonDirectory = await this.deps.folders.gitCommonDirectory(root);
      git = commonDirectory === undefined ? undefined : { commonDirectory };
    } catch (error) {
      return err(refusal(error));
    }
    let created: ProjectInfo | undefined;
    let answer: ProjectInfo | undefined;
    await this.deps.store.update(current => {
      const duplicate = current.projects.find(
        project => project.path === root || (git !== undefined && project.git?.commonDirectory === git.commonDirectory),
      );
      if (duplicate !== undefined) {
        answer = duplicate;
        return current;
      }
      const record: ProjectInfo = {
        id: this.deps.newId() as ProjectId,
        name: request.name ?? basename(root),
        path: root,
        source: request.kind,
        createdAt: this.deps.clock.now(),
        ...(git === undefined ? {} : { git }),
      };
      created = record;
      answer = record;
      return { ...current, projects: [...current.projects, record] };
    });
    if (created !== undefined) this.deps.registered(created.id);
    return ok(answer as ProjectInfo);
  }

  /** Forgets a registered project; the folder itself is left alone. */
  async remove(id: ProjectId): Promise<Result<ProjectInfo, ProjectRefusal>> {
    let gone: ProjectInfo | undefined;
    await this.deps.store.update(current => {
      gone = current.projects.find(project => project.id === id);
      if (gone === undefined) return current;
      return { ...current, projects: current.projects.filter(project => project.id !== id) };
    });
    if (gone === undefined) return err({ code: 'not_found', message: `no project ${id}` });
    this.deps.removed(id);
    return ok(gone);
  }

  private async materialize(request: RegisterProjectRequest): Promise<string> {
    // The contract schema owns the absolute-path decision; enforce that same schema here, before resolve(), so a
    // direct caller cannot bypass the trust boundary the route's parse forms. resolve() is total, so checking its
    // output would be a dead guard — a relative input would become absolute against this daemon's cwd.
    const parsed = ProjectPathSchema.safeParse(request.path);
    if (!parsed.success) throw new RegistrationRefused('project path must be absolute');
    const requested = resolve(parsed.data);
    const { folders } = this.deps;
    // The fence first: a new folder or a clone is made only where the owner may name a project at all.
    if (request.kind !== 'existing-folder' && !(await folders.mayName(requested)))
      throw new RegistrationRefused('project path is inside a folder Ferretry keeps for itself');
    if (request.kind === 'new-folder') {
      await folders.makeDirectory(requested);
      if (request.initializeGit) await folders.gitInit(requested);
    } else if (request.kind === 'clone') {
      // The same re-parse as the path, for the same reason: a direct caller skips the route's parse.
      const url = ProjectCloneUrlSchema.safeParse(request.url);
      if (!url.success) throw new RegistrationRefused(ProjectCloneUrlUnsupportedMessage);
      await folders.gitClone(url.data, requested);
    }
    if (!(await folders.isDirectory(requested)))
      throw new RegistrationRefused('project path is not an existing directory');
    return await folders.canonical(requested);
  }
}

const refusal = (error: unknown): ProjectRefusal => ({
  code: 'registration_failed',
  message: error instanceof Error && error.message !== '' ? error.message : 'the project could not be registered',
});
