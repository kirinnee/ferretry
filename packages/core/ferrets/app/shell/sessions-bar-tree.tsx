/**
 * A PROJECT GROUP'S ROWS, NESTED: each ferret with the ferrets it started beneath it, behind a thin tree
 * line. A branch has one fold button under its row — "3 sub-ferrets · 1 needs you · 2 running" — which
 * says what is inside whether it is open or shut, and is a full-width target on a phone. A parent that
 * is not listed (filtered out, stopped, in another folder) is a faint stub that names it, so its
 * children are never lost. The branch holding the open session cannot be folded away.
 */

import type { SessionView } from '@ferretry/protocol';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { daemonSessionPath } from '../lib/pages/routes.ts';
import { RouteLink } from './route-link.tsx';
import { SessionsBarRow } from './sessions-bar-row.tsx';
import {
  containsSession,
  rollupWords,
  subFerretCount,
  TREE_INDENT_DEPTHS,
  type TreeEntry,
} from './sessions-bar-tree.ts';

export interface SessionsBarTreeProps {
  readonly entries: readonly TreeEntry[];
  /** The machine the rows run on: it namespaces the folds, because session ids collide across machines. */
  readonly daemonId: DaemonId;
  readonly activeSessionId: string | null;
  /** Whether a row is the one open on this page. */
  readonly isActive: (view: SessionView) => boolean;
  readonly learns: (view: SessionView) => boolean;
  readonly onNavigate: (to: string) => void;
}

export function SessionsBarTree(props: SessionsBarTreeProps) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const scope = useId();
  const toggle = (key: string): void =>
    setFolded(current => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <ul className="fy-sbar__tree">
      {props.entries.map(entry => (
        <TreeNode entry={entry} folded={folded} key={entryKey(entry)} onToggle={toggle} scope={scope} tree={props} />
      ))}
    </ul>
  );
}

const entryKey = (entry: TreeEntry): string => `${entry.kind}:${entry.view.config.id}`;

function TreeNode({
  entry,
  folded,
  scope,
  onToggle,
  tree,
}: {
  readonly entry: TreeEntry;
  readonly folded: ReadonlySet<string>;
  readonly scope: string;
  readonly onToggle: (key: string) => void;
  readonly tree: SessionsBarTreeProps;
}) {
  const key = `${tree.daemonId}:${entryKey(entry)}`;
  const branch =
    entry.children.length === 0 ? null : (
      <Branch
        entry={entry}
        folded={folded}
        id={`${scope}${key}`}
        open={!folded.has(key) || containsSession(entry, tree.activeSessionId)}
        scope={scope}
        onFold={() => onToggle(key)}
        onToggle={onToggle}
        tree={tree}
      />
    );
  if (entry.kind === 'stub') {
    return (
      <li className="fy-sbar__stub" data-sbar-stub={entry.id}>
        <RouteLink
          className="fy-sbar__stub-link"
          onNavigate={tree.onNavigate}
          title={`Started these — ${entry.label}\n${entry.id}`}
          to={daemonSessionPath(tree.daemonId, entry.id)}
        >
          <span className="truncate">{entry.label}</span>
        </RouteLink>
        {branch}
      </li>
    );
  }
  return (
    <SessionsBarRow
      active={tree.isActive(entry.view)}
      daemonId={tree.daemonId}
      depth={Math.min(entry.depth, TREE_INDENT_DEPTHS)}
      learningPassive={tree.learns(entry.view)}
      onNavigate={tree.onNavigate}
      view={entry.view}
    >
      {branch}
    </SessionsBarRow>
  );
}

function Branch({
  entry,
  folded,
  id,
  open,
  scope,
  onFold,
  onToggle,
  tree,
}: {
  readonly entry: TreeEntry;
  readonly folded: ReadonlySet<string>;
  readonly id: string;
  readonly open: boolean;
  readonly scope: string;
  readonly onFold: () => void;
  readonly onToggle: (key: string) => void;
  readonly tree: SessionsBarTreeProps;
}) {
  const words = rollupWords(entry.rollup);
  return (
    <>
      <button
        aria-controls={id}
        aria-expanded={open}
        className="fy-sbar__fold"
        data-sbar-fold={entry.view.config.id}
        data-sbar-fold-needs-you={entry.rollup.needsYou > 0 ? '' : undefined}
        onClick={onFold}
        type="button"
      >
        <ChevronDown aria-hidden="true" className="fy-sbar__fold-chevron" size={12} />
        <span className="fy-sbar__fold-count">{subFerretCount(entry.rollup.total)}</span>
        {words === '' ? null : <span className="fy-sbar__fold-words">{words}</span>}
      </button>
      {open ? (
        <ul className="fy-sbar__children" data-sbar-children={entry.view.config.id} id={id}>
          {entry.children.map(child => (
            <TreeNode
              entry={child}
              folded={folded}
              key={entryKey(child)}
              onToggle={onToggle}
              scope={scope}
              tree={tree}
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}
