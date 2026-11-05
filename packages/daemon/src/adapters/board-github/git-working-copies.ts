import { constants, type Stats } from 'node:fs';
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
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
/** The branch a reftable repository's `HEAD` file names to keep old readers away from it. */
const PLACEHOLDER_BRANCH = 'refs/heads/.invalid';
/**
 * The `GIT_*` variables that change nothing about WHICH repository or config git reads. Every other one
 * (`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_*`, `GIT_CEILING_DIRECTORIES`, …) may send git to
 * metadata the filesystem walk below does not see, so its presence turns the kept answers off.
 */
const HARMLESS_GIT_VARIABLES: ReadonlySet<string> = new Set([
  'GIT_TERMINAL_PROMPT',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_EDITOR',
  'GIT_PAGER',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);

type Question = 'repository' | 'branch';
type Environment = Readonly<Record<string, string | undefined>>;

interface Remembered {
  /** The identity of the files git reads for this question, when the answer was asked for. */
  readonly files: string;
  readonly askedAtMs: number;
  readonly answer: Promise<string | null>;
}

/** A repository this adapter fully understands: its git dir and the common dir that holds the shared config. */
interface Repository {
  /** The PHYSICAL git dir (`HEAD`, and a linked worktree's `config.worktree`, live here). */
  readonly gitDirectory: string;
  /** The PHYSICAL common dir: the git dir itself, or where a linked worktree's `commondir` leads. */
  readonly common: string;
}

const exists = async (path: string): Promise<boolean> =>
  await lstat(path).then(
    () => true,
    () => false,
  );

/** The identity of a file as a `stat` sees it, or `none` for one that is not there. */
async function fileIdentity(path: string): Promise<string> {
  try {
    const information = await stat(path);
    return `${String(information.dev)}:${String(information.ino)}:${String(information.size)}:${String(information.mtimeMs)}`;
  } catch {
    return 'none';
  }
}

/**
 * Whether the environment git is spawned with can steer it to repository or config metadata the files below do
 * not show. Conservative by design: every `GIT_*` variable but a known harmless few counts.
 */
function steersGit(environment: Environment): boolean {
  return Object.keys(environment).some(name => name.startsWith('GIT_') && !HARMLESS_GIT_VARIABLES.has(name));
}

/** What a candidate git directory turned out to be, as far as this adapter can tell. */
type Candidate =
  | Repository
  /** Git certainly takes it for no repository — something it is missing — and walks on past it. */
  | 'absent'
  /** Git may take it for one, or it cannot be read exactly: never vouched for, and never walked past. */
  | 'unclear';

/** The prefix of a `.git` file; the path follows it verbatim. */
const GITFILE_PREFIX = 'gitdir: ';
/** What git strips from the end of a `.git` file or a `commondir` (it loops over both); nothing else is ever stripped. */
const LINE_ENDINGS = /[\r\n]+$/u;
/**
 * A `HEAD` git takes for one (`validate_headref`): a symref into `refs/`, or a full object id. NARROWER than git
 * on purpose — git also takes `ref:` without the space and an id with anything after it, and a `HEAD` this does
 * not know is one it does not vouch for.
 */
const VALID_HEAD = /^(?:ref: refs\/[^\0\r\n]+|[0-9a-f]{40}|[0-9a-f]{64})\n?$/iu;

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

/**
 * The text of an OPTIONAL config file: empty when it is genuinely not there, `undefined` when it cannot be read
 * for any other reason. A file that is there but unreadable (`EACCES`) says nothing about what it holds, so the
 * caller must treat the repository as unrecognised rather than as one without that file — its `stat` identity
 * would still match a kept answer.
 */
async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    return isMissing(error) ? '' : undefined;
  }
}

/** What looking at a path found: its `Stats`, `missing` when it is not there, `unreadable` for any other failure. */
async function look(path: string, followLinks: boolean): Promise<Stats | 'missing' | 'unreadable'> {
  try {
    return await (followLinks ? stat(path) : lstat(path));
  } catch (error) {
    return isMissing(error) ? 'missing' : 'unreadable';
  }
}

