import type { PinnedWorkingDirectory } from '@ferretry/kernel/contract';

/**
 * How Git is asked for a tree's file names, in ONE place (&F6061 U2): the hardened arguments, the scrubbed
 * environment, and the one question a file index puts to Git — "which names are not ignored?".
 *
 * WHY THIS IS CONTRACT CODE. A ferret's file index and a project's file index must agree on what Git ignores and on
 * how Git is held at arm's length. Git is spawned through the kernel, which hands a held folder only to the plugin
 * whose root minted it, so each plugin runs its own Git child; what they share is the rule, and the rule lives here.
 * Nothing in this file starts a process: the caller passes the runner, which is the kernel's spawn behind a thin
 * wrapper.
 */

/**
 * The arguments every Git child of this product gets, before the subcommand.
 *
 * `core.hooksPath=/dev/null` and `core.fsmonitor=false` close the two config keys that make a read run a program from a
 * repository the owner did not write; the rest keep porcelain output the shape the parsers expect.
 */
export const HARDENED_GIT_ARGUMENTS: readonly string[] = [
  '--no-optional-locks',
  '-c',
  'core.pager=cat',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=false',
  '-c',
  'diff.external=',
  // Porcelain paths must stay repo-root-relative whatever a repo-local `status.relativePaths=true` says,
  // because that is the shape the status parser filters by prefix. And `showUntrackedFiles=all` is pinned
  // because a repo-local or global `no` would otherwise hide every untracked file from a Changes list.
  '-c',
  'status.relativePaths=false',
  '-c',
  'status.showUntrackedFiles=all',
] as const;

/**
 * The environment of a Git child: the caller's own, minus every `GIT_*` name, with the configuration closed.
 *
 * `GIT_CONFIG_GLOBAL` is `/dev/null` so a hostile global config can run nothing. `readsGlobalConfig` is for the questions
 * that must see the owner's exclusions (the file list and the read that proves the config readable): Git then reads the
 * global config itself. That stays safe because every key that can run a program (`core.fsmonitor`, `core.hooksPath`,
 * `core.pager`, `diff.external`) is pinned by `-c` ({@link HARDENED_GIT_ARGUMENTS}), which outranks any config file, and
 * a repository's own config — the more hostile of the two — is read regardless.
 */
export function gitEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  literalPathspecs: boolean,
  readsGlobalConfig = false,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!key.startsWith('GIT_') && value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_SYSTEM: '/dev/null',
    ...(readsGlobalConfig ? {} : { GIT_CONFIG_GLOBAL: '/dev/null' }),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_ASKPASS: '',
    ...(literalPathspecs ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
  };
}

/** A Git child's working directory: a folder name, or a directory held open by the kernel's pin. */
export type TreeGitDirectory = string | PinnedWorkingDirectory;

/** One Git command. A subset of the daemon's `GitInvocation`, so that runner satisfies {@link TreeGitRunner}. */
export interface TreeGitInvocation {
  readonly args: readonly string[];
  readonly cwd: TreeGitDirectory;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  /** Off only for the command that may see the owner's global config; see {@link gitEnvironment}. */
  readonly readsGlobalConfig?: true;
}

/** What a finished Git child left, as the kernel's `runBytes` reports it. */
export interface TreeGitExecution {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
}

/**
 * The error for a Git command that did not answer: `action` names it (`git ls-files`), `execution` is what it left.
 * A caller that wants its own error type (the daemon's `GitCommandError`) passes one; the default is a plain `Error`.
 */
export type TreeGitFailure = (action: string, execution: TreeGitExecution) => Error;

const defaultFailure: TreeGitFailure = (action, execution) =>
  new Error(
    execution.timedOut
      ? `${action} timed out`
      : `${action} failed: ${execution.stderr.trim() || `exit ${String(execution.exitCode)}`}`,
  );

/** The only process capability a file index has. */
export interface TreeGitRunner {
  run(invocation: TreeGitInvocation): Promise<TreeGitExecution>;
}

/** What is left of a budget, for a child that is about to start. */
export interface TreeGitBudget {
  /** Has the deadline passed, or has the caller gone away? */
  expired(): boolean;
  /** Milliseconds left; zero exactly when {@link expired} is true. */
  remainingMs(): number;
}

/**
 * Every unexcluded path beneath a working directory, in ONE answer.
 *
 * `paths` are relative to the directory, in Git's order, each name once. `truncated` means Git's own output hit the
 * caller's byte cap, so the list is short by an amount nobody can know without asking again.
 */
