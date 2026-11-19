import { MAX_PROJECT_REPOS, type ProjectRepo } from '../../../contract/index.ts';
import { isAtOrUnder } from '../folders/fence.ts';
import { folderPolicy } from '../folders/policy.ts';
import type { FolderBrowser, FolderVerdict } from '../folders/port.ts';
import { describeRemote, remoteUrlOfConfig } from './remote.ts';

/** How far below the project folder a repository is looked for: a repository at most this many names down (the folder itself is 0). */
const MAX_SCAN_DEPTH = 3;
/** The most folders one scan opens: the bound that keeps a huge tree from holding the daemon. */
export const MAX_SCAN_FOLDERS = 400;
/** The most names read from one folder. */
const READ_LIMIT = 2000;
/** The most of a `.git/config` that is read. */
const CONFIG_READ_LIMIT = 64 * 1024;

/** Folders never entered: a dependency tree holds repositories that are not the owner's. */
const SKIPPED = new Set(['node_modules']);

export interface ScanDeps {
  /** B6's folder port: holds folders open, never lists a link, refuses a folder the verdict does not accept. */
  readonly browser: FolderBrowser;
}

export interface ScanResult {
  readonly repos: readonly Omit<ProjectRepo, 'account'>[];
  /**
   * The scan did not see everything: a bound was reached, the project folder was refused or is not there, or a folder
   * could not be read. What it found is true, but what it did not find is NOT known to be gone, so it must never be taken
   * as the whole list.
   */
  readonly truncated: boolean;
}

/** A repository found and the text of its `.git/config`, read through the held folder it was found in. */
interface Found {
  readonly rel: string;
  readonly config: string | undefined;
}

/**
 * Finds the git repositories inside a project folder: breadth first, at most {@link MAX_SCAN_DEPTH} levels down, at most
 * {@link MAX_SCAN_FOLDERS} folders opened and {@link MAX_PROJECT_REPOS} repositories kept.
 *
 * The privacy policy is B6's, the one the folder explorer uses (`folders/policy.ts`), applied to the project folder and to
 * EVERY child before anything of it is looked at (not even for a `.git`): a folder whose real place is outside the project,
 * is a private folder (a link to `~/.ssh` included) or holds a sign-in file is skipped unprobed. A project folder that is
 * itself a link is refused, and no link below it is ever listed. Hidden folders and `node_modules` are not entered, and a
 * repository is not entered either (a project folder that is itself a repository answers just itself). Each `.git/config`
 * is read through the folder the repository was found in, never by name again.
 */
export async function scanRepos(root: string, deps: ScanDeps): Promise<ScanResult> {
  const { browser } = deps;
  const nothing: ScanResult = { repos: [], truncated: true };
  // The project folder itself must not be a link: what a link at the project folder reaches is not the project.
  if ((await browser.leaf(root)) !== 'present') return nothing;
  const [rootReal] = await browser.realPaths([root]);
  if (rootReal === undefined) return nothing;
  const home = await browser.home();
  const policy = await folderPolicy(browser, home);
  const inside =
    (judge: FolderVerdict): FolderVerdict =>
    async real =>
      isAtOrUnder(real, rootReal) ? judge(real) : 'outside';
  const verdict = inside(policy.verdict);
  const childVerdict = inside(policy.child);

  const found: Found[] = [];
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
      if (!held.ok) {
        // Refused on principle (outside, private) is a decision; any other refusal is a folder that could not be read.
        if (held.reason !== 'outside' && held.reason !== 'private') truncated = true;
        continue;
      }
      const folder = held.folder;
      try {
        if (depth === 0 && (await folder.lookup('.git')) === 'present') {
          found.push({ rel: '.', config: await folder.readText('.git/config', CONFIG_READ_LIMIT) });
          break;
        }
        const read = await folder.entries(READ_LIMIT);
        if (read === undefined) {
          truncated = true;
          continue;
        }
        if (read.more) truncated = true;
        for (const entry of read.entries) {
          if (entry.kind !== 'directory' || entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
          const abs = `${folder.real === '/' ? '' : folder.real}/${entry.name}`;
          // The policy first: nothing is probed (not even for a `.git`) in a folder it does not accept.
          if ((await childVerdict(abs)) !== undefined) continue;
          const rel = item.rel === '.' ? entry.name : `${item.rel}/${entry.name}`;
          if (await folder.hasGit(entry.name)) {
            if (found.length === MAX_PROJECT_REPOS) {
              truncated = true;
              break;
            }
            found.push({ rel, config: await folder.readText(`${entry.name}/.git/config`, CONFIG_READ_LIMIT) });
          } else if (depth + 1 < MAX_SCAN_DEPTH) next.push({ abs, rel });
        }
      } finally {
        await folder.close();
      }
    }
    queue = next;
  }

  const repos: Omit<ProjectRepo, 'account'>[] = [];
  for (const { rel, config } of [...found].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    const url = config === undefined ? undefined : remoteUrlOfConfig(config);
    const described = url === undefined ? undefined : describeRemote(url);
    repos.push({ path: rel, ...(described ?? {}) });
  }
  return { repos, truncated };
}