/** The text of `bytes`, or `undefined` when UTF-8 cannot carry them back unchanged (a path through them would name another). */
function exactText(bytes: Buffer): string | undefined {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined;
}

/**
 * The physical place a pointer (the text of a `.git` file or a `commondir`) leads to, or `undefined` when the
 * filesystem cannot say. The pointer is NOT normalised: `..` after a symlink leads somewhere other than the
 * directory above the link's name, so the text goes to `realpath` as it is and the filesystem does the
 * traversing, as it does for git. A relative pointer is relative to `base`.
 */
async function traverse(pointer: string, base: string): Promise<string | undefined> {
  return await realpath(isAbsolute(pointer) ? pointer : `${base}/${pointer}`).catch(() => undefined);
}

/** Where a git dir keeps the files of the repository it belongs to: itself, or where its `commondir` leads. */
async function commonDirectory(gitDirectory: string): Promise<string | undefined> {
  const file = join(gitDirectory, 'commondir');
  if ((await look(file, false)) === 'missing') return gitDirectory;
  const bytes = await readFile(file).catch(() => undefined);
  const pointer = bytes === undefined || bytes.length === 0 ? undefined : exactText(bytes)?.replace(LINE_ENDINGS, '');
  return pointer === undefined ? undefined : await traverse(pointer, gitDirectory);
}

/** Whether a directory is one git's `access(X_OK)` lets through (and this reads), `absent` when it is not there. */
async function directoryState(path: string): Promise<'usable' | 'absent' | 'unclear'> {
  const found = await look(path, true);
  if (found === 'missing') return 'absent';
  if (found === 'unreadable' || !found.isDirectory()) return 'unclear';
  return await access(path, constants.R_OK | constants.X_OK).then(
    () => 'usable',
    () => 'unclear',
  );
}

/**
 * The repository a candidate git directory is, only when it is COMPLETE and VALID the way git's own
 * `is_git_directory` wants: in the git dir a `HEAD` that reads as a symref into `refs/` or an object id, and in
 * its common dir accessible `objects/` and `refs/`. A candidate git certainly rejects for lacking a part is
 * `absent`; one that has every part but that this cannot vouch for (a `HEAD` of another shape, an inaccessible
 * directory, a pointer that does not resolve exactly) is `unclear` — git may reject it and walk on, or not,
 * and either way answering from the repository above it could be wrong.
 *
 * Both directories are resolved through `realpath` BEFORE the common dir is followed: git reaches a linked
 * worktree's directory through any symlink first and only then applies `commondir`'s `..`, so normalising the
 * `..` textually would name a different directory.
 */
async function asRepository(candidate: string): Promise<Candidate> {
  const gitDirectory = await realpath(candidate).catch(() => undefined);
  if (gitDirectory === undefined) return 'unclear';
  const head = join(gitDirectory, 'HEAD');
  const headFound = await look(head, false);
  if (headFound === 'missing') return 'absent';
  if (headFound === 'unreadable' || !headFound.isFile()) return 'unclear';
  const common = await commonDirectory(gitDirectory);
  if (common === undefined) return 'unclear';
  const parts = await Promise.all([directoryState(join(common, 'objects')), directoryState(join(common, 'refs'))]);
  if (parts.includes('absent')) return 'absent';
  const headRead = await readFile(head, 'utf8').catch(() => '');
  return parts.every(part => part === 'usable') && VALID_HEAD.test(headRead) ? { gitDirectory, common } : 'unclear';
}

/**
 * What a `.git` entry in `folder` points at: itself when a directory, the `gitdir:` of a file, else nothing. The
 * path is the file's text as git reads it — after the prefix, minus the trailing line ending, spaces and all —
 * and is left unresolved for {@link asRepository} to hand to the filesystem.
 */
