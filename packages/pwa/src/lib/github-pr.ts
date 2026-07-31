/**
 * GitHub pull-request recognition. Ported from kteam `ui/src/lib/pins.ts`.
 *
 * Shared rather than task-local because task links, pins and the transcript all
 * want the same answer to "is this string, in its entirety, one PR URL?".
 */

export interface GithubPr {
  readonly org: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
}

const GH_PR = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#][^\s]*)?$/iu;

/**
 * Recognises a value whose ENTIRE text is one GitHub PR URL. Returns null
 * otherwise — including a URL with trailing prose, because that is not "a PR
 * link", it is a note that mentions one, and it linkifies normally.
 */
export const parseGithubPr = (text: string): GithubPr | null => {
  const trimmed = text.trim();
  const match = GH_PR.exec(trimmed);
  if (match === null) return null;
  const [, org, repo, number] = match;
  if (!org || !repo || !number) return null;
  const parsed = Number(number);
  if (!Number.isSafeInteger(parsed)) return null;
  return { org, repo, number: parsed, url: trimmed };
};
