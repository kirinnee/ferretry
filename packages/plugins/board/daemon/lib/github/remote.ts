/**
 * Which GitHub repository a git remote URL names, in every spelling git accepts for one:
 * `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)` and `ssh://git@github.com/o/r(.git)`.
 * Anything else — another host, a local path, a malformed URL — names none.
 *
 * An SSH remote may name a host ALIAS instead (`github-personal:o/r.git`, with `Host github-personal` and
 * `HostName github.com` in `~/.ssh/config`): {@link parseGitRemote} reads its host as written, and the adapter
 * asks ssh where that alias really goes.
 */

/** The hosts GitHub serves git from: its own name, and the SSH-over-443 one. */
const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'ssh.github.com']);

/** A remote's host as written, how it is reached, and the `owner/name` path it names. */
export interface GitRemote {
  readonly host: string;
  /** Reached over SSH, so its host may be an alias in the ssh config. */
  readonly ssh: boolean;
  readonly repo: string;
}

const PATH = String.raw`([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?`;
const HTTPS = new RegExp(String.raw`^https:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/${PATH}$`, 'u');
const SSH_URL = new RegExp(String.raw`^ssh:\/\/(?:[^@/]+@)?([A-Za-z0-9][A-Za-z0-9._-]*)(?::\d+)?\/${PATH}$`, 'u');
/**
 * git's scp-like spelling, `[user@]host:owner/name`; a host with a slash in it would be a path. An SSH host never
 * starts with a dash: it is handed to `ssh -G`, where one would read as an option.
 */
const SCP = new RegExp(String.raw`^(?:[^@/:]+@)?([A-Za-z0-9][A-Za-z0-9._-]*):(?!\/)${PATH}$`, 'u');

/** A remote URL's host and `owner/name`, or `null` for a local path or anything that names no two-part path. */
export const parseGitRemote = (url: string): GitRemote | null => {
  const trimmed = url.trim();
  for (const [pattern, ssh] of [
    [HTTPS, false],
    [SSH_URL, true],
    [SCP, true],
  ] as const) {
    const match = pattern.exec(trimmed);
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      return { host: match[1].toLowerCase(), ssh, repo: `${match[2]}/${match[3]}` };
    }
  }
  return null;
};

/**
 * The GitHub repository a remote names once its host is known: `resolved` is where an SSH alias really goes
 * (ssh's `HostName`), or the host itself. `null` for any host that is not GitHub's.
 */
export const githubRepositoryOf = (remote: GitRemote, resolved: string | null): string | null =>
  GITHUB_HOSTS.has((resolved ?? remote.host).toLowerCase()) ? remote.repo : null;