async function pointedAt(folder: string, dotGit: string): Promise<string | undefined> {
  const information = await stat(dotGit).catch(() => undefined);
  if (information?.isDirectory() === true) return dotGit;
  if (information?.isFile() !== true) return undefined;
  const bytes = await readFile(dotGit).catch(() => undefined);
  const text = bytes === undefined ? undefined : exactText(bytes);
  if (text?.startsWith(GITFILE_PREFIX) !== true) return undefined;
  const pointer = text.slice(GITFILE_PREFIX.length).replace(LINE_ENDINGS, '');
  if (pointer === '') return undefined;
  return isAbsolute(pointer) ? pointer : `${folder}/${pointer}`;
}

/**
 * The repository `git -C <folder>` would use, or `undefined` for anything that is not the plain, complete shape.
 *
 * The folder is the PHYSICAL one (`realpath`): git changes into it and walks up from where it finds itself, so
 * a link to a folder of another repository is that repository's, not that of the folder holding the link.
 *
 * An ALLOWLIST: the nearest `.git` ends the walk, and it must be a complete, valid git dir (or a `gitdir:` file /
 * link leading to one) — an incomplete or invalid one, a dangling link or a socket is a boundary this cannot
 * read, and walking past it would answer from an enclosing repository git may not use. A folder that is itself
 * a git dir, or that this cannot tell from one (a bare repository, or somewhere inside `.git`), is likewise
 * left to git: it uses that, not what encloses it. Only a folder git certainly takes for no repository is
 * walked out of.
 */
