import type { LaneTemplateName } from '@ferretry/protocol';

/** What a folder says about how its work ships. */
export interface ProjectGitFacts {
  /** Whether the folder is inside a git repository. */
  readonly hasRepository: boolean;
  /** Whether the repository has a `v*` release tag. */
  readonly hasReleaseTags: boolean;
}

/**
 * The lane template a project with no lanes is proposed (`board-design.md` §5): a repository that tags `v*` releases
 * ships through releases and gets a check on the running build, a repository without tags merges and is done, and a
 * folder with no repository is plain work.
 */
export const inferLaneTemplate = (facts: ProjectGitFacts): LaneTemplateName => {
  if (!facts.hasRepository) return 'quick';
  return facts.hasReleaseTags ? 'pr-release-verify' : 'pr';
};