export interface TreeFileList {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

/** The Git questions a file index asks. */
export interface TreeGit {
  /**
   * Is this directory inside a Git work tree? A `budget` that has expired answers `false` without a child; the caller
   * re-asks it before trusting that.
   */
  isInsideWorkTree(cwd: TreeGitDirectory, budget?: TreeGitBudget): Promise<boolean>;
  /** The file list; throws when Git could not answer, and the index turns that into an `unreadable` skip. */
  listFiles(cwd: TreeGitDirectory, maxBytes: number, budget?: TreeGitBudget): Promise<TreeFileList>;
}

const NUL = String.fromCharCode(0);

/**
 * `git ls-files -z` output as paths: NUL-terminated records, deduplicated (`--cached` reports a conflicted path once
 * per merge stage), and with an unterminated tail dropped when Git's output was cut by the byte cap — that tail is half
 * a name, which would put a file that does not exist into a search index.
 */
export function parseFileList(stdout: string, truncated: boolean): readonly string[] {
  const records = stdout.split(NUL);
  if (truncated && !stdout.endsWith(NUL)) records.pop();
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record === '' || seen.has(record)) continue;
    seen.add(record);
    paths.push(record);
  }
  return paths;
}

/**
 * Git's own words for "I could not read a file that holds a rule": a config, an include, an ignore or exclude file.
 *
 * Git reports these as a WARNING and carries on, so an `ls-files` that exits 0 can still have applied none of the rules
 * in the file it could not read. That is a list showing exactly what the owner told Git to hide, so it is a failure.
 */
const UNREADABLE_RULES = /unable to access|permission denied|could not open|cannot open|bad config|fatal:/i;

/**
 * Establishes that the owner's global configuration — and everything it includes — can be read, or THROWS.
 *
 * Git itself resolves `core.excludesFile` (and its default `~/.config/git/ignore`): a repository's own setting beats the
 * global one, `include.path` is honoured, `~` is expanded. Nothing here re-implements that, because a second
 * implementation is a second place for precedence to be wrong. What Git does NOT do is fail when it cannot read a file:
 * an unreadable `~/.gitconfig` is skipped without a word. So the one thing asked here is whether it was read.
 * `git config --global --includes --list` exits 0 when it was, 128 with only "No such file or directory" when there is
 * none (no file, no rules: not an error), and anything else — a permission error, a malformed line, an unreadable
 * include — means a rule may exist that cannot be applied.
 *
 * `--global` lists `~/.gitconfig` ALONE whenever that file exists, and Git skips an unreadable
 * XDG config (`$XDG_CONFIG_HOME/git/config`, else `~/.config/git/config`) in silence — while `ls-files` still reads it. A
 * readable `~/.gitconfig` next to a mode-000 XDG config would therefore pass the read above and list a name the owner
 * ignores globally. So EVERY file Git names is also read on its own, by absolute path
 * (`git config --file <abs> --includes --list -z`): only a clean read or a missing file passes. Which files are active
 * is decided by the Git child itself, from its own environment (`git var GIT_CONFIG_GLOBAL`: the XDG path, then
 * `~/.gitconfig`, one per line): no plugin reads the environment, and a daemon with a custom `XDG_CONFIG_HOME` is
 * covered while an unreadable INACTIVE default location blocks nothing. A relative path on ANY line is refused (Git
 * would resolve it against the repository), and a successful answer naming no file is incomplete, not a pass.
 * GAP: a Git that does not know `git var GIT_CONFIG_GLOBAL` (before 2.46) answers non-zero, and then only the global read
 * above is made.
 */
