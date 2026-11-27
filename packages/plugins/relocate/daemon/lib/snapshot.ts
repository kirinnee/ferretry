import type { FerretId } from '@ferretry/kernel/contract';
import {
  FERRET_READABLE_FOLDERS,
  type FerretSummary,
  type RelocationFile,
  type RelocationSource,
} from '@ferretry/core-ferrets/contract';
import { isSecretFileName, isSecretFolderName } from '@ferretry/std';
import type { CloneCrypto } from '@ferretry/std/sealing';
import { toHex } from './hex.ts';
import {
  type BundleEntryKind,
  type BundleManifest,
  MOVES,
  type PreflightResponse,
  RELOCATE_MAX_BUNDLE_BYTES,
  RELOCATE_MAX_FILE_BYTES,
  STAYS,
} from '../../contract/index.ts';
import type { WorkingTree } from './git-bundle.ts';

/** What the snapshot is made from: the ferret's own files (through Ferrets) and its working tree (through git). */
export interface SnapshotInputs {
  readonly summary: FerretSummary;
  readonly source: RelocationSource;
  /** The working tree the ferret works in; `undefined` when its folder is not a git work tree. */
  readonly tree: WorkingTree | undefined;
}

/** One entry of the bundle, with its bytes. */
export interface GatheredEntry {
  readonly kind: BundleEntryKind;
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** The facts a preflight has proved, and the refusals it found. Reading is all it does: nothing is stopped or written. */
export interface Plan {
  readonly refusals: readonly string[];
  readonly files: readonly RelocationFile[];
  /** New files git does not ignore and whose names do not say secret. */
  readonly untracked: readonly { readonly path: string; readonly size: number }[];
  readonly withheld: readonly string[];
  readonly ignored: readonly string[];
  readonly head?: { readonly head: string; readonly branch?: string };
  readonly bytes: number;
  readonly largest: readonly { readonly path: string; readonly size: number }[];
}

/** Whether any segment of a path names a secret (`.env`, `*.pem`, `id_*`, `auth.json`, `.ssh/`): the one list the file browser reads too. */
function namesASecret(path: string): boolean {
  return path.split('/').some(segment => isSecretFileName(segment) || isSecretFolderName(segment));
}

const refuse = (error: unknown): string =>
  error instanceof Error && error.message !== '' ? error.message : 'this ferret’s working tree could not be read';

/** The first path segment: what the person sees as "the ignored thing" (`node_modules`, `.env`, `dist`). */
const topLevel = (path: string): string => (path.split('/')[0] ?? path).replace(/\/$/u, '');

/**
 * Looks at everything a move would carry and says whether it could start: idle, no job, a conversation its harness can
 * pack, a working tree git can read, nothing over a file's or the bundle's size. It reads the sizes and nothing else of the
 * files, and stops nothing.
 */
export async function plan(inputs: SnapshotInputs): Promise<Plan> {
  const refusals: string[] = [...(await inputs.source.busy())];
  const conversation = await inputs.source.conversation().catch(() => undefined);
  let bytes = 0;
  if (conversation === undefined || !conversation.ok)
    refusals.push(
      conversation?.ok === false ? conversation.error.reason : 'this ferret’s conversation could not be read',
    );
  else bytes += conversation.value.bytes.length;

  const listed = await inputs.source.files();
  // CLOSED SET, checked here as well as where Ferrets lists: a session file moves only below the three folders an agent
  // already reads, and the journal only as `history.jsonl`. Whatever else a source lists (`environment.json`, `tokens.json`,
  // `media/`), and any name that says secret, is left behind and named.
  const travels = (file: RelocationFile): boolean =>
    !namesASecret(file.path) &&
    (file.area === 'history'
      ? file.path === 'history.jsonl'
      : (FERRET_READABLE_FOLDERS as readonly string[]).includes(file.path.split('/')[0] ?? ''));
  const files = listed.filter(travels);
  const untravelled = listed.filter(file => !travels(file)).map(file => file.path);
  bytes += files.reduce((sum, file) => sum + file.size, 0);
  const sizes: { path: string; size: number }[] = files.map(file => ({ path: file.path, size: file.size }));

  const untracked: { path: string; size: number }[] = [];
  const withheld: string[] = [...untravelled];
  let ignored: string[] = [];
  let head: Plan['head'];
  if (inputs.tree !== undefined) {
    try {
      head = await inputs.tree.head();
      if (head !== undefined) {
        ignored = [...new Set((await inputs.tree.ignoredTopLevel()).map(topLevel))].sort();
        for (const path of await inputs.tree.untracked()) {
          if (namesASecret(path)) {
            withheld.push(path);
            continue;
          }
          const content = await inputs.tree.read(path, RELOCATE_MAX_FILE_BYTES);
          if (content === undefined) continue; // a link, a device, a hard-linked file or an oversize one: it stays
          untracked.push({ path, size: content.length });
        }
        const commits = await inputs.tree.commits(RELOCATE_MAX_BUNDLE_BYTES);
        const changes = await inputs.tree.changes(RELOCATE_MAX_BUNDLE_BYTES);
        bytes += (commits?.length ?? 0) + changes.length + untracked.reduce((sum, file) => sum + file.size, 0);
        sizes.push(...untracked);
        if (commits !== undefined) sizes.push({ path: 'commits', size: commits.length });
        if (changes.length > 0) sizes.push({ path: 'changes', size: changes.length });
      }
    } catch (error) {
      refusals.push(refuse(error));
    }
  }

  const largest = [...sizes].sort((a, b) => b.size - a.size).slice(0, 5);
  const tooBig = sizes.filter(file => file.size > RELOCATE_MAX_FILE_BYTES);
  for (const file of tooBig) refusals.push(`${file.path} is larger than one file of a move can be`);
  if (bytes > RELOCATE_MAX_BUNDLE_BYTES)
    refusals.push(
      `this ferret holds ${String(Math.ceil(bytes / 1024 / 1024))} MB; a move carries at most ${String(RELOCATE_MAX_BUNDLE_BYTES / 1024 / 1024)} MB`,
    );
  return {
    refusals,
    files,
    untracked,
    withheld,
    ignored,
    ...(head === undefined ? {} : { head }),
    bytes,
    largest: refusals.length > 0 ? largest : [],
  };
}

/** The preflight answer: the table, the counts and the refusals, never a file's content. */
export function preflightView(found: Plan): PreflightResponse {
  return {
    ok: found.refusals.length === 0,
    refusals: [...found.refusals],
    moves: MOVES.map(row => ({ ...row })),
    stays: STAYS.map(row => ({ ...row })),
    files: found.files.length + found.untracked.length,
    bytes: found.bytes,
    largest: found.largest.map(file => ({ ...file })),
    ignored: [...found.ignored],
    withheld: [...found.withheld],
    ...(found.head?.branch === undefined ? {} : { branch: found.head.branch }),
    ...(found.head === undefined ? {} : { head: found.head.head }),
  };
}

/** The ferret's own record, as a document: only the fields the move names, so a field added later never rides along by accident. */
function recordDocument(summary: FerretSummary): Uint8Array {
  const kept = {
    name: summary.name,
    role: summary.role,
    mode: summary.mode,
    harness: summary.harness,
    runtime: summary.runtime,
    model: summary.model,
    effort: summary.effort,
    fast: summary.fast,
    title: summary.title,
  };
  return new TextEncoder().encode(JSON.stringify(kept));
}

/**
 * Reads every file the plan listed and assembles the entries in the table's order. It reads again what `plan` measured,
 * because the ferret was stopped in between and nothing it writes after that is lost.
 */
export async function gather(inputs: SnapshotInputs, found: Plan): Promise<readonly GatheredEntry[]> {
  const entries: GatheredEntry[] = [
    { kind: 'ferret-record', path: 'record.json', bytes: recordDocument(inputs.summary) },
  ];
  const limit = RELOCATE_MAX_FILE_BYTES;
  for (const file of found.files)
    entries.push({
      kind: file.area === 'history' ? 'journal' : 'session',
      path: file.path,
      bytes: await inputs.source.read({ area: file.area, path: file.path }, limit),
    });
  const conversation = await inputs.source.conversation();
  if (!conversation.ok) throw new Error(conversation.error.reason);
  entries.push({ kind: 'conversation', path: conversation.value.relPath, bytes: conversation.value.bytes });
  if (inputs.tree !== undefined && found.head !== undefined) {
    const commits = await inputs.tree.commits(RELOCATE_MAX_BUNDLE_BYTES);
    if (commits !== undefined) entries.push({ kind: 'worktree-commits', path: 'commits.bundle', bytes: commits });
    const changes = await inputs.tree.changes(RELOCATE_MAX_BUNDLE_BYTES);
    if (changes.length > 0) entries.push({ kind: 'worktree-changes', path: 'changes.diff', bytes: changes });
    for (const file of found.untracked) {
      const content = await inputs.tree.read(file.path, limit);
      if (content === undefined) throw new Error(`${file.path} changed while the move was being prepared`);
      entries.push({ kind: 'worktree-file', path: file.path, bytes: content });
    }
  }
  return entries;
}

/** The manifest of a gathered snapshot: each entry's size and SHA-256, so the target verifies before it writes anything. */
export async function manifestOf(
  crypto: Pick<CloneCrypto, 'sha256'>,
  ferret: { readonly id: FerretId; readonly name: string },
  found: Plan,
  entries: readonly GatheredEntry[],
): Promise<BundleManifest> {
  const listed = [];
  for (const entry of entries)
    listed.push({
      kind: entry.kind,
      path: entry.path,
      size: entry.bytes.length,
      sha256: toHex(await crypto.sha256(entry.bytes)),
    });
  return {
    v: 1,
    ferret: { id: ferret.id, name: ferret.name },
    ...(found.head === undefined
      ? {}
      : {
          worktree: {
            head: found.head.head,
            ...(found.head.branch === undefined ? {} : { branch: found.head.branch }),
          },
        }),
    entries: listed,
  };
}
