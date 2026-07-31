/**
 * The feature-agnostic side-pane host.
 *
 * This is the shell half of kteam's SidePane: its consumers own the actual
 * task, file, browser, and terminal bodies, while this module owns the
 * responsive frame, tab lifecycle, focus restoration, and daemon-scoped tab
 * state. Keeping the host free of feature imports lets each surface migrate
 * independently without accidentally creating a second pane implementation.
 *
 * DESIGN-side-pane-tabs.md is the source for the two hard constraints here:
 * desktop is a non-modal, resizable complementary pane, and a phone uses the
 * shared BottomSheet with a tab switcher -- never a horizontal tab strip.
 */

import { type ReactNode, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import {
  clampSidePaneWidth,
  SIDE_PANE_DEFAULT_WIDTH,
  SIDE_PANE_MAX_WIDTH,
  SIDE_PANE_MIN_CHAT_WIDTH,
  SIDE_PANE_MIN_WIDTH,
  SIDE_PANE_WORKSPACE_GAP,
  SidePanePreferenceStore,
} from '../lib/side-pane-preferences.ts';
import { BottomSheet } from './bottom-sheet.tsx';
import { SidePaneResizeHandle } from './side-pane-resize-handle.tsx';
import {
  activateSidePaneTab,
  deactivateSidePane,
  getSidePaneTabDefinitions,
  openSidePaneBrowserTab,
  openSidePaneTab,
  readSidePaneTabsState,
  removeSidePaneTab,
  resolveSidePaneTab,
  type SidePaneInstanceKind,
  type SidePaneTabDefinition,
  type SidePaneTabId,
  type SidePaneTabPresentation,
  sortSidePaneTabs,
  subscribeSidePaneTabRegistry,
  subscribeSidePaneTabsState,
} from './side-pane-tab-model.ts';
import { SidePaneTabs, sidePanePanelId, sidePaneTabId } from './side-pane-tabs.tsx';

const defaultPreferences = new SidePanePreferenceStore();
const IGNORE_RESIZE = (_width: number) => undefined;

/** Desktop's non-modal half of the workspace. The resize target is a sibling
 * of the semantic aside so its 16px hit target can safely straddle the edge. */
export function SidePaneShell({
  id,
  titleId,
  onClose,
  width = SIDE_PANE_DEFAULT_WIDTH,
  onWidthPreview = IGNORE_RESIZE,
  onWidthCommit = IGNORE_RESIZE,
  hidden = false,
  children,
}: {
  readonly id: string;
  readonly titleId: string;
  readonly onClose: () => void;
  readonly width?: number;
  readonly onWidthPreview?: (width: number) => void;
  readonly onWidthCommit?: (width: number) => void;
  /** Retained bodies stay mounted but are removed from layout, paint and tabs. */
  readonly hidden?: boolean;
  readonly children: ReactNode;
}) {
  const preferredWidth = clampSidePaneWidth(width);
  return (
    <div
      className={
        hidden ? 'pointer-events-none invisible absolute w-0 overflow-hidden' : 'relative mb-2 min-h-0 shrink-0'
      }
      style={
        hidden
          ? undefined
          : {
              width: `${preferredWidth}px`,
              minWidth: `${SIDE_PANE_MIN_WIDTH}px`,
              maxWidth: `min(${SIDE_PANE_MAX_WIDTH}px, calc(100% - ${SIDE_PANE_MIN_CHAT_WIDTH + SIDE_PANE_WORKSPACE_GAP}px))`,
            }
      }
    >
      {!hidden && <SidePaneResizeHandle width={preferredWidth} onPreview={onWidthPreview} onCommit={onWidthCommit} />}
      <aside
        id={id}
        aria-labelledby={hidden ? undefined : titleId}
        aria-hidden={hidden ? true : undefined}
        onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          onClose();
        }}
        className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-panel"
      >
        {children}
      </aside>
    </div>
  );
}

export interface SidePaneSurfaceProps {
  readonly scope: DaemonSessionScope;
  readonly tab: SidePaneTabDefinition;
  readonly presentation: SidePaneTabPresentation;
  readonly titleId: string;
  readonly onClose: () => void;
  readonly isActive: boolean;
}

export interface SidePaneWorkspaceProps {
  /** Required daemon/session identity. There is intentionally no session-only overload. */
  readonly scope: DaemonSessionScope;
  readonly presentation: SidePaneTabPresentation;
  /** A background retained workspace must never keep a phone dialog open. */
  readonly active?: boolean;
  readonly children: ReactNode;
  /** Feature owners render their registered tab here; this shell owns no feature screens. */
  readonly renderSurface: (props: SidePaneSurfaceProps) => ReactNode;
  /** Injectable for an isolated app root or tests; defaults to the browser-wide layout preference. */
  readonly preferences?: SidePanePreferenceStore;
}

/**
 * A session-scoped host for a conversation and its companion pane.
 *
 * Durable tab state is always accessed with `scope`, which includes the
 * daemon id. Width deliberately remains reader-local browser preference: it
 * controls layout rather than daemon data.
 */