export async function establishGlobalConfig(
  runner: TreeGitRunner,
  cwd: TreeGitDirectory,
  budget: TreeGitBudget | undefined,
  failure: TreeGitFailure = defaultFailure,
): Promise<void> {
  const bound = (): { readonly timeoutMs?: number } => {
    const timeoutMs = spawnBound(budget);
    return timeoutMs === undefined ? {} : { timeoutMs };
  };
  const execution = await runner.run({
    args: ['config', '--global', '--includes', '--list', '-z'],
    cwd,
    readsGlobalConfig: true,
    maxStdoutBytes: 1024 * 1024,
    ...bound(),
  });
  assertConfigRead(execution, failure);

  // The budget is asked again: each child takes some of it, and an expired one starts no further child (the caller
  // re-asks it before trusting the answer).
  if (budget?.expired() === true) return;
  const located = await runner.run({
    args: ['var', 'GIT_CONFIG_GLOBAL'],
    cwd,
    readsGlobalConfig: true,
    maxStdoutBytes: 64 * 1024,
    ...bound(),
  });
  if (located.timedOut || located.stdoutTruncated) throw failure('git var', located);
  if (located.exitCode !== 0) return;
  // EVERY line is a file Git reads (the XDG config, then ~/.gitconfig): each must be absolute and each must read clean.
  // A successful answer that names none proved nothing was readable, so it is incomplete rather than a pass.
  const named = new TextDecoder()
    .decode(located.stdout)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
  if (named.length === 0) throw failure('git var', { ...located, stderr: 'no global config path reported' });
  const relative = named.find(path => !path.startsWith('/'));
  if (relative !== undefined)
    throw failure('git var', { ...located, stderr: `relative global config path: ${relative}` });

  for (const active of named) {
    if (budget?.expired() === true) return;
    const read = await runner.run({
      args: ['config', '--file', active, '--includes', '--list', '-z'],
      cwd,
      readsGlobalConfig: true,
      maxStdoutBytes: 1024 * 1024,
      ...bound(),
    });
    assertConfigRead(read, failure);
  }
}

/** A config read that was clean, or whose only complaint is that the file is not there; anything else THROWS. */
function assertConfigRead(execution: TreeGitExecution, failure: TreeGitFailure): void {
  if (execution.timedOut || execution.stdoutTruncated) throw failure('git config', execution);
  const lines = execution.stderr.split('\n').filter(line => line.trim() !== '');
  const clean = execution.exitCode === 0 && lines.length === 0;
  const absent =
    execution.exitCode === 128 && lines.length > 0 && lines.every(line => line.includes('No such file or directory'));
  if (!clean && !absent) throw failure('git config', execution);
}

/** What is left of a budget, as the runner's own timeout; nothing without one. Rounded up: zero would mean "kill now". */
function spawnBound(budget: TreeGitBudget | undefined): number | undefined {
  return budget === undefined ? undefined : Math.ceil(budget.remainingMs());
}

/**
 * The Git questions a file index asks, over a runner.
 *
 * Stateless: Git reads the owner's config on every list, so an edit to `~/.gitconfig` is seen by the next index rather
 * than after a restart.
 */
export function treeGit(runner: TreeGitRunner, failure: TreeGitFailure = defaultFailure): TreeGit {
  return {
    async isInsideWorkTree(cwd, budget) {
      // No command was asked, so "not a repository" is the placeholder the caller must re-check against its budget.
      if (budget?.expired() === true) return false;
      const timeoutMs = spawnBound(budget);
      const execution = await runner.run({
        args: ['rev-parse', '--is-inside-work-tree'],
        cwd,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      // Git says "not a git repository" with exit 128, and so does it say "dubious ownership" and a broken repository:
      // only the first is "no", so the others throw rather than being walked as though no ignore rule existed.
      const notARepository = execution.exitCode === 128 && execution.stderr.includes('not a git repository');
      if (execution.timedOut || (execution.exitCode !== 0 && !notARepository))
        throw failure('git rev-parse', execution);
      return execution.exitCode === 0 && new TextDecoder().decode(execution.stdout).trim() === 'true';
    },
    async listFiles(cwd, maxBytes, budget) {
      // No command was asked, so the empty list is explicitly incomplete rather than confidently empty.
      if (budget?.expired() === true) return { paths: [], truncated: true };
      await establishGlobalConfig(runner, cwd, budget, failure);
      // The budget is asked again: the config read took some of it, and an expired one starts no second child.
      if (budget?.expired() === true) return { paths: [], truncated: true };
      const timeoutMs = spawnBound(budget);
      // Git resolves the owner's exclusions itself, from the owner's own HOME and XDG variables. No `-c core.excludesFile`
      // is ever passed: such an override outranks a repository's own setting, which is not Git's precedence.
      const execution = await runner.run({
        args: ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        cwd,
        readsGlobalConfig: true,
        maxStdoutBytes: maxBytes,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      if (execution.timedOut || execution.exitCode !== 0 || UNREADABLE_RULES.test(execution.stderr))
        throw failure('git ls-files', execution);
      return {
        paths: parseFileList(new TextDecoder().decode(execution.stdout), execution.stdoutTruncated),
        truncated: execution.stdoutTruncated,
      };
    },
  };
}
