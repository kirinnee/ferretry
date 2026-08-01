import { describe, expect, it } from 'bun:test';
import {
  collapseTreeDir,
  createFileTreeState,
  expandTreeDir,
  invalidateTree,
  isTreeDirExpanded,
  markTreeDirLoading,
  pendingTreeDirs,
  resetTreeDir,
  revealTreeDir,
  setTreeDirError,
  setTreeDirListing,
  toggleTreeDir,
  treeDirNode,
  treeRows,
} from '../../src/components/file-tree-model.ts';

describe('file tree model', () => {
  it('only loads expanded visible non-refused directories', () => {
    let state = setTreeDirListing(createFileTreeState(), '', {
      entries: [
        { name: 'src', type: 'dir' },
        { name: '.git', type: 'dir', denied: true },
      ],
    });
    state = expandTreeDir(state, 'src');
    state = expandTreeDir(state, '.git');
    expect(pendingTreeDirs(state)).toEqual(['src']);
  });
  it('renders daemon uncertainty honestly and preserves raw refused names', () => {
    let state = setTreeDirListing(createFileTreeState(), '', {
      entries: [
        { name: 'a\\b', type: 'file' },
        { name: 'src', type: 'dir' },
      ],
      truncated: true,
    });
    state = revealTreeDir(state, 'src/lib');
    state = setTreeDirError(state, 'src', 'offline');
    expect(
      treeRows(state, 'src').map(row => (row.kind === 'note' ? row.note : `${row.path}:${row.refusal ?? ''}`)),
    ).toEqual([
      'src:',
      'error',
      'a\\b:name cannot be opened by this viewer — it uses a character the daemon’s path grammar refuses',
      'truncated',
    ]);
  });
  it('keeps root expanded and transitions every directory state without mutation', () => {
    const initial = createFileTreeState();
    expect(treeDirNode(initial, 'missing').status).toBe('unloaded');
    expect(collapseTreeDir(initial, '')).toBe(initial);
    let state = expandTreeDir(initial, 'src');
    expect(expandTreeDir(state, 'src')).toBe(state);
    expect(isTreeDirExpanded(state, 'src')).toBeTrue();
    state = toggleTreeDir(state, 'src');
    expect(isTreeDirExpanded(state, 'src')).toBeFalse();
    state = markTreeDirLoading(state, 'src');
    expect(markTreeDirLoading(state, 'src')).toBe(state);
    state = resetTreeDir(state, 'src');
    expect(treeDirNode(state, 'src').status).toBe('unloaded');
    expect(invalidateTree(initial)).toBe(initial);
    expect(treeRows(setTreeDirListing(state, '', { entries: [] }))).toEqual([
      { kind: 'note', note: 'empty', dir: '', depth: 0 },
    ]);
  });
});
