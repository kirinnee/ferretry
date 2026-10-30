/**
 * A FERRET REGISTERS THE REPOSITORY IT WORKS IN. The owner never has to: the first card a ferret makes while it
 * is on the Unfiled board, standing in a git repository under one of the daemon's `projectRoots`, registers that
 * repository as a project, puts the ferret on its board and has the project's lanes proposed (one agenda choice
 * for the owner). A folder that is not a repository, the home folder itself, a temp or scratch folder, and a
 * repository outside every project root all stay Unfiled.
 *
 * Idempotent and race-safe: the registry dedupes on the repository, a project that already has lanes is never
 * proposed again, and the whole step runs serialized per repository, so two ferrets in the same repository at
 * once make one project and one proposal.
 */
import { posix } from 'node:path';
import {
  type BoardProjectId,
  type LaneSet,
  type ProjectInfo,
  type RegisterProjectRequest,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import type { SerialExecutor } from '../ports.ts';
import { projectRootFor } from '../session-mcp/service.ts';
import { isUnderScratchRoot } from './project-resolution.ts';
import type { SessionProjectFactSource } from './session-projects.ts';

/** Where a repository lives: its git common directory, and the folder of its main working tree. */
export interface RepositoryLocation {
  readonly commonDirectory: string;
  readonly root: string;
}

export interface RepositoryLocator {
  /** The repository containing `cwd`, or `null` outside one. Never rejects. */
  locate(cwd: string): Promise<RepositoryLocation | null>;
}

export interface ProjectRegistrar {
  /** Registers a folder, or answers with the project already registered for its path or its repository. */
  register(request: RegisterProjectRequest): Promise<ProjectInfo>;
}

export interface AdoptionLaneSets {
  laneSet(projectId: BoardProjectId): Promise<LaneSet | null>;
}

/** Proposes the lanes a project's folder suggests, as `sessionId`; `null` when it could not. */
export interface AdoptionLaneProposer {
  propose(projectId: BoardProjectId, sessionId: string): Promise<LaneSet | null>;
}

export interface SessionProjectStamp {
  /** Moves a session that is on the Unfiled board (or on none yet) to `projectId`; any other board is kept. */
  stamp(sessionId: string, projectId: BoardProjectId): Promise<void>;
}

/** The folders a repository must sit in to be registered, and the ones it never may. All absolute. */
export interface AdoptionPlaces {
  readonly projectRoots: readonly string[];
  readonly home: string;
  readonly scratchRoots: readonly string[];
}

export interface ProjectAdoptionPorts {
  readonly sessions: SessionProjectFactSource;
  readonly repositories: RepositoryLocator;
  readonly registry: ProjectRegistrar;
  readonly lanes: AdoptionLaneSets;
  readonly proposer: AdoptionLaneProposer;
  readonly stamp: SessionProjectStamp;
  /** Read on every adoption, so an edited `projectRoots` applies without a restart. */
  readonly places: () => Promise<AdoptionPlaces>;
  readonly serial: Pick<SerialExecutor, 'run'>;
}

export interface AdoptedProject {
  readonly projectId: BoardProjectId;
  /** Whether this adoption proposed the project's lanes (and so raised the owner's agenda choice). */
  readonly proposed: boolean;
}

/** `~` and `~/…` against the home folder; every other root is taken as written. */
export const expandProjectRoots = (roots: readonly string[], home: string): readonly string[] =>
  roots.map(root => (root === '~' ? home : root.startsWith('~/') ? posix.join(home, root.slice(2)) : root));

/**
 * The folder to register for a repository, or `undefined` when it must stay Unfiled: its main working tree,
 * when that is inside a project root and is neither the home folder (nor above it) nor a temp or scratch folder.
 */
export const adoptableRoot = (location: RepositoryLocation, places: AdoptionPlaces): string | undefined => {
  const root = location.root;
  if (!posix.isAbsolute(root)) return undefined;
  if (projectRootFor(places.home, [root]) !== undefined) return undefined;
  if (isUnderScratchRoot(root, places.scratchRoots)) return undefined;
  const roots = places.projectRoots.filter(candidate => posix.isAbsolute(candidate));
  return projectRootFor(root, roots) === undefined ? undefined : root;
};

export class ProjectAdoption {
  constructor(private readonly ports: ProjectAdoptionPorts) {}

  /**
   * Registers the repository `sessionId` stands in and moves it onto that project's board, when it is on the
   * Unfiled board and its repository may be registered. `proposer` is the session the lane proposal (and the
   * owner's agenda choice) is raised as. `null` leaves the session where it was.
   */
  async adopt(sessionId: string, proposer: string = sessionId): Promise<AdoptedProject | null> {
    const facts = await this.ports.sessions.read(sessionId);
    if (facts === null) return null;
    if (facts.projectId !== undefined && facts.projectId !== UNFILED_PROJECT_ID) return null;
    const location = await this.ports.repositories.locate(facts.cwd);
    if (location === null) return null;
    const root = adoptableRoot(location, await this.ports.places());
    if (root === undefined) return null;
    return await this.ports.serial.run(`project-adoption:${location.commonDirectory}`, async () => {
      const project = await this.ports.registry.register({ kind: 'confirmed-discovery', path: root });
      const projectId = project.id as BoardProjectId;
      const existing = await this.ports.lanes.laneSet(projectId);
      const proposed = existing === null ? await this.ports.proposer.propose(projectId, proposer) : null;
      if (existing === null && proposed === null) return null;
      await this.ports.stamp.stamp(sessionId, projectId);
      return { projectId, proposed: proposed !== null };
    });
  }
}