async function repositoryAt(physicalFolder: string): Promise<Repository | undefined> {
  let folder = physicalFolder;
  for (;;) {
    const dotGit = join(folder, '.git');
    if (await exists(dotGit)) {
      const target = await pointedAt(folder, dotGit);
      const repository = target === undefined ? undefined : await asRepository(target);
      return typeof repository === 'object' ? repository : undefined;
    }
    if ((await asRepository(folder)) !== 'absent') return undefined;
    const parent = dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
}

/**
 * Whether a config file hands part of itself to another: an `[include]` or `[includeIf "…"]` section.
 * Deliberately loose — a comment that mentions one is a false positive, which only costs a kept answer.
 */
const INCLUDES = /\[\s*include(?:if)?[\s"\]]/iu;
/** What follows the key of an `extensions.refStorage` that names the files backend (git matches the value exactly). */
const FILES_STORAGE = /^\s*=\s*files\s*(?:[#;].*)?$/u;

/**
 * Whether the refs live in plain files under the git dir — the one place `HEAD` can vouch for the branch.
 *
 * A `reftable` repository keeps `HEAD` as a constant placeholder (`ref: refs/heads/.invalid`) and the real
 * branch in a table: a checkout rewrites the table and leaves `HEAD` byte-identical, so a kept answer would
 * outlive it. Only the files backend is POSITIVELY recognised — no `reftable` directory, a `HEAD` that is not
 * the placeholder, and EVERY `extensions.refStorage` in the config says `files` (git takes the last, so a
 * later unknown one must not hide behind an earlier `files`; an `include` could add one unseen) — so a ref
 * storage this does not know is asked every time rather than trusted.
 */
async function refsAreFiles({ gitDirectory, common }: Repository): Promise<boolean> {
  if ((await exists(join(gitDirectory, 'reftable'))) || (await exists(join(common, 'reftable')))) return false;
  // `HEAD` was there a moment ago (see {@link asRepository}); one that cannot be read now is not vouched for.
  const headText = await readFile(join(gitDirectory, 'HEAD'), 'utf8').catch(() => undefined);
  if (headText === undefined || headText.includes(PLACEHOLDER_BRANCH)) return false;
  for (const config of [join(common, 'config'), join(gitDirectory, 'config.worktree')]) {
    const contents = await optionalText(config);
    if (contents === undefined) return false;
    // Git honours the LAST `extensions.refStorage` and may find one in an included file, so neither the first
    // occurrence nor this file alone can vouch for the backend.
    if (INCLUDES.test(contents)) return false;
    for (const occurrence of contents.matchAll(/refstorage\b([^\n]*)/giu))
      if (!FILES_STORAGE.test(occurrence[1] ?? '')) return false;
  }
  return true;
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
 * A kept answer must never outlive a change git itself would see, so the cache is an ALLOWLIST: it is used
 * only for a repository recognised as the plain, fully understood shape, and EVERYTHING else asks git every
 * time, as before. Not recognised: an environment with a `GIT_*` variable that steers git (`GIT_DIR`,
 * `GIT_COMMON_DIR`, `GIT_CONFIG_*`, …); a folder that is gone; the nearest `.git` being incomplete (no
 * `objects/` or `refs/`), dangling or not a git dir, or the folder being a bare repository or inside a git
 * dir; a config with an `include` or `includeIf` (the files it reaches are not watched); a legacy
 * `remotes/origin` or `branches/origin` file; a branch in a repository whose refs are not plain files
 * (`reftable` leaves `HEAD` untouched by a checkout); and a question git answered with nothing.
 */
export class GitWorkingCopies implements WorkingCopies {
  private readonly hosts = new Map<string, Promise<string | null>>();
  private readonly remembered = new Map<string, Remembered>();

  constructor(
    private readonly gitBinary = 'git',
    private readonly sshBinary = 'ssh',
    private readonly nowMs: () => number = Date.now,
    private readonly rememberedFolders = REMEMBERED_FOLDERS,
    /** What git and ssh are spawned with; also what decides whether anything in it steers git. */
    private readonly environment: Environment = process.env,
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
   * `HEAD`, and one `HEAD` alone cannot vouch for. `--no-recurse` stops at what `HEAD` itself holds: followed
   * through a symbolic branch ref, the answer would move with a file `HEAD` knows nothing of.
   */
  private async askBranch(path: string): Promise<string | null> {
    const ref = await this.git(path, ['symbolic-ref', '--quiet', '--no-recurse', 'HEAD']);
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
    if (this.remembered.size >= this.rememberedFolders) {
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
   * The identity of the files git reads to answer `question` for `path`; `undefined` when the repository is
   * not recognisably the plain shape those files can vouch for (see {@link GitWorkingCopies}).
   */
  private async filesBehind(question: Question, path: string): Promise<string | undefined> {
    if (steersGit(this.environment)) return undefined;
    // `git -C` fails in a folder that is gone, however unchanged the repository above it.
    const physical = await realpath(path).catch(() => undefined);
    if (physical === undefined || (await stat(physical).catch(() => undefined))?.isDirectory() !== true)
      return undefined;
    const repository = await repositoryAt(physical);
    if (repository === undefined) return undefined;
    const { gitDirectory, common } = repository;
    const head = join(gitDirectory, 'HEAD');
    if (question === 'branch') {
      // The branch is the refs' to say, and only the files backend puts it in `HEAD`.
      return (await refsAreFiles(repository)) ? `${gitDirectory}\n${await fileIdentity(head)}` : undefined;
    }
    // Git reads these as an `origin` too, and nothing here would see them change.
    if ((await exists(join(common, 'remotes', 'origin'))) || (await exists(join(common, 'branches', 'origin'))))
      return undefined;
    const configs = [join(common, 'config'), join(gitDirectory, 'config.worktree')];
    // `includeIf "onbranch:…"` makes the remote depend on `HEAD`; an `include` makes it depend on files that
    // change without either config changing. Which files an `includeIf` reaches is git's to decide, so a
    // config with one is asked every time rather than guessed at.
    for (const config of configs) {
      const contents = await optionalText(config);
      if (contents === undefined || INCLUDES.test(contents)) return undefined;
    }
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
      const child = Bun.spawn([...command], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        env: { ...this.environment },
      });
      const output = (await new Response(child.stdout).text()).trim();
      return (await child.exited) === 0 && output !== '' ? output : null;
    } catch {
      return null;
    }
  }
}
