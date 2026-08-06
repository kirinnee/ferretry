import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type DiffSide,
  EMPTY_TREE_OID,
  type GitLineStats,
  type HeadBlob,
  type HeadEntry,
  hasDiffableChange,
  parseBatchCheck,
  parseCheckIgnore,
  parseFileList,
  parseHeadTreeEntry,
  parseNumstat,
  parsePorcelainStatus,
  parseRevParse,
  type RenderedDiff,
  relabelDiffHeaders,
  type SessionChangesView,
  type SessionFileList,
  type SessionGit,
  type SessionRepoInfo,
  withLineStats,
} from '../../../lib/session/filesystem/index.ts';
import type { GitExecution, GitRunner, GitWorkingDirectory } from '../../../lib/worktrees/ports.ts';
import { decodeGitOutput, GitCommandError, requireGitExit } from '../../git/index.ts';

/**
 * The Git reads the session working-tree viewer needs, over the hardened runner.
 *
 * EVERY method takes a PINNED working directory and passes it straight through as the child's cwd. That is
 * the contract this adapter depends on and cannot itself enforce: Git only speaks pathnames, so if a caller
 * hands it a configured cwd instead of a descriptor alias, a rename plus a symlink between validation and
 * spawn makes Git answer for a different tree than the one whose paths passed the gates. The domain
 * compensates for the pathname weakness by re-walking and comparing component identities afterwards.
 *
 * `diffSnapshots` is the one method with no cwd at all, and that is the point of it — see its own comment.
 */

/** A `git diff` for this viewer never resolves the working tree by name, and never detects a rename. */
const DIFF_SAFETY: readonly string[] = [
  '-c',
  // Load-bearing security, not cosmetics. On a path inside the session cwd, rename detection prints the
  // out-of-cwd SOURCE path in the diff header and its full content in the body; an in-cwd destination must
  // render as a plain add instead. The `-c` is there so a repo-local `diff.renames=true` cannot re-enable
  // it. Deliberately NOT applied to every command: `status` derives its own rename detection from
  // `diff.renames`, and a Changes list needs renames.
  'diff.renames=false',
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-renames',
];

const NUL = String.fromCharCode(0);
const SYMLINK_MODE = 0o120000;

interface TextExecution {
  readonly execution: GitExecution;
  readonly stdout: string;
}

export class RunnerSessionGit implements SessionGit {
  constructor(private readonly runner: GitRunner) {}

  async repoInfo(cwd: GitWorkingDirectory): Promise<SessionRepoInfo> {
    // Never throws for "not a repo": that is a valid state the viewer reports so a client hides its diff
    // affordances.
    const inside = await this.text(
      'git rev-parse',
      ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--show-prefix'],
      cwd,
      [0, 128],
    );
    const facts = parseRevParse(inside.stdout);
    if (!facts.insideWorkTree) return { repo: false, prefix: '', hasHead: false };

    const head = await this.text('git rev-parse HEAD', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd, [0, 1, 128]);
    return {
      repo: true,
      ...(facts.root ? { root: facts.root } : {}),
      prefix: facts.prefix,
      hasHead: head.execution.exitCode === 0,
    };
  }

  /**
   * Every path under this working directory Git does not exclude, in one command.
   *
   * `--cached` plus `--others --exclude-standard` is tracked content plus untracked content minus
   * everything the ignore rules cover — and `--exclude-standard` is the ONLY spelling of that rule this
   * daemon should ever hold, because it is Git's own. Reimplementing `.gitignore` matching to build a
   * search index is how a build directory full of credentials ends up in one.
   *
   * Paths come back relative to THIS directory and bounded to it, which is what keeps a session started
   * in a repository subdirectory from indexing its siblings — the same containment `--relative` gives
   * the changes list, obtained here by Git's own default rather than by a flag.
   */
  async listFiles(cwd: GitWorkingDirectory, maxBytes: number): Promise<SessionFileList> {
    const execution = await this.runner.run({
      args: ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      cwd,
      maxStdoutBytes: maxBytes,
    });
    requireGitExit('git ls-files', execution);
    return {
      paths: parseFileList(decodeGitOutput(execution), execution.stdoutTruncated),
      truncated: execution.stdoutTruncated,
    };
  }

