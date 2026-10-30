/**
 * Which GitHub repository a git remote URL names, in every spelling git accepts for one:
 * `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)` and `ssh://git@github.com/o/r(.git)`.
 * Anything else — another host, a local path, a malformed URL — names none.
 */
const REMOTE =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u;

/** `owner/name`, or `null` when the URL is not a GitHub repository. */
export const githubRepositoryOfRemote = (url: string): string | null => {
  const match = REMOTE.exec(url.trim());
  return match?.[1] === undefined || match[2] === undefined ? null : `${match[1]}/${match[2]}`;
};
