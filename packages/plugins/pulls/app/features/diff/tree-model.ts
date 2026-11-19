import type { PullFile } from '../../../contract/index.ts';

interface TreeFile {
  readonly kind: 'file';
  readonly name: string;
  readonly path: string;
  readonly file: PullFile;
}
export interface TreeFolder {
  readonly kind: 'folder';
  /** The folder's label; a chain of single-child folders reads as one (`src/app/features`). */
  readonly name: string;
  readonly path: string;
  readonly children: readonly TreeNode[];
  readonly files: number;
}
export type TreeNode = TreeFile | TreeFolder;

/** Files matching a filter: every word must be somewhere in the path (or the path it was renamed from). */
export function filterFiles(files: readonly PullFile[], query: string): readonly PullFile[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return files;
  return files.filter(file => {
    const haystack = `${file.path}\n${file.previousPath ?? ''}`.toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

interface Draft {
  readonly name: string;
  readonly path: string;
  readonly folders: Map<string, Draft>;
  readonly files: TreeFile[];
}

const seal = (draft: Draft): TreeFolder => {
  let node = draft;
  let name = draft.name;
  // A folder holding only one folder and no files folds into it: `src/` → `app/` → `x.ts` is one row `src/app`.
  while (node.files.length === 0 && node.folders.size === 1 && node.path !== '') {
    const only = node.folders.values().next().value;
    if (only === undefined) break;
    node = only;
    name = `${name}/${only.name}`;
  }
  const folders = [...node.folders.values()].map(seal).sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  const count = folders.reduce((sum, folder) => sum + folder.files, files.length);
  return { kind: 'folder', name, path: node.path, children: [...folders, ...files], files: count };
};

/** The tree of a PR's files, in the order a person browses: folders first, then files, each alphabetical. */
export function buildTree(files: readonly PullFile[]): TreeFolder {
  const root: Draft = { name: '', path: '', folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    const name = parts.pop() ?? file.path;
    let at = root;
    for (const part of parts) {
      let next = at.folders.get(part);
      if (next === undefined) {
        next = { name: part, path: at.path === '' ? part : `${at.path}/${part}`, folders: new Map(), files: [] };
        at.folders.set(part, next);
      }
      at = next;
    }
    at.files.push({ kind: 'file', name, path: file.path, file });
  }
  const sealed = seal(root);
  return sealed;
}
