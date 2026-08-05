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

import { Maximize2, Minimize2 } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
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
import { Button } from './primitives.tsx';
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
  setSidePaneFullViewport,
  sortSidePaneTabs,
  subscribeSidePaneTabRegistry,
  subscribeSidePaneTabsState,
} from './side-pane-tab-model.ts';
import { SidePaneTabs, sidePanePanelId, sidePaneTabId } from './side-pane-tabs.tsx';

const defaultPreferences = new SidePanePreferenceStore();
const IGNORE_RESIZE = (_width: number) => undefined;
const INCLUDE_EVERY_TAB = (_tab: SidePaneTabDefinition): boolean => true;

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
  fullViewport = false,
  onExitFullViewport,
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
  /** Browser-only mode: this shell replaces the app viewport instead of a pane. */
  readonly fullViewport?: boolean;
  readonly onExitFullViewport?: () => void;
  readonly children: ReactNode;
}) {
  const preferredWidth = clampSidePaneWidth(width);
  return (
    <div
      className={
        hidden
          ? 'pointer-events-none invisible absolute w-0 overflow-hidden'
          : fullViewport
            ? 'fixed inset-0 z-[80] flex h-dvh w-screen min-h-0 flex-col bg-surface'
            : 'relative mb-2 min-h-0 shrink-0'
      }
      style={
        hidden || fullViewport
          ? undefined
          : {
              width: `${preferredWidth}px`,
              minWidth: `${SIDE_PANE_MIN_WIDTH}px`,
              maxWidth: `min(${SIDE_PANE_MAX_WIDTH}px, calc(100% - ${SIDE_PANE_MIN_CHAT_WIDTH + SIDE_PANE_WORKSPACE_GAP}px))`,
            }
      }
    >
      {!hidden && !fullViewport && (
        <SidePaneResizeHandle width={preferredWidth} onPreview={onWidthPreview} onCommit={onWidthCommit} />
      )}
      <aside
        id={id}
        aria-labelledby={hidden ? undefined : titleId}
        aria-hidden={hidden ? true : undefined}
        onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          if (fullViewport) onExitFullViewport?.();
          else onClose();
        }}
        className={
          fullViewport
            ? 'flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface'
            : 'flex h-full min-h-0 w-full flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-panel'
        }
      >
        {fullViewport && (
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border-soft px-3 py-2 pt-[max(env(safe-area-inset-top),0.5rem)]">
            <span className="min-w-0 truncate text-ui font-medium text-fg">Browser full screen</span>
            <Button
              autoFocus
              type="button"
              variant="outline"
              onClick={onExitFullViewport}
              className="min-h-[44px] shrink-0 justify-center gap-xs"
              aria-keyshortcuts="Escape"
              aria-label="Exit full-screen browser"
              title="Exit full screen (Esc)"
            >
              <Minimize2 size={16} aria-hidden="true" />
              Exit
            </Button>
          </header>
        )}
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
  /** True only while this browser instance owns the application viewport. */
  readonly fullViewport: boolean;
  readonly onEnterFullViewport: () => void;
  readonly onExitFullViewport: () => void;
}

/** A narrow trigger contract for navigation chrome beside the workspace. */
export interface SidePaneHost {
  readonly scope: DaemonSessionScope;
  readonly presentation: SidePaneTabPresentation;
  /** Opening never focuses the pane; an opener receives focus only after close. */
  readonly open: (tab: SidePaneTabId, opener?: HTMLElement | null) => void;
  readonly close: () => void;
  /** The + picker path: a fresh browser page, or the owning file/terminal surface. */
  readonly openNewInstance: (kind: SidePaneInstanceKind) => void;
  /** The active browser's full-viewport state and controls. */
  readonly fullViewport: boolean;
  readonly enterFullViewport: () => void;
  readonly exitFullViewport: () => void;
}

const SidePaneContext = createContext<SidePaneHost | null>(null);

