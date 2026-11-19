import { describe, expect, it } from 'bun:test';
import { type FolderEntry, FolderListingSchema } from '../../../contract/index.ts';
import {
  childPath,
  folderEntries,
  moveHighlight,
  parentPath,
  resolveView,
  truncationSentence,
} from '../../../app/features/folder-explorer/explorer-model.ts';
import { newFolderProblem } from '../../../app/features/folder-explorer/folders-api.ts';

const at = '2026-08-01T10:00:00.000Z';
const listing = (path: string, crumbs: readonly string[], names: readonly string[] = [], truncated = false) =>
  FolderListingSchema.parse({
    path,
    crumbs: crumbs.map(name => ({ name, path: name === '~' ? '/home/k' : `/home/k/${name}` })),
    entries: names.map(name => ({
      name,
      kind: name.endsWith('.md') ? 'file' : 'folder',
      isRepo: name === 'repo',
      hidden: name.startsWith('.'),
      modifiedAt: at,
    })),
    truncated,
  });

describe('explorer model', () => {
  it('draws a phone as a list and everything else as cards, until the person chooses', () => {
    expect(resolveView('auto', true)).toBe('list');
    expect(resolveView('auto', false)).toBe('card');
    expect(resolveView('card', true)).toBe('card');
    expect(resolveView('list', false)).toBe('list');
  });

  it('names a child and a parent from the listing it was seen in', () => {
    const open = listing('/home/k/work', ['~', 'work'], ['repo']);
    expect(childPath(open, open.entries[0] as FolderEntry)).toBe('/home/k/work/repo');
    expect(parentPath(open)).toBe('/home/k');
    expect(parentPath(listing('/home/k', ['~']))).toBeNull();
    const root = listing('/', ['~'], ['etc']);
    expect(childPath(root, root.entries[0] as FolderEntry)).toBe('/etc');
  });

  it('keeps only folders for the keyboard', () => {
    const open = listing('/home/k', ['~'], ['a', 'notes.md', 'b']);
    expect(folderEntries(open).map(entry => entry.name)).toEqual(['a', 'b']);
  });

  it('moves the one highlight inside the grid and never wraps', () => {
    // 5 folders, 2 columns:  0 1 / 2 3 / 4
    expect(moveHighlight(-1, 'ArrowDown', 5, 2)).toBe(0);
    expect(moveHighlight(0, 'ArrowRight', 5, 2)).toBe(1);
    expect(moveHighlight(1, 'ArrowDown', 5, 2)).toBe(3);
    expect(moveHighlight(3, 'ArrowDown', 5, 2)).toBe(3);
    expect(moveHighlight(0, 'ArrowUp', 5, 2)).toBe(0);
    expect(moveHighlight(0, 'ArrowLeft', 5, 2)).toBe(0);
    expect(moveHighlight(4, 'ArrowRight', 5, 2)).toBe(4);
    expect(moveHighlight(2, 'End', 5, 2)).toBe(4);
    expect(moveHighlight(2, 'Home', 5, 2)).toBe(0);
    expect(moveHighlight(0, 'ArrowDown', 0, 2)).toBe(-1);
    // A list is one column.
    expect(moveHighlight(0, 'ArrowDown', 3, 1)).toBe(1);
    expect(moveHighlight(2, 'ArrowUp', 3, 1)).toBe(1);
  });

  it('says out loud when a listing was cut off', () => {
    expect(truncationSentence(listing('/home/k', ['~'], [], true))).toContain('more entries');
    expect(truncationSentence(listing('/home/k', ['~']))).toBeNull();
  });

  it("checks a typed folder name by the daemon's own rule, and says nothing about an empty one", () => {
    expect(newFolderProblem('')).toBeNull();
    expect(newFolderProblem('src')).toBeNull();
    expect(newFolderProblem('.hidden')).toContain('dot');
    expect(newFolderProblem('a/b')).toContain('one level');
    expect(newFolderProblem(' pad')).toContain('space');
  });
});
