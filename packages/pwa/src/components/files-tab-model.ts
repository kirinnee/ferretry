/**
 * The Files tab's pure layer — everything the browser surface decides that is
 * not a render. Ported from `ui/src/components/FilesTab.tsx`.
 *
 * WHAT THIS LAYER DOES NOT DECIDE: whether a file may be read. Containment, the
 * secrets denylist, the gitignore gate and the size/binary caps are the
 * daemon's. A client-side gate is worth nothing against a leaked token; the
 * viewer renders the verdicts (`denied`, `ignored`, `escapes`, `binary`,
 * `tooLarge`) and never offers a way around one.
 *
 * MULTI-DAEMON. The original kept its open-file tabs in a module map keyed by
 * `sessionId` alone. Two paired daemons can each own a session with the same
 * id, and that map would then hand one daemon's open files to the other — and
 * with them the paths a reader had open. Every entry is keyed by
 * `(daemonId, sessionId)`.
 */

import type { FsChange, FsFile } from './files-api.ts';
import { formatBytes, statusChip } from './files-model.ts';
import { daemonSessionKey, type DaemonSessionScope } from '../lib/daemon-scope.ts';
import type { LayoutMode } from '../hooks/use-layout-mode.ts';
import type { CodeReference } from '../lib/references.ts';

/**
 * Mirrors the shared highlighter's private cap only so the pane can explain its
 * own fallback. Highlighting still owns and enforces the real limit.
 */
export const HIGHLIGHT_LIMIT = 60_000;

export type FileView = 'normal' | 'raw' | 'diff';

export interface FileLineSelection {
  readonly line: number;
  readonly endLine?: number;
  readonly column?: number;
}

export interface OpenFileTab {
  readonly path: string;
  readonly view: FileView;
  /**
   * A reference temporarily shows exact source lines even when this tab's
   * remembered view is rendered Markdown or a diff. Clearing it restores `view`.
   */
  readonly selection?: FileLineSelection;
}

/** A programmatic open request from whichever surface holds the Files pane. */
export interface CodeReferenceOpenRequest {
  readonly sequence: number;
  readonly reference: ColumnCodeReference;
}

export interface FilesTabSnapshot {
  readonly dir: string;
  readonly tabs: readonly OpenFileTab[];
  readonly activePath: string | null;
  /**
   * The reader's explicit tree choice. Absent means the layout default applies:
   * open on desktop, collapsed at drawer widths.
   */
  readonly tree?: boolean;
}

/**
 * "Collapsed by default on mobile, toggleable on desktop": an explicit choice
 * always wins; otherwise only the drawer layout starts collapsed.
 */
export const filesTreeOpenByDefault = (preference: boolean | undefined, layout: LayoutMode): boolean =>
  preference ?? layout !== 'drawer';

const EMPTY_FILES_TAB_SNAPSHOT: FilesTabSnapshot = { dir: '', tabs: [], activePath: null };
const openFileTabs = new Map<string, FilesTabSnapshot>();

/**
 * The Files surface is mount-per-open (and a phone sheet must unmount), so its
 * tabs live in bounded page memory. Opening a reference from another surface
 * cannot erase the files the reader already had open.
 */
export const readFilesTabState = (scope: DaemonSessionScope): FilesTabSnapshot => {
  const state = openFileTabs.get(daemonSessionKey(scope));
  return state ? { ...state, tabs: [...state.tabs] } : EMPTY_FILES_TAB_SNAPSHOT;
};

export const writeFilesTabState = (scope: DaemonSessionScope, state: FilesTabSnapshot): void => {
  openFileTabs.set(daemonSessionKey(scope), { ...state, tabs: [...state.tabs] });
};

/** Drops every remembered tab. Tests use it; a daemon disconnect should too. */
export const resetFilesTabStates = (): void => {
  openFileTabs.clear();
};

/**
 * A reference that may also carry a column.
 *
 * `CodeReference` in `lib/references.ts` is path + line + endLine; the original
 * kteam reference type also had a column, and `SourceLines` still renders one.
 * Widening here rather than editing the shared reference type keeps the column
 * path alive and correct for the day the grammar produces one, without changing
 * what `references.ts` promises today.
 */
export type ColumnCodeReference = CodeReference & { readonly column?: number };

/**
 * A reference only selects lines it can actually address. A zero, a fraction or
 * an end before the start is treated as no selection rather than as a range the
 * viewer then has to invent a meaning for.
 */
export const selectionFromReference = (reference: ColumnCodeReference): FileLineSelection | undefined => {
  const line = reference.line;
  if (line === undefined || !Number.isSafeInteger(line) || line < 1) return undefined;
  const endLine =
    reference.endLine !== undefined && Number.isSafeInteger(reference.endLine) && reference.endLine >= line
      ? reference.endLine
      : undefined;
  const column =
    endLine === undefined &&
    reference.column !== undefined &&
    Number.isSafeInteger(reference.column) &&
    reference.column >= 1
      ? reference.column
      : undefined;
  return { line, ...(endLine === undefined ? {} : { endLine }), ...(column === undefined ? {} : { column }) };
};

/**
 * Scrolls a target line to the pane's upper third. Deliberately NOT
 * `scrollIntoView`: that walks every scrollable ancestor and drags the
 * transcript (or the page) behind the side pane along with it.
 */
export const scrollFileLineIntoView = (
  pane: Pick<HTMLDivElement, 'clientHeight' | 'scrollTop' | 'getBoundingClientRect'>,
  target: Pick<HTMLSpanElement, 'getBoundingClientRect'>,
): void => {
  const paneTop = pane.getBoundingClientRect().top;
  const targetTop = target.getBoundingClientRect().top;
  const targetOffset = pane.scrollTop + targetTop - paneTop;
  pane.scrollTop = Math.max(0, targetOffset - Math.floor(pane.clientHeight / 3));
};

/**
 * Spoken and tooltip copy for the condensed change marker. Colour and the dot
 * are deliberately redundant: the row's accessible name carries the status word
 * and the exact counts too, so a monochrome or colour-blind reading loses
 * nothing.
 */
export const changeDescription = (change: FsChange): string => {
  const chip = statusChip(change.status);
  const counts = [
    change.additions === undefined || (change.additions === 0 && !['A', '?'].includes(chip.code))
      ? null
      : `+${change.additions}`,
    change.deletions === undefined || (change.deletions === 0 && chip.code !== 'D') ? null : `−${change.deletions}`,
  ].filter(Boolean);
  return [chip.detail ? `${chip.label} (${chip.detail})` : chip.label, ...counts].join(' · ');
};

/** The refusal reasons the file endpoint can return, in reading order. */
export const fileRefusal = (file: FsFile): string | null => {
  if (file.denied) return 'This file is on the daemon’s denylist and is never served.';
  if (file.ignored && file.content == null) return 'This file is gitignored, so its content is not served.';
  if (file.tooLarge)
    return `This file is ${formatBytes(file.size) || 'too large'} — over the daemon’s 1 MB view limit.`;
  if (file.binary) return 'This file is binary, so there is nothing to show as text.';
  return null;
};
