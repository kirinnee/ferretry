/**
 * THE FERRET → BOARD SEAM: resolve a board when a ferret starts, and read it back for a ferret that was not stamped
 * (the stamp is written once at start and never again; an unstamped ferret is resolved from its folder and parent
 * chain each time it is asked).
 */
import { type BoardProjectId, UNFILED_PROJECT_ID } from '../../../contract/index.ts';
import { resolveFerretProject } from './project-resolution.ts';
import type { ProjectRegistry } from './ports.ts';

/** The parts of a ferret's record the resolver reads. */
export interface FerretProjectFacts {
  readonly folder: string;
  readonly parent?: string;
  readonly projectId?: BoardProjectId;
}

export interface FerretProjectFactSource {
  /** The facts, or `null` for a ferret this daemon does not know. */
  read(ferretId: string): Promise<FerretProjectFacts | null>;
}

export interface RepositoryProbe {
  /** The git common directory containing `folder`, or `null` outside a repository. Never rejects. */
  commonDirectory(folder: string): Promise<string | null>;
}

/** A chain longer than this is a loop or an accident; the board then falls back to the folder alone. */
export const MAX_PARENT_CHAIN = 16;

export class FerretProjects {
  constructor(
    private readonly ferrets: FerretProjectFactSource,
    private readonly registry: ProjectRegistry,
    private readonly repositories: RepositoryProbe,
    private readonly scratchRoots: readonly string[],
  ) {}

  /** The board for a ferret about to start. */
  async projectForStart(start: { readonly folder: string; readonly parent?: string }): Promise<BoardProjectId> {
    return await this.resolve(start.folder, start.parent, new Set());
  }

  /** The board a ferret works on: the stamped one, else resolved now from its folder and parent. */
  async projectOf(ferretId: string): Promise<BoardProjectId> {
    return await this.known(ferretId, new Set());
  }

  private async known(ferretId: string, seen: Set<string>): Promise<BoardProjectId> {
    const facts = await this.ferrets.read(ferretId);
    if (facts === null) return UNFILED_PROJECT_ID;
    if (facts.projectId !== undefined) return facts.projectId;
    seen.add(ferretId);
    return await this.resolve(facts.folder, facts.parent, seen);
  }

  private async resolve(folder: string, parent: string | undefined, seen: Set<string>): Promise<BoardProjectId> {
    const [projects, commonDirectory, parentProjectId] = await Promise.all([
      this.registry.projects(),
      this.repositories.commonDirectory(folder),
      parent === undefined || seen.has(parent) || seen.size >= MAX_PARENT_CHAIN
        ? Promise.resolve(undefined)
        : this.known(parent, seen),
    ]);
    return resolveFerretProject({
      folder,
      ...(parentProjectId === undefined ? {} : { parentProjectId }),
      projects,
      commonDirectory,
      scratchRoots: this.scratchRoots,
    }).projectId;
  }
}
