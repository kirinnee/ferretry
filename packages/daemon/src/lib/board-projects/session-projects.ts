/**
 * THE SESSION → BOARD SEAM: resolve a board when a session starts, and read it back for a session that
 * predates the stamp. A session's `projectId` is written once at start and never again; an older session is
 * resolved from its cwd and parent chain each time it is asked, and its config is never rewritten.
 */
import type { BoardProjectId, ProjectInfo } from '@ferretry/protocol';
import { UNFILED_PROJECT_ID } from '@ferretry/protocol';
import { resolveSessionProject } from './project-resolution.ts';

/** The parts of a session's config the resolver reads. */
export interface SessionProjectFacts {
  readonly cwd: string;
  readonly parent?: string;
  readonly projectId?: BoardProjectId;
}

export interface SessionProjectFactSource {
  /** The stored facts, or `null` for a session this daemon does not know. */
  read(sessionId: string): Promise<SessionProjectFacts | null>;
}

export interface ProjectRegistry {
  projects(): Promise<readonly ProjectInfo[]>;
}

export interface RepositoryProbe {
  /** The git common directory containing `cwd`, or `null` outside a repository. Never rejects. */
  commonDirectory(cwd: string): Promise<string | null>;
}

/** A chain longer than this is a loop or an accident; the board then falls back to the cwd alone. */
export const MAX_PARENT_CHAIN = 16;

export class SessionProjects {
  constructor(
    private readonly sessions: SessionProjectFactSource,
    private readonly registry: ProjectRegistry,
    private readonly repositories: RepositoryProbe,
    private readonly scratchRoots: readonly string[],
  ) {}

  /** The board for a session about to start. */
  async projectForStart(start: { readonly cwd: string; readonly parent?: string }): Promise<BoardProjectId> {
    return await this.resolve(start.cwd, start.parent, new Set());
  }

  /** The board a session works on: the stamped one, else resolved now from its cwd and parent. */
  async projectOf(sessionId: string): Promise<BoardProjectId> {
    return await this.known(sessionId, new Set());
  }

  private async known(sessionId: string, seen: Set<string>): Promise<BoardProjectId> {
    const facts = await this.sessions.read(sessionId);
    if (facts === null) return UNFILED_PROJECT_ID;
    if (facts.projectId !== undefined) return facts.projectId;
    seen.add(sessionId);
    return await this.resolve(facts.cwd, facts.parent, seen);
  }

  private async resolve(cwd: string, parent: string | undefined, seen: Set<string>): Promise<BoardProjectId> {
    const [projects, commonDirectory, parentProjectId] = await Promise.all([
      this.registry.projects(),
      this.repositories.commonDirectory(cwd),
      parent === undefined || seen.has(parent) || seen.size >= MAX_PARENT_CHAIN
        ? Promise.resolve(undefined)
        : this.known(parent, seen),
    ]);
    return resolveSessionProject({
      cwd,
      ...(parentProjectId === undefined ? {} : { parentProjectId }),
      projects,
      commonDirectory,
      scratchRoots: this.scratchRoots,
    }).projectId;
  }
}
