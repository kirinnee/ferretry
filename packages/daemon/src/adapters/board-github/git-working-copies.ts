import { lstat, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { githubRepositoryOf, parseGitRemote, type WorkingCopies } from '../../lib/board-github/index.ts';

/**
 * How long an answer is kept while the files git reads for it are unchanged.
 *
 * A BACKSTOP, NOT THE RULE. The files are what decide (see {@link GitWorkingCopies}); this bounds what they
 * cannot show — a `url.<base>.insteadOf` in the user's global config rewrites what `remote get-url` prints
 * without touching the checkout — to a few minutes, which a card's PR link can wait.
 */
const REMEMBERED_FOR_MS = 10 * 60_000;
/** How many folders' answers are kept; the oldest is let go past it. */
const REMEMBERED_FOLDERS = 512;
const BRANCHES = 'refs/heads/';

type Question = 'repository' | 'branch';

interface Remembered {
  /** The identity of the files git reads for this question, when the answer was asked for. */
  readonly files: string;
  readonly askedAtMs: number;
  readonly answer: Promise<string | null>;
}

/** The identity of a file as a `stat` sees it, or `none` for one that is not there. */
async function fileIdentity(path: string): Promise<string> {
  try {
    const information = await stat(path);
    return `${String(information.dev)}:${String(information.ino)}:${String(information.size)}:${String(information.mtimeMs)}`;
  } catch {
    return 'none';
  }
}

/** A git dir's common dir: where a linked worktree's shared config lives, or the git dir itself. */
async function commonDirectory(gitDirectory: string): Promise<string> {
  const named = await readFile(join(gitDirectory, 'commondir'), 'utf8').catch(() => undefined);
  return named === undefined ? gitDirectory : resolve(gitDirectory, named.trim());
}

/**
 * Whether a config file hands part of itself to another: an `[include]` or `[includeIf "…"]` section.
 * Deliberately loose — a comment that mentions one is a false positive, which only costs a kept answer.
 */
const INCLUDES = /\[\s*include(?:if)?[\s"\]]/iu;

/**
 * The git dir `git -C <path>` would use: the nearest `.git` at or above the folder — a directory (or a
 * symlink to one), or a linked worktree's `gitdir:` file — or `undefined` where there is none to find.
 *
 * A `.git` entry of ANY kind ends the search: one that is neither (a dangling link, a socket) is a
 * boundary this cannot read, and walking past it would answer from the enclosing repository's files.
 */
async function gitDirectoryOf(path: string): Promise<string | undefined> {
  let folder = resolve(path);
  for (;;) {
    const dotGit = join(folder, '.git');
    if (
      await lstat(dotGit).then(
        () => true,
        () => false,
      )
    ) {
      const information = await stat(dotGit).catch(() => undefined);
      if (information?.isDirectory() === true) return dotGit;
      if (information?.isFile() !== true) return undefined;
      const pointer = /^gitdir: (.+)$/mu.exec(await readFile(dotGit, 'utf8').catch(() => ''));
      return pointer?.[1] === undefined ? undefined : resolve(folder, pointer[1].trim());
    }
    const parent = dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
}

/**
 * Asks git about a folder: the GitHub repository its `origin` names, and the branch it has checked out.
 *
 * An SSH `origin` may name a host alias (`github-personal:kirinnee/ferretry.git`); ssh itself says where the
 * alias goes (`ssh -G <alias>` prints the `hostname` it resolves to, reading the user's ssh config, and
 * connects to nothing). Each alias is asked once per adapter.
 *
 * EACH ANSWER IS KEPT WHILE THE FILES GIT READ FOR IT ARE THE SAME. The board's GitHub watch asks both
 * questions for every linked card on every tick, and each was a `git` process: on a host with eighteen such
 * cards, seventy-two a minute, every one forked from the event loop — and under memory pressure one fork
 * blocked the loop for seconds. The branch is the checkout's `HEAD`, the remote is its config (the common
 * dir's `config`, and a linked worktree's `config.worktree`) read with that `HEAD` — an `includeIf
 * "onbranch:…"` makes one depend on the other; git rewrites each by renaming a new file over it, so a
 * checkout, a `remote set-url` or a hand edit is a new identity and the next question asks git again.
 *
 * A kept answer must never outlive a change git itself would see, so these are asked every time, as before:
 * a folder that is gone or whose git dir cannot be found or is not one, a config with an `include` or
 * `includeIf` (the files it reaches are not watched), and a question git answered with nothing.
 */
export class GitWorkingCopies implements WorkingCopies {
  private readonly hosts = new Map<string, Promise<string | null>>();
  private readonly remembered = new Map<string, Remembered>();

  constructor(
    private readonly gitBinary = 'git',
    private readonly sshBinary = 'ssh',
    private readonly nowMs: () => number = Date.now,
  ) {}

  async repositoryOf(path: string): Promise<string | null> {
    return await this.answer('repository', path, async () => await this.askRepository(path));
  }

  async branchOf(path: string): Promise<string | null> {
    return await this.answer('branch', path, async () => await this.askBranch(path));
  }

  /**
   * The branch `HEAD` names. Read from the FULL ref, not `--short`: git shortens it against every other ref,
   * so a tag of the same name makes `--short` print `heads/<name>` — an answer that depends on files other than
   * `HEAD`, and one `HEAD` alone cannot vouch for.
   */
  private async askBranch(path: string): Promise<string | null> {
    const ref = await this.git(path, ['symbolic-ref', '--quiet', 'HEAD']);
    return ref?.startsWith(BRANCHES) === true ? ref.slice(BRANCHES.length) : null;
  }

  /** The kept answer while the files behind it are unchanged and it is young enough, else a fresh one. */
  private async answer(question: Question, path: string, ask: () => Promise<string | null>): Promise<string | null> {
    // Taken BEFORE git is asked, so a change landing while it runs is a different identity next time.
    const files = await this.filesBehind(question, path);
    if (files === undefined) return await ask();
    const key = `${question}\n${path}`;
    const known = this.remembered.get(key);
    const nowMs = this.nowMs();
    if (known !== undefined && known.files === files && nowMs - known.askedAtMs < REMEMBERED_FOR_MS)
      return await known.answer;
    this.remembered.delete(key);
    if (this.remembered.size >= REMEMBERED_FOLDERS) {
      const oldest = this.remembered.keys().next().value;
      if (oldest !== undefined) this.remembered.delete(oldest);
    }
    const answer = ask();
    const remembered: Remembered = { files, askedAtMs: nowMs, answer };
    this.remembered.set(key, remembered);
    const answered = await answer;
    // Only a real answer is kept: `null` is also what a git that could not START says, and keeping that would
    // hide the folder's branch for minutes. A detached head or a non-GitHub remote is asked again, as before.
    if (answered === null && this.remembered.get(key) === remembered) this.remembered.delete(key);
    return answered;
  }

  /**
   * The identity of the files git reads to answer `question` for `path`; `undefined` when they cannot be
   * trusted to vouch for it — the folder is gone, the git dir is not one, or the config reaches into files
   * this does not watch.
   */
  private async filesBehind(question: Question, path: string): Promise<string | undefined> {
    // `git -C` fails in a folder that is gone, however unchanged the repository above it.
    const folder = await stat(path).catch(() => undefined);
    if (folder?.isDirectory() !== true) return undefined;
    const gitDirectory = await gitDirectoryOf(path);
    if (gitDirectory === undefined) return undefined;
    const head = join(gitDirectory, 'HEAD');
    // A git dir without a `HEAD` is not one: git walks on past it, so what this found is not what git uses.
    if ((await fileIdentity(head)) === 'none') return undefined;
    if (question === 'branch') return `${gitDirectory}\n${await fileIdentity(head)}`;
    const configs = [join(await commonDirectory(gitDirectory), 'config'), join(gitDirectory, 'config.worktree')];
    // `includeIf "onbranch:…"` makes the remote depend on `HEAD`; an `include` makes it depend on files that
    // change without either config changing. Which files an `includeIf` reaches is git's to decide, so a
    // config with one is asked every time rather than guessed at.
    for (const config of configs) if (INCLUDES.test(await readFile(config, 'utf8').catch(() => ''))) return undefined;
    return `${gitDirectory}\n${(await Promise.all([head, ...configs].map(fileIdentity))).join('\n')}`;
  }

  private async askRepository(path: string): Promise<string | null> {
    const url = await this.git(path, ['remote', 'get-url', 'origin']);
    const remote = url === null ? null : parseGitRemote(url);
    if (remote === null) return null;
    const direct = githubRepositoryOf(remote, null);
    if (direct !== null || !remote.ssh) return direct;
    return githubRepositoryOf(remote, (await this.hostOf(remote.host)) ?? remote.host);
  }

  /** The host an ssh alias resolves to, or `null` when ssh could not say. */
  private async hostOf(alias: string): Promise<string | null> {
    const known = this.hosts.get(alias);
    if (known !== undefined) return await known;
    const asked = this.run([this.sshBinary, '-G', alias]).then(output => {
      const line = output?.split('\n').find(entry => entry.toLowerCase().startsWith('hostname '));
      return line === undefined ? null : line.slice('hostname '.length).trim();
    });
    this.hosts.set(alias, asked);
    return await asked;
  }

  /** git's one line of output, or `null` when it failed, printed nothing, or could not run. */
  private async git(path: string, args: readonly string[]): Promise<string | null> {
    return await this.run([this.gitBinary, '-C', path, ...args]);
  }

  /** A command's output, trimmed, or `null` when it failed, printed nothing, or could not run. */
  private async run(command: readonly string[]): Promise<string | null> {
    try {
      const child = Bun.spawn([...command], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
      const output = (await new Response(child.stdout).text()).trim();
      return (await child.exited) === 0 && output !== '' ? output : null;
    } catch {
      return null;
    }
  }
}
