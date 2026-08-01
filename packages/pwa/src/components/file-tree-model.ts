import type { FsEntry, FsListing } from './files-api.ts';
import { entryRefusal, joinRel, normalizeRel, sortFsEntries } from './files-model.ts';

export type TreeDirStatus = 'unloaded' | 'loading' | 'ready' | 'error';
export interface TreeDirNode {
  status: TreeDirStatus;
  entries: readonly FsEntry[];
  truncated: boolean;
  error: string | null;
}
export interface FileTreeState {
  nodes: ReadonlyMap<string, TreeDirNode>;
  expanded: ReadonlySet<string>;
}
const unloaded: TreeDirNode = { status: 'unloaded', entries: [], truncated: false, error: null };
export const createFileTreeState = (): FileTreeState => ({ nodes: new Map(), expanded: new Set(['']) });
export const treeDirNode = (state: FileTreeState, dir: string): TreeDirNode =>
  state.nodes.get(normalizeRel(dir)) ?? unloaded;
export const isTreeDirExpanded = (state: FileTreeState, dir: string): boolean => state.expanded.has(normalizeRel(dir));
const withNode = (state: FileTreeState, dir: string, node: TreeDirNode): FileTreeState => {
  const nodes = new Map(state.nodes);
  nodes.set(normalizeRel(dir), node);
  return { nodes, expanded: state.expanded };
};
export const expandTreeDir = (state: FileTreeState, dir: string): FileTreeState => {
  const key = normalizeRel(dir);
  if (state.expanded.has(key)) return state;
  return { nodes: state.nodes, expanded: new Set(state.expanded).add(key) };
};
export const collapseTreeDir = (state: FileTreeState, dir: string): FileTreeState => {
  const key = normalizeRel(dir);
  if (!key || !state.expanded.has(key)) return state;
  const expanded = new Set(state.expanded);
  expanded.delete(key);
  return { nodes: state.nodes, expanded };
};
export const toggleTreeDir = (state: FileTreeState, dir: string): FileTreeState =>
  isTreeDirExpanded(state, dir) ? collapseTreeDir(state, dir) : expandTreeDir(state, dir);
export const revealTreeDir = (state: FileTreeState, dir: string): FileTreeState => {
  const key = normalizeRel(dir);
  if (!key) return state;
  const expanded = new Set(state.expanded);
  let path = '',
    changed = false;
  for (const part of key.split('/')) {
    path = path ? `${path}/${part}` : part;
    if (!expanded.has(path)) {
      expanded.add(path);
      changed = true;
    }
  }
  return changed ? { nodes: state.nodes, expanded } : state;
};
export const markTreeDirLoading = (state: FileTreeState, dir: string): FileTreeState => {
  const current = treeDirNode(state, dir);
  return current.status === 'loading' ? state : withNode(state, dir, { ...current, status: 'loading', error: null });
};
export const setTreeDirListing = (state: FileTreeState, dir: string, listing: FsListing): FileTreeState =>
  withNode(state, dir, {
    status: 'ready',
    entries: listing.entries ?? [],
    truncated: listing.truncated ?? false,
    error: null,
  });
export const setTreeDirError = (state: FileTreeState, dir: string, error: string): FileTreeState =>
  withNode(state, dir, { ...treeDirNode(state, dir), status: 'error', error });
export const resetTreeDir = (state: FileTreeState, dir: string): FileTreeState => withNode(state, dir, unloaded);
export const invalidateTree = (state: FileTreeState): FileTreeState =>
  state.nodes.size ? { nodes: new Map(), expanded: state.expanded } : state;
export const pendingTreeDirs = (state: FileTreeState): string[] => {
  const result: string[] = [];
  const walk = (dir: string): void => {
    if (!state.expanded.has(dir)) return;
    const node = treeDirNode(state, dir);
    if (node.status === 'unloaded') {
      result.push(dir);
      return;
    }
    if (node.status !== 'ready') return;
    for (const entry of node.entries) if (entry.type === 'dir' && !entryRefusal(entry)) walk(joinRel(dir, entry.name));
  };
  walk('');
  return result;
};
export interface TreeEntryRow {
  kind: 'dir' | 'file';
  path: string;
  name: string;
  depth: number;
  refusal: string | null;
  expanded: boolean;
  selected: boolean;
  size?: number;
}
export interface TreeNoteRow {
  kind: 'note';
  note: 'loading' | 'error' | 'empty' | 'truncated';
  dir: string;
  depth: number;
  error?: string;
}
export type TreeRow = TreeEntryRow | TreeNoteRow;
export const treeRows = (state: FileTreeState, selectedDir = ''): TreeRow[] => {
  const selected = normalizeRel(selectedDir),
    rows: TreeRow[] = [];
  const walk = (dir: string, depth: number): void => {
    const node = treeDirNode(state, dir);
    if (node.status === 'unloaded' || node.status === 'loading') {
      rows.push({ kind: 'note', note: 'loading', dir, depth });
      return;
    }
    if (node.status === 'error') {
      rows.push({ kind: 'note', note: 'error', dir, depth, error: node.error ?? 'unknown error' });
      return;
    }
    const entries = sortFsEntries(node.entries);
    if (!entries.length) rows.push({ kind: 'note', note: 'empty', dir, depth });
    for (const entry of entries) {
      const refusal = entryRefusal(entry),
        path = refusal ? (dir ? `${dir}/${entry.name}` : entry.name) : joinRel(dir, entry.name),
        isDir = entry.type === 'dir',
        expanded = isDir && !refusal && state.expanded.has(path);
      rows.push({
        kind: isDir ? 'dir' : 'file',
        path,
        name: entry.name,
        depth,
        refusal,
        expanded,
        selected: isDir && !refusal && path === selected,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      });
      if (expanded) walk(path, depth + 1);
    }
    if (node.truncated) rows.push({ kind: 'note', note: 'truncated', dir, depth });
  };
  walk('', 0);
  return rows;
};