/** Null outside a workspace, so shared navigation can render standalone. */
export function useSidePane(): SidePaneHost | null {
  return useContext(SidePaneContext);
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
  /** Host capability filter. This is separate from `unavailableReason`: an
   * unavailable-but-real surface can remain discoverable, while a host that
   * cannot render a surface at all must omit it and refuse stale opens. */
  readonly shouldIncludeTab?: (tab: SidePaneTabDefinition) => boolean;
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
  shouldIncludeTab = INCLUDE_EVERY_TAB,
  preferences = defaultPreferences,
}: SidePaneWorkspaceProps) {
  const generatedId = useId();
  const paneId = `session-side-pane-${generatedId}`;
  const titleId = `${paneId}-title`;
  const openerRef = useRef<HTMLElement | null>(null);
  const registeredTabs = useSyncExternalStore(subscribeSidePaneTabRegistry, getSidePaneTabDefinitions);
  const allTabs = useMemo(() => registeredTabs.filter(shouldIncludeTab), [registeredTabs, shouldIncludeTab]);
  const state = useSyncExternalStore(subscribeSidePaneTabsState, () => readSidePaneTabsState(scope));
  const storedPreferences = useSyncExternalStore(preferences.subscribe, () => preferences.snapshot());
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [everRetained, setEverRetained] = useState<ReadonlySet<SidePaneTabId>>(() => new Set());
  const compact = presentation === 'sheet';
  const paneWidth = previewWidth ?? storedPreferences.width;
  // `allTabs` is deliberately read here as well as passed to the picker: a
  // registry subscription must re-resolve an already-open registered tab.
  const openTabDefs = sortSidePaneTabs(state.open, state.instances)
    .map(id => resolveSidePaneTab(scope, id))
    .filter(
      (definition): definition is SidePaneTabDefinition => definition !== undefined && shouldIncludeTab(definition),
    );

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
      const definition = resolveSidePaneTab(scope, tab);
      if (definition === undefined || !shouldIncludeTab(definition)) return;
      if (opener) openerRef.current = opener;
      openSidePaneTab(scope, tab);
    },
    [scope, shouldIncludeTab],
  );
  const openNewInstance = useCallback(
    (kind: SidePaneInstanceKind) => {
      const catalogueId: SidePaneTabId = kind === 'browser' ? 'browser' : kind === 'file' ? 'files' : 'terminals';
      const definition = resolveSidePaneTab(scope, catalogueId);
      if (definition === undefined || !shouldIncludeTab(definition)) return;
      if (kind === 'browser') openSidePaneBrowserTab(scope, null, { forceNew: true });
      else if (kind === 'file') openSidePaneTab(scope, 'files');
      else openSidePaneTab(scope, 'terminals');
    },
    [scope, shouldIncludeTab],
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
  const resolvedActiveDef = state.active ? resolveSidePaneTab(scope, state.active) : undefined;
  const activeDef = resolvedActiveDef && shouldIncludeTab(resolvedActiveDef) ? resolvedActiveDef : undefined;
  const browserActive = activeDef?.instance?.kind === 'browser';
  const fullViewport = browserActive && state.fullViewport === true;
  const enterFullViewport = useCallback(() => {
    if (browserActive) setSidePaneFullViewport(scope, true);
  }, [browserActive, scope]);
  const exitFullViewport = useCallback(() => setSidePaneFullViewport(scope, false), [scope]);
  useEffect(() => {
    if (!fullViewport) return;
    const exitOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // Capture before the remote browser canvas can send Escape into the page:
      // in full view it is the explicit way back to Ferretry.
      event.preventDefault();
      event.stopPropagation();
      exitFullViewport();
    };
    document.addEventListener('keydown', exitOnEscape, true);
    return () => document.removeEventListener('keydown', exitOnEscape, true);
  }, [exitFullViewport, fullViewport]);
  useEffect(() => {
    // A deep link can reopen a retained instance before this host mounts. If
    // this workspace cannot render that definition, clear only its active
    // selection so the pane cannot stay wedged invisibly; the tab record stays
    // available to a host that does support it.
    if (state.active !== null && activeDef === undefined) deactivateSidePane(scope);
  }, [activeDef, scope, state.active]);
  if (activeDef) lastTabRef.current = activeDef;
  else if (state.active !== null) lastTabRef.current = null;
  const displayDef = activeDef ?? (compact ? lastTabRef.current : undefined);
  const surfaceOpen = state.active !== null && activeDef !== undefined;
  const liveRetained = [...everRetained].filter(id => {
    const definition = resolveSidePaneTab(scope, id);
    return definition?.retain === true && shouldIncludeTab(definition);
  });
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
      {renderSurface({
        scope,
        tab,
        presentation,
        titleId,
        onClose: close,
        isActive: active && isCurrent,
        fullViewport,
        onEnterFullViewport: enterFullViewport,
        onExitFullViewport: exitFullViewport,
      })}
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
  const host: SidePaneHost = {
    scope,
    presentation,
    open,
    close,
    openNewInstance,
    fullViewport,
    enterFullViewport,
    exitFullViewport,
  };

  return (
    <SidePaneContext.Provider value={host}>
      <div className="flex h-full min-h-0 min-w-0 w-full gap-2">
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
        {(paneVisible || fullViewport) && (
          <SidePaneShell
            id={paneId}
            titleId={titleId}
            onClose={close}
            width={paneWidth}
            onWidthPreview={setPreviewWidth}
            onWidthCommit={commitWidth}
            hidden={!surfaceOpen}
            fullViewport={fullViewport}
            onExitFullViewport={exitFullViewport}
          >
            {state.active && !fullViewport && (
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
            {browserActive && !fullViewport && (
              <div className="flex shrink-0 justify-end border-b border-border-soft px-2 py-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={enterFullViewport}
                  className="min-h-[44px] justify-center gap-xs px-2"
                  aria-label="Expand browser to fill the viewport"
                  title="Expand browser to full screen"
                >
                  <Maximize2 size={16} aria-hidden="true" />
                  Full screen
                </Button>
              </div>
            )}
            {ordinaryBody}
            {retainedBodies}
          </SidePaneShell>
        )}
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {state.active ? `Opened ${activeDef?.instance?.label ?? activeDef?.label ?? state.active}` : ''}
        </div>
        {compact && displayDef && !fullViewport && (
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
            {browserActive && (
              <div className="flex shrink-0 justify-end border-b border-border-soft px-2 py-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={enterFullViewport}
                  className="min-h-[44px] justify-center gap-xs px-2"
                  aria-label="Expand browser to fill the viewport"
                  title="Expand browser to full screen"
                >
                  <Maximize2 size={16} aria-hidden="true" />
                  Full screen
                </Button>
              </div>
            )}
            {ordinaryBody}
          </BottomSheet>
        )}
      </div>
    </SidePaneContext.Provider>
  );
}