  /**
   * Which of these cwd-relative paths does gitignore cover?
   *
   * Paths go in `./`-prefixed for two reasons: it defuses pathspec magic in the one command that cannot
   * accept literal pathspecs, and it keeps a real file named `:(top)x` from aborting the whole batch. Exit
   * 1 means "none of them"; anything other than 0 or 1 means we could not tell, and THROWS — a viewer that
   * cannot prove a file is unignored must not claim it is safe to serve.
   */
  async ignoredPaths(cwd: GitWorkingDirectory, rels: readonly string[]): Promise<ReadonlySet<string>> {
    const candidates = [...new Set(rels.filter(rel => rel.length > 0))];
    if (candidates.length === 0) return new Set();
    // The gate is vacuous outside a Git tree, and `check-ignore` would exit 128 there.
    if (!(await this.repoInfo(cwd)).repo) return new Set();

    const stdin = new TextEncoder().encode(`${candidates.map(rel => `./${rel}`).join(NUL)}${NUL}`);
    const execution = await this.runner.run({
      args: ['check-ignore', '-z', '--stdin'],
      cwd,
      stdin,
      literalPathspecs: false,
    });
    if (execution.exitCode === 1 && !execution.timedOut) return new Set();
    requireGitExit('git check-ignore', execution);
    return parseCheckIgnore(decodeGitOutput(execution));
  }

  /**
   * Is this cwd-relative path itself a tracked FILE, including a staged addition?
   *
   * The exit code alone is not the answer. A pathspec naming a directory matches every record beneath it,
   * so a DELETED directory `sub/` exits 0 — and a caller would then admit `sub` as if it were one deleted
   * file and diff everything under it. So compare the records: exactly one, equal to the requested path.
   */
  async isTracked(cwd: GitWorkingDirectory, rel: string): Promise<boolean> {
    const listed = await this.text('git ls-files', ['ls-files', '--error-unmatch', '-z', '--', rel], cwd, [0, 1, 128]);
    if (listed.execution.exitCode !== 0) return false;
    const records = listed.stdout.split(NUL).filter(record => record.length > 0);
    return records.length === 1 && records[0] === rel;
  }

  async changes(cwd: GitWorkingDirectory): Promise<SessionChangesView> {
    const info = await this.repoInfo(cwd);
    if (!info.repo) return { repo: false, changes: [] };

    const status = await this.text('git status', ['status', '--porcelain=v1', '-z', '-b', '-uall'], cwd, [0]);
    const parsed = parsePorcelainStatus(status.stdout, status.execution.stdoutTruncated, info.prefix);
    const changes = hasDiffableChange(parsed.changes)
      ? withLineStats(parsed.changes, await this.lineStats(cwd, info))
      : parsed.changes;

    return {
      repo: true,
      ...(parsed.branch ? { branch: parsed.branch } : {}),
      changes,
      ...(status.execution.stdoutTruncated ? { truncated: true } : {}),
    };
  }

  /**
   * The HEAD entry for one path: its recorded mode plus its bytes.
   *
   * The mode is what a diff formatter needs so a mode change, or a symlink-to-file type change, still
   * renders.
   */
  async headEntry(cwd: GitWorkingDirectory, rel: string, maxBytes: number): Promise<HeadEntry | undefined> {
    const info = await this.repoInfo(cwd);
    if (!info.repo || !info.hasHead) return undefined;

    const listed = await this.text('git ls-tree', ['ls-tree', '-z', 'HEAD', '--', rel], cwd, [0, 128]);
    if (listed.execution.exitCode !== 0) return undefined;
    const entry = parseHeadTreeEntry(listed.stdout, rel);
    if (!entry) return undefined;

    const blob = await this.runner.run({ args: ['cat-file', 'blob', entry.oid], cwd, maxStdoutBytes: maxBytes });
    if (blob.timedOut) throw new GitCommandError('git cat-file', blob);
    if (blob.exitCode !== 0) return undefined;
    return { mode: entry.mode, bytes: blob.stdout, truncated: blob.stdoutTruncated };
  }

  /**
   * Read `HEAD:<rel>` for a "rendered before" view.
   *
   * `rel` is validated by the caller to contain no `..`, and that matters here more than anywhere: a tree
   * read never touches the working copy, so the syntactic gate is the ONLY containment this has, and
   * `HEAD:./../x` really does resolve outside a subdirectory cwd.
   */
  async readHeadBlob(cwd: GitWorkingDirectory, rel: string, maxBytes: number): Promise<HeadBlob | undefined> {
    const info = await this.repoInfo(cwd);
    if (!info.repo || !info.hasHead) return undefined;

    const stdin = new TextEncoder().encode(`HEAD:./${rel}${NUL}`);
    const check = await this.runner.run({ args: ['cat-file', '--batch-check', '-z'], cwd, stdin });
    if (check.timedOut) throw new GitCommandError('git cat-file', check);
    if (check.exitCode !== 0) return undefined;
    const reply = parseBatchCheck(decodeGitOutput(check));
    if (!reply) return undefined;
    if (reply.size > maxBytes) return { size: reply.size };

    const blob = await this.runner.run({ args: ['cat-file', 'blob', reply.oid], cwd, maxStdoutBytes: maxBytes });
    if (blob.timedOut) throw new GitCommandError('git cat-file', blob);
    if (blob.exitCode !== 0) return undefined;
    return { size: reply.size, bytes: blob.stdout };
  }

