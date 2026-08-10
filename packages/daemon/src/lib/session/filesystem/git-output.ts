import type { SessionGitChange } from './ports.ts';

/**
 * Every parse of Git's own output this viewer performs, as pure functions.
 *
 * They live in the domain rather than beside the spawn because each one is a place a hostile filename can
 * be mistaken for structure. A tab or a newline inside a path, a NUL-terminated record cut in half by the
 * output cap, a file whose entire content is forged diff headers — all of those are parsing decisions, and
 * a parsing decision that can be tested without a process is one that gets tested properly.
 */

/** The empty tree, used as the old side when a repository has no commits yet. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const NUL = String.fromCharCode(0);

export interface RevParseFacts {
  readonly insideWorkTree: boolean;
  readonly root?: string;
  /** `''` at the repo root, otherwise slash-terminated as Git reports it (`"sub/"`). */
  readonly prefix: string;
}

/** `rev-parse --is-inside-work-tree --show-toplevel --show-prefix`, in that order. */
export function parseRevParse(stdout: string): RevParseFacts {
  const lines = stdout.split('\n');
  if (lines[0]?.trim() !== 'true') return { insideWorkTree: false, prefix: '' };
  const root = lines[1]?.trim();
  return { insideWorkTree: true, ...(root ? { root } : {}), prefix: lines[2] ?? '' };
}

/**
 * The branch from a porcelain `## ` header.
 *
 * Three shapes matter: `main...origin/main` (ordinary), `No commits yet on main` (a fresh repo, whose
 * branch a client still wants to show), and `HEAD (no branch)` (detached, which has no branch to report).
 */
export function parseBranchHeader(header: string): string | undefined {
  const value = header.trim();
  const noCommits = 'No commits yet on ';
  if (value.startsWith(noCommits)) return value.slice(noCommits.length).split(/\s/)[0] || undefined;
  if (value.startsWith('HEAD (no branch)')) return undefined;
  return value.split('...')[0]?.split(/\s/)[0] || undefined;
}

/**
 * Re-express a repo-root-relative path against the session cwd, or refuse it.
 *
 * A session started in a repo SUBDIRECTORY must not be shown its siblings, and `undefined` here is what
 * drops them.
 */
export function underPrefix(repoPath: string, prefix: string): string | undefined {
  if (!prefix) return repoPath;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : undefined;
}

export interface GitLineStats {
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Parse `--numstat -z` without ever treating a tab or newline in a filename as structure.
 *
 * Rename detection is disabled for every diff this viewer runs, so each complete NUL record has exactly
 * two numeric fields followed by one literal path. A binary pair uses `-` and deliberately receives no
 * made-up count.
 */
export function parseNumstat(stdout: string, truncated: boolean): ReadonlyMap<string, GitLineStats> {
  const records = stdout.split(NUL);
  if (truncated && !stdout.endsWith(NUL)) records.pop();
  const stats = new Map<string, GitLineStats>();
  for (const record of records) {
    const firstTab = record.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 2) continue;
    const additions = Number(record.slice(0, firstTab));
    const deletions = Number(record.slice(firstTab + 1, secondTab));
    const rel = record.slice(secondTab + 1);
    if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions) || additions < 0 || deletions < 0)
      continue;
    if (rel !== '') stats.set(rel, { additions, deletions });
  }
  return stats;
}

export interface PorcelainStatus {
  readonly branch?: string;
  readonly changes: readonly SessionGitChange[];
}

/**
 * Parse `status --porcelain=v1 -z -b -uall`, filtered to the session cwd.
 *
 * A capped byte stream can end in the middle of a pathname, and `split` then presents that fragment as an
 * ordinary final record — which would surface as a change that never existed. Every complete
 * NUL-terminated record is kept and only the unterminated tail is discarded.
 */
export function parsePorcelainStatus(stdout: string, truncated: boolean, prefix: string): PorcelainStatus {
  const records = stdout.split(NUL);
  if (truncated && !stdout.endsWith(NUL)) records.pop();
  const changes: SessionGitChange[] = [];
  let branch: string | undefined;
  let index = 0;
  if (records[0]?.startsWith('## ')) {
    branch = parseBranchHeader(records[0].slice(3));
    index = 1;
  }

  for (; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    const repoPath = record.slice(3);
    // A rename or copy record is two NUL-separated fields: destination, then source.
    let source: string | undefined;
    if (/[RC]/.test(status)) {
      index += 1;
      source = records[index];
      // Those two fields are an atomic pair. If the cap landed after the destination terminator but before
      // the source record completed, neither half is honest enough to emit.
      if (source === undefined) break;
    }

    const rel = underPrefix(repoPath, prefix);
    if (rel === undefined || rel === '') continue;
    const from = source === undefined ? undefined : underPrefix(source, prefix);
    changes.push({ path: rel, status, ...(from ? { from } : {}) });
  }

  return { ...(branch ? { branch } : {}), changes };
}

