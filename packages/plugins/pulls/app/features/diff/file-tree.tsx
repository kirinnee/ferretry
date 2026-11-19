import { useMemo, useState } from 'react';
import type { PullFile } from '../../../contract/index.ts';
import { buildTree, filterFiles, type TreeNode } from './tree-model.ts';

function Node({
  node,
  depth,
  viewed,
  onPick,
}: {
  readonly node: TreeNode;
  readonly depth: number;
  readonly viewed: (file: PullFile) => boolean;
  readonly onPick: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: `${depth * 0.75}rem` };
  if (node.kind === 'file')
    return (
      <li>
        <button
          className="flex w-full min-w-0 items-center gap-1 bg-transparent px-1 py-0.5 text-left text-meta text-fg hover:bg-code-bg"
          data-tree-file={node.path}
          onClick={() => onPick(node.path)}
          style={pad}
          title={node.path}
          type="button"
        >
          <span aria-hidden="true" className={viewed(node.file) ? 'text-ok' : 'text-transparent'}>
            ✓
          </span>
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {node.file.additions === 0 && node.file.deletions === 0 ? null : (
            <>
              <span className="text-ok tabular-nums">+{node.file.additions}</span>
              <span className="text-err tabular-nums">−{node.file.deletions}</span>
            </>
          )}
        </button>
      </li>
    );
  return (
    <li>
      <button
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1 bg-transparent px-1 py-0.5 text-left text-meta text-muted hover:bg-code-bg"
        onClick={() => setOpen(value => !value)}
        style={pad}
        type="button"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="text-faint tabular-nums">{node.files}</span>
      </button>
      {open ? (
        <ul className="m-0 list-none p-0">
          {node.children.map(child => (
            <Node depth={depth + 1} key={`${child.kind}:${child.path}`} node={child} onPick={onPick} viewed={viewed} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The files of a PR as a tree with a filter box. A filter shows only the files that match, still grouped by folder. */
export function FileTree({
  files,
  viewed,
  onPick,
}: {
  readonly files: readonly PullFile[];
  readonly viewed: (file: PullFile) => boolean;
  readonly onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterFiles(files, query), [files, query]);
  const tree = useMemo(() => buildTree(shown), [shown]);
  return (
    <nav aria-label="Changed files" className="grid min-w-0 content-start gap-xs" data-file-tree>
      <input
        aria-label="Filter files"
        className="kt-input w-full"
        onChange={event => setQuery(event.currentTarget.value)}
        placeholder={`Filter ${files.length} files`}
        type="search"
        value={query}
      />
      {shown.length === 0 ? (
        <p className="m-0 text-meta text-muted" role="status">
          No file matches “{query}”.
        </p>
      ) : (
        <ul className="m-0 max-h-[60vh] list-none overflow-auto p-0">
          {tree.children.map(child => (
            <Node depth={0} key={`${child.kind}:${child.path}`} node={child} onPick={onPick} viewed={viewed} />
          ))}
        </ul>
      )}
    </nav>
  );
}
