/**
 * THE RELEASE A MERGE FIRST SHIPPED IN (`board-design.md` §3.1 item 7): the lowest `v*` release whose tag
 * contains the PR's merge commit, asked of GitHub's compare API.
 *
 * - **Candidates** are the repository's recent published releases (`query.ts`) published at or after the
 *   merge — one published before it cannot contain it — tried lowest version first, so the FIRST release
 *   that contains the commit wins.
 * - **Contains** means the merge commit is an ancestor of (or is) the tag's commit: comparing
 *   `<mergeSha>...<tag>` answers `ahead` or `identical`.
 * - **Not knowable from this window**: when every one of the {@link RELEASES_PER_QUERY} newest releases was
 *   published after the merge, an older one may be the first, so nothing is claimed. `releasedIn` is
 *   immutable once written, and a wrong release would never be corrected; an absent one only waits.
 */
import { compareProtocolVersions, type ReleasedIn } from '@ferretry/protocol';
import { z } from 'zod';
import { type PolledRelease, RELEASES_PER_QUERY } from './query.ts';

/** How many compares one merged PR may cost per poll. The next poll carries on from the same candidates. */
export const MAX_COMPARES_PER_PR = 3;

/**
 * The releases to try for a merge, lowest version first; `null` when the window cannot tell which release
 * came first (see the file header).
 */
export const releaseCandidates = (
  releases: readonly PolledRelease[],
  mergedAt: string,
): readonly PolledRelease[] | null => {
  const merged = Date.parse(mergedAt);
  const after = releases.filter(release => Date.parse(release.publishedAt) >= merged);
  if (releases.length >= RELEASES_PER_QUERY && after.length === releases.length) return null;
  return after.toSorted((left, right) => compareProtocolVersions(left.version, right.version) ?? 0);
};

/** The `gh` arguments that ask whether `tag` contains `sha`: only the comparison's status is printed. */
export const compareArguments = (repo: string, sha: string, tag: string): readonly string[] => [
  'api',
  `repos/${repo}/compare/${sha}...${encodeURIComponent(tag)}`,
  '--jq',
  '.status',
];

const CompareStatusSchema = z.enum(['ahead', 'behind', 'identical', 'diverged']);

/** Whether a compare's printed status says the tag contains the commit; `null` for an answer it cannot read. */
export const tagContains = (stdout: string): boolean | null => {
  const status = CompareStatusSchema.safeParse(stdout.trim());
  if (!status.success) return null;
  return status.data === 'ahead' || status.data === 'identical';
};

/** The cache value for a release found to contain a merge. */
export const releasedIn = (release: PolledRelease): ReleasedIn => ({
  version: release.version,
  tag: release.tag,
  at: release.publishedAt,
});