/**
 * Fold one cwd-wide numstat pass back onto the status rows.
 *
 * With rename detection disabled for security, a rename becomes a deletion at `from` plus an addition at
 * `path`; both halves belong on its single status row.
 */
export function withLineStats(
  changes: readonly SessionGitChange[],
  stats: ReadonlyMap<string, GitLineStats>,
): readonly SessionGitChange[] {
  return changes.map(change => {
    const own = stats.get(change.path);
    const source = /R/.test(change.status) && change.from ? stats.get(change.from) : undefined;
    if (!own && !source) return change;
    return {
      ...change,
      additions: (own?.additions ?? 0) + (source?.additions ?? 0),
      deletions: (own?.deletions ?? 0) + (source?.deletions ?? 0),
    };
  });
}

/** Does the change list hold anything a diff could count? Untracked-only trees cannot, so no spawn. */
export function hasDiffableChange(changes: readonly SessionGitChange[]): boolean {
  return changes.some(change => change.status !== '??' && change.status !== '!!');
}

/**
 * Parse `ls-files -z`, which is one NUL-terminated path per record and nothing else.
 *
 * A capped stream can end mid-pathname, and `split` presents that fragment as an ordinary final record —
 * which would put a file that does not exist into a search index and send a reader to a 404. The
 * unterminated tail is therefore dropped, exactly as the status parser drops its own.
 *
 * Deduplicated because `--cached` reports one path once per merge stage, so a conflicted file arrives
 * two or three times and would otherwise be three rows in a result list.
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

export interface HeadTreeEntry {
  readonly mode: number;
  readonly oid: string;
}

/**
 * `ls-tree` reports `<mode> <type> <oid>\t<path>`; the mode and the oid are what a diff needs.
 *
 * A gitlink has no blob to read, and a pathspec naming a DIRECTORY reports the first entry beneath it —
 * neither is this path's content, so the recorded path must match exactly.
 */
export function parseHeadTreeEntry(stdout: string, rel: string): HeadTreeEntry | undefined {
  const record = stdout.split(NUL).find(entry => entry.length > 0);
  if (record === undefined) return undefined;
  const match = /^(\d{6}) (blob|commit) ([0-9a-f]+)\t(.*)$/s.exec(record);
  if (!match) return undefined;
  const [, modeText, type, oid, recordedPath] = match;
  if (type !== 'blob' || recordedPath !== rel || modeText === undefined || oid === undefined) return undefined;
  return { mode: Number.parseInt(modeText, 8), oid };
}

export interface BatchCheckReply {
  readonly oid: string;
  readonly size: number;
}

/**
 * `cat-file --batch-check -z` answers `<oid> <type> <size>` with a trailing newline, having NUL-terminated
 * its INPUT records. Strip both terminators before the number, so a stray NUL can never make a size NaN.
 */
export function parseBatchCheck(stdout: string): BatchCheckReply | undefined {
  const [oid, type, size] = stdout.replaceAll(NUL, '').trim().split(/\s+/);
  if (type !== 'blob' || !oid || !size) return undefined;
  const byteLength = Number(size);
  return Number.isSafeInteger(byteLength) && byteLength >= 0 ? { oid, size: byteLength } : undefined;
}

/**
 * `check-ignore -z --stdin` echoes the paths it covers, still `./`-prefixed as they went in.
 *
 * The prefix is not decoration: it defuses pathspec magic in a command that cannot accept
 * `GIT_LITERAL_PATHSPECS`, and it keeps a real file named `:(top)x` from aborting the whole batch.
 */
export function parseCheckIgnore(stdout: string): ReadonlySet<string> {
  const ignored = new Set<string>();
  for (const record of stdout.split(NUL)) {
    if (record === '') continue;
    ignored.add(record.startsWith('./') ? record.slice(2) : record);
  }
  return ignored;
}

/**
 * Fix up the `diff --git` lines, the one place Git does not honour `--src-prefix`/`--dst-prefix`: it
 * derives BOTH names from whichever side exists, so a deleted file prints `diff --git a/x a/x` and an
 * added one `diff --git b/x b/x`.
 *
 * Only these lines are rewritten, and that cannot be spoofed by file content: every body line in unified
 * output carries a space, `+`, `-` or `\` prefix, so a line beginning at column 0 with `diff --git ` is
 * always a header. A type change legitimately emits two such headers, so this is not restricted to the
 * first line.
 */
export function relabelDiffHeaders(diff: string, rel: string): string {
  if (diff === '') return diff;
  return diff
    .split('\n')
    .map(line => (line.startsWith('diff --git ') ? `diff --git a/${rel} b/${rel}` : line))
    .join('\n');
}
