import { MAX_PROJECT_REPOS, type ProjectRepo } from '../../../contract/index.ts';
import { belowHome, isAtOrUnder, isPrivateFolder } from '../folders/fence.ts';
import type { FolderBrowser, FolderVerdict } from '../folders/port.ts';
import { describeRemote, remoteUrlOfConfig } from './remote.ts';

/** How far below the project folder a repository is looked for: a repository at most this many names down (the folder itself is 0). */
const MAX_SCAN_DEPTH = 3;
/** The most folders one scan opens: the bound that keeps a huge tree from holding the daemon. */
export const MAX_SCAN_FOLDERS = 400;
/** The most names read from one folder. */
const READ_LIMIT = 2000;
/** The most of a `.git/config` that is read. */
export const CONFIG_READ_LIMIT = 64 * 1024;

/** Folders never entered: a dependency tree holds repositories that are not the owner's. */
const SKIPPED = new Set(['node_modules']);

export interface ScanDeps {
  /** B6's folder port: holds folders open, never lists a link, refuses a folder the verdict does not accept. */
  readonly browser: FolderBrowser;
  /** The text of `<repo>/.git/config` (at most {@link CONFIG_READ_LIMIT} bytes), or `undefined` when it cannot be read. */
  readonly readConfig: (repo: string) => Promise<string | undefined>;
}

export interface ScanResult {
  readonly repos: readonly Omit<ProjectRepo, 'account'>[];
  readonly truncated: boolean;
}

/**
 * Finds the git repositories inside a project folder: breadth first, at most {@link MAX_SCAN_DEPTH} levels down, at most
 * {@link MAX_SCAN_FOLDERS} folders opened and {@link MAX_PROJECT_REPOS} repositories kept. A link is never followed (the
 * port lists none and holds every folder open), a folder whose REAL place is outside the project or is a private folder
 * (`fence.ts`) is skipped, hidden folders and `node_modules` are not entered, and a repository is not entered either (what is
 * inside one is its own business; a project folder that is itself a repository answers just itself).
 */
export async function scanRepos(root: string, deps: ScanDeps): Promise<ScanResult> {
  const { browser } = deps;
  const [rootReal] = await browser.realPaths([root]);
  if (rootReal === undefined) return { repos: [], truncated: false };
  const home = await browser.home();
  const verdict: FolderVerdict = async real => {
    if (!isAtOrUnder(real, rootReal)) return 'outside';
    const below = belowHome(real, home);
    return below !== undefined && isPrivateFolder(below) ? 'private' : undefined;
  };

  const found: string[] = [];
  let truncated = false;
  let opened = 0;
  let queue: { abs: string; rel: string }[] = [{ abs: rootReal, rel: '.' }];
  for (let depth = 0; depth < MAX_SCAN_DEPTH && queue.length > 0 && !truncated; depth++) {
    const next: { abs: string; rel: string }[] = [];
    for (const item of queue) {
      if (opened === MAX_SCAN_FOLDERS) {
        truncated = true;
        break;
      }
      opened++;
      const held = await browser.open(item.abs, verdict);
      if (!held.ok) continue;
      const folder = held.folder;
      try {
        if (depth === 0 && (await folder.lookup('.git')) === 'present') {
          found.push('.');
          break;
        }
        const read = await folder.entries(READ_LIMIT);
        if (read === undefined) continue;
        if (read.more) truncated = true;
        for (const entry of read.entries) {
          if (entry.kind !== 'directory' || entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
          const rel = item.rel === '.' ? entry.name : `${item.rel}/${entry.name}`;
          if (await folder.hasGit(entry.name)) {
            if (found.length === MAX_PROJECT_REPOS) {
              truncated = true;
              break;
            }
            found.push(rel);
          } else if (depth + 1 < MAX_SCAN_DEPTH)
            next.push({ abs: `${item.abs === '/' ? '' : item.abs}/${entry.name}`, rel });
        }
      } finally {
        await folder.close();
      }
    }
    queue = next;
  }

  const repos: Omit<ProjectRepo, 'account'>[] = [];
  for (const rel of [...found].sort()) {
    const text = await deps.readConfig(rel === '.' ? rootReal : `${rootReal}/${rel}`);
    const url = text === undefined ? undefined : remoteUrlOfConfig(text);
    const described = url === undefined ? undefined : describeRemote(url);
    repos.push({ path: rel, ...(described ?? {}) });
  }
  return { repos, truncated };
}
