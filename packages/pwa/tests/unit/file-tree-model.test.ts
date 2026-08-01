import { describe, expect, it } from 'bun:test';
import {
  createFileTreeState,
  expandTreeDir,
  pendingTreeDirs,
  revealTreeDir,
  setTreeDirError,
  setTreeDirListing,
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
});
