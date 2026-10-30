/**
 * WHICH BOARD A SESSION WORKS ON (`board-design.md` §2.2). The first rule that answers wins:
 *
 *   1. the PARENT's board, when the cwd is inside that project, a worktree of it, or a temp/scratch folder;
 *   2. the registered project whose repository (git common directory) the cwd belongs to;
 *   3. the registered project with the longest path that contains the cwd;
 *   4. `unfiled`.
 *
 * Pure: every fact it needs (the registered projects, the cwd's repository, the temp roots) is handed in,
 * so each branch is a plain input. A deleted project is never inherited — its id would name a board that
 * can no longer be opened.
 */
import { type BoardProjectId, type ProjectInfo, projectForWorktree, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import { projectRootFor } from '../session-mcp/service.ts';

export type ProjectResolutionRule = 'parent' | 'repository' | 'path' | 'unfiled';

export interface ProjectResolution {
  readonly projectId: BoardProjectId;
  readonly via: ProjectResolutionRule;
}

export interface ProjectResolutionInput {
  readonly cwd: string;
  /** The board the parent session works on, when this session has a parent whose board is known. */
  readonly parentProjectId?: BoardProjectId;
  readonly projects: readonly ProjectInfo[];
  /** The git common directory of `cwd`, or `null` outside a repository. */
  readonly commonDirectory: string | null;
  /** Folders whose contents belong to nobody: the OS temp directory and the daemon's scratch roots. */
  readonly scratchRoots: readonly string[];
}

/** Whether `cwd` is one of the roots or inside one. */
export const isUnderScratchRoot = (cwd: string, scratchRoots: readonly string[]): boolean =>
  projectRootFor(cwd, scratchRoots) !== undefined;

const inheritedProject = (input: ProjectResolutionInput): BoardProjectId | undefined => {
  const parent = input.parentProjectId;
  if (parent === undefined) return undefined;
  if (isUnderScratchRoot(input.cwd, input.scratchRoots)) return parent;
  if (parent === UNFILED_PROJECT_ID) return undefined;
  const project = input.projects.find(candidate => candidate.id === parent);
  if (project === undefined) return undefined;
  const sameRepository =
    input.commonDirectory !== null && projectForWorktree([project], input.commonDirectory) !== undefined;
  return sameRepository || projectRootFor(input.cwd, [project.path]) !== undefined ? parent : undefined;
};

export const resolveSessionProject = (input: ProjectResolutionInput): ProjectResolution => {
  const inherited = inheritedProject(input);
  if (inherited !== undefined) return { projectId: inherited, via: 'parent' };
  const repository =
    input.commonDirectory === null ? undefined : projectForWorktree(input.projects, input.commonDirectory);
  if (repository !== undefined) return { projectId: repository.id, via: 'repository' };
  const root = projectRootFor(
    input.cwd,
    input.projects.map(project => project.path),
  );
  const byPath = root === undefined ? undefined : input.projects.find(project => project.path === root);
  if (byPath !== undefined) return { projectId: byPath.id, via: 'path' };
  return { projectId: UNFILED_PROJECT_ID, via: 'unfiled' };
};