export function SidePaneWorkspace({
  scope,
  presentation,
  active = true,
  children,
  renderSurface,
  preferences = defaultPreferences,
}: SidePaneWorkspaceProps) {
  const generatedId = useId();
  const paneId = `session-side-pane-${generatedId}`;
  const titleId = `${paneId}-title`;
  const openerRef = useRef<HTMLElement | null>(null);
  const allTabs = useSyncExternalStore(
    subscribeSidePaneTabRegistry,
    getSidePaneTabDefinitions,
    getSidePaneTabDefinitions,
  );
  const state = useSyncExternalStore(
    subscribeSidePaneTabsState,
    () => readSidePaneTabsState(scope),
    () => readSidePaneTabsState(scope),
  );
  const storedPreferences = useSyncExternalStore(
    preferences.subscribe,
    () => preferences.snapshot(),
    () => preferences.snapshot(),
  );
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [everRetained, setEverRetained] = useState<ReadonlySet<SidePaneTabId>>(() => new Set());
  const compact = presentation === 'sheet';
  const paneWidth = previewWidth ?? storedPreferences.width;
  // `allTabs` is deliberately read here as well as passed to the picker: a
  // registry subscription must re-resolve an already-open registered tab.
  const openTabDefs = sortSidePaneTabs(state.open, state.instances)
    .map(id => resolveSidePaneTab(scope, id))
    .filter((definition): definition is SidePaneTabDefinition => definition !== undefined);

  const close = useCallback(() => {
    deactivateSidePane(scope);
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && typeof window !== 'undefined' && document.contains(opener)) {
      window.requestAnimationFrame(() => opener.focus());
    }
  }, [scope]);
  const open = useCallback(
    (tab: SidePaneTabId, opener?: HTMLElement | null) => {
      if (opener) openerRef.current = opener;
      openSidePaneTab(scope, tab);
    },
    [scope],
  );
  const openNewInstance = useCallback(
    (kind: SidePaneInstanceKind) => {
      if (kind === 'browser') openSidePaneBrowserTab(scope, null, { forceNew: true });
      else if (kind === 'file') openSidePaneTab(scope, 'files');
      else openSidePaneTab(scope, 'terminals');
    },
    [scope],
  );
  const commitWidth = useCallback(
    (width: number) => {
      preferences.setWidth(width);
      setPreviewWidth(null);
    },
    [preferences],
  );

  useEffect(() => {
    const current = state.active;
    if (!current || compact || resolveSidePaneTab(scope, current)?.retain !== true) return;
    setEverRetained(previous => (previous.has(current) ? previous : new Set(previous).add(current)));
  }, [compact, scope, state.active]);
  useEffect(() => {
    if (compact && !active && readSidePaneTabsState(scope).active) deactivateSidePane(scope);
  }, [active, compact, scope]);

  const lastTabRef = useRef<SidePaneTabDefinition | null>(null);
  const activeDef = state.active ? resolveSidePaneTab(scope, state.active) : undefined;
  if (activeDef) lastTabRef.current = activeDef;
  const displayDef = activeDef ?? (compact ? lastTabRef.current : undefined);
  const surfaceOpen = state.active !== null;
  const liveRetained = [...everRetained].filter(id => resolveSidePaneTab(scope, id)?.retain === true);
  const retainedIds =
    !compact && activeDef?.retain === true && !liveRetained.includes(activeDef.id)
      ? [...liveRetained, activeDef.id]
      : liveRetained;
  const paneVisible = !compact && (surfaceOpen || retainedIds.length > 0);

  const body = (tab: SidePaneTabDefinition, isCurrent: boolean) => (
    <div
      id={sidePanePanelId(paneId, tab.id)}
      {...(compact ? {} : { role: 'tabpanel', 'aria-labelledby': sidePaneTabId(paneId, tab.id) })}
      className="flex min-h-0 flex-1 flex-col"
    >
      {renderSurface({ scope, tab, presentation, titleId, onClose: close, isActive: active && isCurrent })}
    </div>
  );
  const retainedBodies = !compact
    ? retainedIds.flatMap(id => {
        const tab = resolveSidePaneTab(scope, id);
        if (!tab) return [];
        const current = state.active === id;
        return [
          <div
            key={id}
            aria-hidden={current ? undefined : true}
            className={
              current ? 'flex min-h-0 flex-1 flex-col' : 'pointer-events-none invisible absolute h-0 overflow-hidden'
            }
          >
            {body(tab, current)}
          </div>,
        ];
      })
    : [];
  const ordinaryBody =
    displayDef && !(displayDef.retain && !compact) ? body(displayDef, state.active === displayDef.id) : undefined;

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full gap-2">
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
      {paneVisible && (
        <SidePaneShell
          id={paneId}
          titleId={titleId}
          onClose={close}
          width={paneWidth}
          onWidthPreview={setPreviewWidth}
          onWidthCommit={commitWidth}
          hidden={!surfaceOpen}
        >
          {state.active && (
            <SidePaneTabs
              paneId={paneId}
              presentation="pane"
              tabs={openTabDefs}
              all={allTabs}
              current={state.active}
              onSelect={id => activateSidePaneTab(scope, id)}
              onAdd={open}
              onRemove={id => removeSidePaneTab(scope, id)}
              onNewInstance={openNewInstance}
            />
          )}
          {ordinaryBody}
          {retainedBodies}
        </SidePaneShell>
      )}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {state.active ? `Opened ${activeDef?.instance?.label ?? activeDef?.label ?? state.active}` : ''}
      </div>
      {compact && displayDef && (
        <BottomSheet
          id={paneId}
          open={surfaceOpen}
          onClose={close}
          labelledBy={titleId}
          closeLabel={displayDef.closeLabel}
          panelClassName="h-full overflow-hidden bg-surface"
          maxHeight="calc(var(--app-h, 100dvh) - var(--gap-xs))"
          zIndexClass="z-[70]"
        >
          <SidePaneTabs
            paneId={paneId}
            presentation="sheet"
            tabs={openTabDefs}
            all={allTabs}
            current={displayDef.id}
            onSelect={id => activateSidePaneTab(scope, id)}
            onAdd={open}
            onRemove={id => removeSidePaneTab(scope, id)}
            onNewInstance={openNewInstance}
          />
          {ordinaryBody}
        </BottomSheet>
      )}
    </div>
  );
}
