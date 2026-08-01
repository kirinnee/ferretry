/**
 * WHAT A SESSION LOOKS LIKE IN THE FLEET COLUMN. Ported from the `SidebarRow`
 * and `GroupBlock` halves of kteam `ui/src/components/AgentSidebar.tsx`.
 *
 * A row says FOUR facts and no more: the task, the teammate, the labels, and a
 * status mark. No model, no context %, no quota, no age — those are dashboard
 * columns, and a row carrying them would be the noise wall the sidebar exists to
 * remove, at a third of the width. The task comes first because it is the thing
 * being looked for ("where's the transcript fix?"); the teammate second because
 * it is how the session is referred to.
 *
 * LINEAGE IS DRAWN, NOT SPELLED OUT. Children nest under a visible parent, the
 * indent stops growing after `MAX_INDENT_DEPTH` so a deep chain cannot walk the
 * column off the edge, and past that depth a `»` marker plus a title carries the
 * trail. Everything a sighted reader gets from the indent, a screen reader gets
 * from the `sr-only` lineage sentence — they are the same fact, not two.
 *
 * The continuous rail is on the CHILD LIST, not on a padded nav row, so one
 * border spans every adjacent child and its descendants without a gap.
 *
 * WHAT CHANGED — the two single-daemon assumptions in these rows.
 *
 *   - kteam linked to `/session/<id>`. A session id is only unique WITHIN a
 *     daemon, so the href is built from `daemonSessionPath(daemonId, id)` and
 *     the daemon arrives as a required prop.
 *   - kteam gated the row gesture on `HAS_TOKEN`, a module global captured once
 *     when `lib/api` evaluated. Authority is a property of the CONNECTION a row
 *     belongs to here, so it arrives as `canMutate`.
 *
 * The attention badge is the third: kteam's `useAttentionCount(id)` read a
 * process-wide snapshot, and one hook per row would also mean one hydrate per
 * row. The host — which already holds a `(daemonId, sessionId)`-scoped attention
 * store — passes a lookup instead, so a badge can never be sourced from a
 * different daemon's ledger.
 */

import type { SessionView } from '@ferretry/protocol';
import { CircleAlert, FolderGit2 } from 'lucide-react';
import { useMemo } from 'react';
import { TaskName } from '../features/tasks/task-name.tsx';
import { displayCallsign } from '../lib/callsign.ts';
import { cn } from '../lib/class-names.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import type { SessionGroup } from '../lib/fleet-grouping.ts';
import {
  type LineageIndex,
  lineageIndent,
  lineageLabel,
  MAX_INDENT_DEPTH,
  type NestedRow,
  nestByLineage,
  parentDisplay,
} from '../lib/lineage.ts';
import { daemonSessionPath } from '../lib/pages/routes.ts';
import { RouteLink } from './route-link.tsx';
import { type OpenSessionMenu, useRowContextGesture } from './row-context-gesture.ts';
import { sessionActionSpecs } from './session-actions.ts';
import { StatusMark, statusMark } from './status-mark.tsx';

/** How many unresolved attention items a session has, on THIS daemon. */
export type AttentionCountFor = (sessionId: string) => number;

/**
 * The visible and spoken ancestry of a row that has been indented as far as the
 * column allows. Stops at the map size and at any id already seen, so a fleet
 * whose parent links form a cycle produces a truncated trail rather than
 * hanging the render.
 */
export const parentTrail = (
  view: SessionView,
  byId: ReadonlyMap<string, SessionView>,
): { readonly text: string; readonly full: string } | undefined => {
  const names: string[] = [];
  const fullNames: string[] = [];
  const seen = new Set<string>([view.config.id]);
  let parentId = view.config.parent?.trim();
  while (parentId && !seen.has(parentId) && names.length <= byId.size) {
    seen.add(parentId);
    const parent = parentDisplay(parentId, byId);
    if (!parent) break;
    if (parent.kind === 'resolved') {
      const label = lineageLabel(parent.view);
      names.unshift(label.text);
      fullNames.unshift(label.full);
    } else {
      names.unshift(parent.shortId);
      fullNames.unshift(parentId);
    }
    parentId = parent.kind === 'resolved' ? parent.view.config.parent?.trim() : undefined;
  }
  const text = names.join(' → ');
  return text ? { text, full: fullNames.join(' → ') } : undefined;
};