  /**
   * Render a unified diff between two byte snapshots the CALLER obtained, using Git purely as a formatter.
   *
   * This exists for containment, not convenience. `git diff HEAD -- <rel>` reads the worktree side by NAME
   * from the repository top level, so it re-resolves every component at spawn time: with a parent renamed
   * away and replaced by a symlink mid-request, Git pairs the pinned repo's index entry with bytes from the
   * other tree and emits a diff that MIXES both. Passing a pinned parent as cwd does not help, because Git
   * converts the pathspec to a top-level-relative path first. Neither side here is a name Git resolves:
   * both are bytes already read through the pinned descriptor chain and staged into a private scratch
   * directory, and `--no-index` then diffs those two files and nothing else.
   */
  async diffSnapshots(
    rel: string,
    oldSide: DiffSide | undefined,
    newSide: DiffSide | undefined,
  ): Promise<RenderedDiff> {
    if (!oldSide && !newSide) return { diff: '', truncated: false };

    const scratch = await mkdtemp(path.join(tmpdir(), 'ferretry-diff-'));
    try {
      const left = oldSide ? await stageSide(scratch, rel, 'a', oldSide) : '/dev/null';
      const right = newSide ? await stageSide(scratch, rel, 'b', newSide) : '/dev/null';
      const args = [...DIFF_SAFETY, '--no-index', '--src-prefix=', '--dst-prefix=', '--', left, right];
      // `--no-index` exits 1 for "they differ", which is the normal case here.
      const rendered = await this.text('git diff', args, scratch, [0, 1]);
      return { diff: relabelDiffHeaders(rendered.stdout, rel), truncated: rendered.execution.stdoutTruncated };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * One fixed-cost stats pass for every changed row, never one spawn per file.
   *
   * `--relative=<session prefix>` both filters siblings out at Git and rewrites the returned paths into the
   * same cwd-relative namespace as status. This is optional enrichment: a status list is still useful
   * without counts, so a failure here degrades to no counts rather than taking the whole browser down.
   */
  private async lineStats(cwd: GitWorkingDirectory, info: SessionRepoInfo): Promise<ReadonlyMap<string, GitLineStats>> {
    try {
      const revision = info.hasHead ? 'HEAD' : EMPTY_TREE_OID;
      const args = [...DIFF_SAFETY, '--numstat', '-z', `--relative=${info.prefix}`, revision, '--'];
      const rendered = await this.text('git diff --numstat', args, cwd, [0, 1, 128]);
      if (rendered.execution.exitCode !== 0) return new Map();
      return parseNumstat(rendered.stdout, rendered.execution.stdoutTruncated);
    } catch {
      return new Map();
    }
  }

  /** Run one command, refuse a timeout or an unexpected exit, and decode stdout as text. */
  private async text(
    action: string,
    args: readonly string[],
    cwd: GitWorkingDirectory,
    acceptedExitCodes: readonly number[],
  ): Promise<TextExecution> {
    const execution = requireGitExit(action, await this.runner.run({ args, cwd }), acceptedExitCodes);
    return { execution, stdout: decodeGitOutput(execution) };
  }
}

/**
 * Stage one side of the diff inside the scratch directory and return the path Git should be given,
 * relative to that directory.
 *
 * The `a/` and `b/` prefixes are not cosmetic: paired with `--src-prefix=` and `--dst-prefix=` they make Git
 * print `--- a/<rel>` and `+++ b/<rel>` ITSELF. That is what lets this avoid rewriting those lines
 * afterwards — and rewriting them would be a real hazard, because a body line `-- a/x` renders as `--- a/x`,
 * indistinguishable from a header by prefix alone.
 */
async function stageSide(scratch: string, rel: string, prefix: 'a' | 'b', side: DiffSide): Promise<string> {
  const relative = `${prefix}/${rel}`;
  const absolute = path.join(scratch, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  if (side.mode === SYMLINK_MODE) {
    // Recreate it as a symlink so Git reports the type natively. Git reads this with `readlink` and never
    // opens it, so the target is never followed — whether or not it still exists, or ever did.
    await symlink(new TextDecoder().decode(side.bytes), absolute);
    return relative;
  }
  await writeFile(absolute, side.bytes, { mode: side.mode & 0o777 });
  // `writeFile`'s mode is subject to umask; `chmod` is not.
  await chmod(absolute, side.mode & 0o777);
  return relative;
}
