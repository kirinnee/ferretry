import type { GitProvider } from '../../../contract/index.ts';

/**
 * Which host and `owner/name` a git remote URL names, in every spelling git accepts: `https://host/o/r(.git)`,
 * `ssh://git@host/o/r(.git)` and `git@host:o/r(.git)`.
 *
 * COPIED from Board's `daemon/lib/github/remote.ts` `parseGitRemote` (r9 B5 decision): Board's contract does not export
 * it, and a plugin may not import another plugin's daemon code. Board's also resolves SSH host aliases; this one reads the
 * host as written. Keep the two patterns in step.
 */
interface GitRemote {
  readonly host: string;
  readonly repo: string;
}

const PATH = String.raw`([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?`;
const HTTPS = new RegExp(String.raw`^https:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/${PATH}$`, 'u');
const SSH_URL = new RegExp(String.raw`^ssh:\/\/(?:[^@/]+@)?([A-Za-z0-9][A-Za-z0-9._-]*)(?::\d+)?\/${PATH}$`, 'u');
const SCP = new RegExp(String.raw`^(?:[^@/:]+@)?([A-Za-z0-9][A-Za-z0-9._-]*):(?!\/)${PATH}$`, 'u');

export const parseGitRemote = (url: string): GitRemote | null => {
  const trimmed = url.trim();
  for (const pattern of [HTTPS, SSH_URL, SCP]) {
    const match = pattern.exec(trimmed);
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined)
      return { host: match[1].toLowerCase(), repo: `${match[2]}/${match[3]}` };
  }
  return null;
};

const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'ssh.github.com']);

/**
 * What a project shows of a remote: `https://<host>/<owner>/<name>` and the provider. The text as written is NEVER
 * kept: an `https://user:token@host/...` remote carries a credential, and this record is listed to every caller.
 */
export const describeRemote = (url: string): { remote: string; provider?: GitProvider } | undefined => {
  const parsed = parseGitRemote(url);
  if (parsed === null) return undefined;
  const github = GITHUB_HOSTS.has(parsed.host);
  const host = github ? 'github.com' : parsed.host;
  return { remote: `https://${host}/${parsed.repo}`, ...(github ? { provider: 'github' as const } : {}) };
};

/**
 * The URL of `origin` (else the first remote) in the text of a `.git/config`. A line-by-line read, not a git config
 * parser: only `[remote "<name>"]` sections and their `url =` lines matter.
 */
export function remoteUrlOfConfig(text: string): string | undefined {
  const found: { name: string; url: string }[] = [];
  let section: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/u.exec(line);
    if (header !== null) {
      section = header[1]?.toLowerCase() === 'remote' ? (header[2] ?? '') : undefined;
      continue;
    }
    const value = /^url\s*=\s*(.+)$/iu.exec(line);
    if (section !== undefined && value?.[1] !== undefined)
      found.push({ name: section, url: value[1].trim().replace(/^"(.*)"$/u, '$1') });
  }
  return (found.find(entry => entry.name === 'origin') ?? found[0])?.url;
}