/** The labels a session carries, as the comma-separated list kteam stores. */
export const rowLabels = (label: string | undefined): readonly string[] =>
  (label ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

export interface SidebarRowProps {
  readonly row: NestedRow;
  /** The daemon this row belongs to. A session id alone does not address one. */
  readonly daemonId: DaemonId;
  readonly active: boolean;
  readonly activeId?: string;
  readonly byId: ReadonlyMap<string, SessionView>;
  /** This connection may act. A read-only one draws no gesture at all. */
  readonly canMutate: boolean;
  readonly attentionCountFor?: AttentionCountFor;
  /** Drawer only: picking a session has to shut the overlay covering it. */
  readonly onNavigate?: () => void;
  /** Right-click / long-press opens the row's action menu. */
  readonly onOpenSessionMenu?: OpenSessionMenu;
}

export function SidebarRow({
  active,
  activeId,
  attentionCountFor,
  byId,
  canMutate,
  daemonId,
  onNavigate,
  onOpenSessionMenu,
  row,
}: SidebarRowProps) {
  const { view, depth, children, spawnedBy } = row;
  // Only wire the gesture when there is something to offer, so a read-only
  // connection leaves the browser's own context menu untouched.
  const gesture = useRowContextGesture(
    onOpenSessionMenu && sessionActionSpecs(view, canMutate).length > 0 ? onOpenSessionMenu : undefined,
    view,
  );
  const config = view.config;
  const mark = statusMark(view);
  const label = lineageLabel(view);
  const parent = parentDisplay(config.parent, byId);
  const parentId = config.parent?.trim();
  const parentLabel = parent?.kind === 'resolved' ? lineageLabel(parent.view) : undefined;
  const parentFull =
    parentLabel?.full ??
    (parent?.kind === 'missing'
      ? `${parent.shortId}${parentId && parentId !== parent.shortId ? ` · ${parentId}` : ''}`
      : undefined);
  const spawnedByFull = parentFull ? `spawned by ${parentFull}` : undefined;
  const deepChain = depth > MAX_INDENT_DEPTH ? parentTrail(view, byId) : undefined;
  const deepTitle = deepChain ? `spawned by ${deepChain.full}` : undefined;
  const lineageText = [spawnedByFull, deepChain && `full lineage: ${deepChain.full}`].filter(Boolean).join('; ');
  const childDepth = children[0]?.depth ?? depth;
  const railIndent = Math.max(0, lineageIndent(childDepth) - lineageIndent(depth));
  const labels = rowLabels(config.label);
  const attentionCount = attentionCountFor?.(config.id) ?? 0;
  const attentionLabel = `${attentionCount} unresolved attention ${attentionCount === 1 ? 'item' : 'items'}`;

  return (
    <li>
      <RouteLink
        // `aria-current="page"` is how a screen reader is told which of a list of
        // links is the one being read; the left rail and surface are the same
        // fact for everyone else.
        aria-current={active ? 'page' : undefined}
        // `.kt-navrow` keys its active treatment off `aria-current="page"`, so the
        // family draws its own rail: 2px inset in Studio, 4px glowing in Mission,
        // 4px hard in Neo, 3px in Ember, 4px in High Contrast.
        className="kt-navrow group"
        onNavigate={onNavigate}
        title={[label.full, mark.label, spawnedBy && spawnedByFull, deepTitle].filter(Boolean).join('\n')}
        to={daemonSessionPath(daemonId, config.id)}
        {...gesture}
      >
        {/* ONE child, because `.kt-navrow` is a centred flex row: the two text
            lines stack inside it rather than sitting side by side. */}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-sm">
            {deepTitle ? (
              <span aria-hidden="true" className="shrink-0 text-faint" title={deepTitle}>
                »
              </span>
            ) : null}
            <StatusMark view={view} />
            <TaskName
              className={cn('min-w-0 flex-1', active && 'text-accent')}
              name={config.name}
              size="sm"
              teammate={config.teammate}
            />
            {attentionCount > 0 ? (
              <span
                aria-label={attentionLabel}
                className="mono inline-flex shrink-0 items-center gap-[3px] rounded-full border border-warn/40 bg-warn/10 px-1.5 font-semibold text-2xs text-warn"
                role="status"
                title={attentionLabel}
              >
                <CircleAlert aria-hidden="true" size={10} />
                <span aria-hidden="true">{attentionCount > 99 ? '99+' : attentionCount}</span>
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-xs pl-3.5">
            <span className={cn('mono min-w-0 truncate text-meta', active ? 'text-accent' : 'text-muted')}>
              {displayCallsign(config.teammate) || config.id}
            </span>
            {labels.map(entry => (
              <span
                className="shrink-0 rounded-badge border border-border-soft bg-surface-2 px-xs text-2xs text-muted"
                key={entry}
              >
                {entry}
              </span>
            ))}
          </div>
          {lineageText ? <span className="sr-only"> — {lineageText}</span> : null}
        </div>
      </RouteLink>
      {children.length > 0 ? (
        /* The rail is on the child list, not a padded nav row: one border now
           spans every adjacent child (and its nested descendants) continuously. */
        <ul
          className={cn('m-0 list-none p-0', railIndent > 0 && 'border-border-soft border-l')}
          style={railIndent > 0 ? { marginLeft: `${railIndent - 1}px` } : undefined}
        >
          {children.map(child => (
            <SidebarRow
              active={child.view.config.id === activeId}
              activeId={activeId}
              attentionCountFor={attentionCountFor}
              byId={byId}
              canMutate={canMutate}
              daemonId={daemonId}
              key={child.view.config.id}
              onNavigate={onNavigate}
              onOpenSessionMenu={onOpenSessionMenu}
              row={child}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export interface GroupBlockProps {
  readonly group: SessionGroup;
  readonly lineage: LineageIndex;
  readonly daemonId: DaemonId;
  readonly byId: ReadonlyMap<string, SessionView>;
  readonly canMutate: boolean;
  readonly activeId?: string;
  readonly attentionCountFor?: AttentionCountFor;
  /** This group is the active folder scope: pinned first, accented, aria-current. */
  readonly scoped?: boolean;
  /** Drawer/touch context: the header button takes the 44px touch floor. */
  readonly coarse?: boolean;
  /** Focus this folder (folder mode). */
  readonly onFocus: (path: string) => void;
  readonly onNavigate?: () => void;
  readonly onOpenSessionMenu?: OpenSessionMenu;
}

/** One project folder and its nested sessions. */
export function GroupBlock({
  activeId,
  attentionCountFor,
  byId,
  canMutate,
  coarse,
  daemonId,
  group,
  lineage,
  onFocus,
  onNavigate,
  onOpenSessionMenu,
  scoped,
}: GroupBlockProps) {
  const rows = useMemo(() => nestByLineage(group.rows, lineage), [group.rows, lineage]);

  return (
    <section>
      {/* Sticky, and OPAQUE (`bg-bg`, no alpha): rows scroll under it, and a
          translucent header over a dense list is unreadable in every theme.
          `aria-current="true"` marks the focused folder for a screen reader; the
          accent treatment is the same fact for everyone else. */}
      <h3
        aria-current={scoped ? 'true' : undefined}
        className="sticky top-0 z-10 flex min-w-0 items-center gap-sm bg-bg px-cell-x py-row-y"
      >
        {/* The icon+name is the fold-in entry point — a real button that focuses
            the folder, and in the drawer also closes the overlay (row parity). */}
        <button
          aria-label={`Focus folder ${group.name}`}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-sm rounded-control text-left hover:bg-surface-2',
            coarse && 'min-h-[44px]',
            scoped && 'text-accent',
          )}
          onClick={() => {
            onFocus(group.path);
            onNavigate?.();
          }}
          title={`Focus folder ${group.name}`}
          type="button"
        >
          <FolderGit2 className={cn('shrink-0', scoped ? 'text-accent' : 'text-faint')} size={11} />
          {/* Section heads are the canonical `.kt-label` site: Ember renders these
              as small caps, Mission as 0.14em mono caps, Neo at 800. */}
          <span className="kt-label min-w-0 truncate">{group.name}</span>
        </button>
        <span className="mono ml-auto shrink-0 text-2xs text-faint">{group.rows.length}</span>
      </h3>
      <ul className="m-0 list-none p-0">
        {rows.map(row => (
          <SidebarRow
            active={row.view.config.id === activeId}
            activeId={activeId}
            attentionCountFor={attentionCountFor}
            byId={byId}
            canMutate={canMutate}
            daemonId={daemonId}
            key={row.view.config.id}
            onNavigate={onNavigate}
            onOpenSessionMenu={onOpenSessionMenu}
            row={row}
          />
        ))}
      </ul>
    </section>
  );
}
