import path from 'node:path';
import { ApiError } from '@ferretry/kernel/contract';
import type { FerretsApi, WorktreeRemovalDecision } from '@ferretry/core-ferrets/contract';
import type { ProjectId, ProjectInfo, ProjectsApi } from '@ferretry/plugin-projects/contract';
import { BranchPullResultSchema, type PullsApi } from '@ferretry/plugin-pulls/contract';
import type {
  TidyWorktreeRemoveRequest,
  TidyWorktreeRemoveResult,
  TidyWorktreeRow,
  TidyWorktrees,
} from '../../../contract/index.ts';
import { worktreeVerdict } from './verdict.ts';

interface WorktreeNeeds {
  readonly ferrets: Pick<FerretsApi, 'repoWorktrees' | 'checkWorktreeRemoval' | 'removeWorktree'>;
  readonly projects: () => Pick<ProjectsApi, 'find'> | undefined;
  readonly pulls: () => PullsApi | undefined;
}

/** Saved project repositories only. U3 authorizes and proves each common directory before reading Git. */
function repositories(project: ProjectInfo) {
  const repos = (project.repos ?? []).map(repo => ({
    path: repo.path,
    commonDirectory:
      repo.path === '.' && project.git !== undefined
        ? project.git.commonDirectory
        : path.join(project.path, repo.path, '.git'),
    remote: repo.remote,
  }));
  if (project.git !== undefined && !repos.some(repo => repo.path === '.'))
    repos.unshift({ path: '.', commonDirectory: project.git.commonDirectory, remote: undefined });
  return repos;
}

const repoRef = (remote: string | undefined) => {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(remote ?? '');
  return match === null ? undefined : { owner: match[1]!, name: match[2]! };
};

/** No cache, fetch, registry writes or deletion of its own. Every apply repeats all evidence for that path. */
export class TidyWorktreesService {
  constructor(private readonly needs: WorktreeNeeds) {}

  async list(projectId: ProjectId, cwd?: string, only?: string): Promise<TidyWorktrees> {
    const projects = this.needs.projects();
    const listRepo = this.needs.ferrets.repoWorktrees;
    if (projects === undefined || listRepo === undefined)
      throw new ApiError(503, 'Projects or worktree listing is unavailable', 'unavailable');
    const project = await projects.find(projectId);
    if (project === undefined) throw new ApiError(404, 'This project is not registered', 'not_found');
    const rows: TidyWorktreeRow[] = [];
    const unavailable: TidyWorktrees['unavailable'] = [];
    let truncated = false;
    for (const repo of repositories(project)) {
      try {
        const listing = await listRepo(repo.commonDirectory);
        truncated ||= listing.truncated;
        const selected = listing.worktrees.filter(row => only === undefined || row.path === only);
        const branches = [
          ...new Set(selected.flatMap(row => (row.live.branch === undefined ? [] : [row.live.branch]))),
        ];
        const ref = repoRef(repo.remote);
        // U5 owns the read budget, ETags and the 25-branch bound. Do not split it into extra requests.
        const pulls = this.needs.pulls();
        const answers =
          ref === undefined || pulls === undefined || branches.length === 0
            ? []
            : await pulls.branchPulls(projectId, ref, branches).catch(() => []);
        for (const worktree of selected) {
          if (rows.length === 500) {
            truncated = true;
            break;
          }
          const matches = answers.filter(answer => answer.branch === worktree.live.branch);
          const pull = matches.length === 1 ? BranchPullResultSchema.safeParse(matches[0]).data : undefined;
          let removal: WorktreeRemovalDecision | undefined;
          if (!worktree.main && !worktree.bare && !worktree.live.detached && worktree.tracked !== 'none')
            removal = await this.needs.ferrets.checkWorktreeRemoval?.(worktree.path, cwd).catch(() => undefined);
          rows.push({
            commonDirectory: listing.commonDirectory,
            repository: repo.path,
            worktree,
            ...(pull === undefined ? {} : { pull }),
            verdict: worktreeVerdict(worktree, pull, removal),
          });
        }
      } catch {
        unavailable.push({ commonDirectory: repo.commonDirectory, reason: 'This repository could not be read safely' });
      }
    }
    return { project: projectId, rows, unavailable, truncated };
  }

  async remove(
    project: ProjectId,
    worktrees: TidyWorktreeRemoveRequest['worktrees'],
    cwd?: string,
  ): Promise<TidyWorktreeRemoveResult> {
    const removed: TidyWorktreeRemoveResult['removed'] = [];
    const skipped: TidyWorktreeRemoveResult['skipped'] = [];
    const unique = new Map(worktrees.map(row => [row.path, row]));
    for (const { path: target, identity } of unique.values()) {
      try {
        const fresh = await this.list(project, cwd, target);
        const matches = fresh.rows.filter(row => row.worktree.path === target);
        const row = matches.length === 1 ? matches[0] : undefined;
        if (row === undefined || !row.verdict.removable || this.needs.ferrets.removeWorktree === undefined) {
          skipped.push({
            path: target,
            reason: row?.verdict.reason ?? 'The worktree is not available for this project',
          });
          continue;
        }
        const current = row.verdict.reviewedIdentity;
        if (
          current === undefined ||
          current.recordId !== identity.recordId ||
          current.branchRef !== identity.branchRef ||
          current.checkout !== identity.checkout ||
          current.head !== identity.head
        ) {
          skipped.push({ path: target, reason: 'The reviewed worktree changed; refresh and review it again' });
          continue;
        }
        removed.push(
          await this.needs.ferrets.removeWorktree({
            path: target,
            expectedHead: identity.head,
            expectedIdentity: identity,
            ...(cwd === undefined ? {} : { currentWorkingDirectory: cwd }),
          }),
        );
      } catch {
        skipped.push({ path: target, reason: 'Removal was refused; refresh to see the current safety checks' });
      }
    }
    return { removed, skipped };
  }
}
