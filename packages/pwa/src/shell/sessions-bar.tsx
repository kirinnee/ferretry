/**
 * THE SESSIONS BAR — the app's left edge on every machine page (the approved session-view redesign).
 *
 * It replaces three things at once: the Sessions tab, the top navigation row and the duplicate search
 * box. What is on it, top to bottom:
 *
 *   - the machine this page belongs to, which is also the machine switcher, and ＋ for a new session;
 *   - ONE search: the finder (⌘K) everywhere, or this session's own file search on a session page;
 *   - Interactive · All · Agents, each with the count choosing it would show, and "Show stopped";
 *   - EVERY live session, grouped by project, each a status dot, the agent's name, a "needs you" badge, a
 *     line of what it is doing and the directory it runs in — the open one is a soft filled pill;
 *   - Projects, Insights (Analytics, Warden, Learning) and Settings, at the bottom.
 *
 * THREE PRESENTATIONS, ONE CONTENT. A desktop column — expanded by default at every width above a phone,
 * collapsible to an icon rail by the reader's own choice (remembered per device) and drag-resizable —
 * and on a phone a drawer behind the session bar's ☰ — modal, with a scrim,
 * Escape and focus handled by the app's one dialog hook. The drawer closes itself on every navigation it
 * starts, because the page it opened is underneath it.
 */

import type { SessionView } from '@ferretry/protocol';
import { ChartNoAxesCombined, ChevronDown, FolderKanban, Menu, Plus, QrCode, Search, Settings, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MachineLearners } from '../features/learning/passive-learning.tsx';
import { pairPhoneLabel } from '../features/settings/pair-phone.tsx';
import { RailDivider } from '../features/workspace/split-divider.tsx';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import { useInputModality } from '../hooks/use-input-modality.ts';
import { allMachinesView, type MachineSource } from '../lib/all-machines.ts';
import { displayCallsign } from '../lib/callsign.ts';
import { cn } from '../lib/class-names.ts';
import type { Density, ModeFilter } from '../lib/controls.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import type { FleetProject } from '../lib/fleet-grouping.ts';
import {
  daemonAnalyticsPath,
  daemonNewSessionPath,
  daemonProjectsPath,
  daemonSessionPath,
  daemonSessionsPath,
  daemonSettingsPath,
} from '../lib/pages/routes.ts';
import { type WorkspaceRailPreferenceStore, workspaceRailPreferences } from '../lib/workspace-rail-preferences.ts';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from './context-menu.tsx';
import type { MoveMachine } from './machine-reorder.tsx';
import { NewSessionMenu, withReach } from './new-session-menu.tsx';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from './palette-shortcut.ts';
import { RouteLink } from './route-link.tsx';
import { type OpenRowMenu, SessionMenuContext, type SessionMenuState } from './session-menu-context.ts';
import { SessionsBarOptions } from './sessions-bar-density.tsx';
import { SessionsBarFilters, sessionsBarEmptyMessage } from './sessions-bar-filters.tsx';
import { SessionsBarMachines, SessionsRailMachineDots } from './sessions-bar-machines.tsx';
import {
  DEFAULT_LIST_FILTER,
  type SessionsListFilter,
  sessionsBarSubline,
  sessionsBarView,
  sidebarCompact,
} from './sessions-bar-model.ts';
import { sessionTree } from './sessions-bar-tree.ts';
import { SessionsBarTree } from './sessions-bar-tree.tsx';
import { StatusMark } from './status-mark.tsx';

/** The places at the foot of the bar. Insights is Analytics, Warden and Learning together. */
export type SessionsBarPlace = 'sessions' | 'projects' | 'insights' | 'settings';

export const SESSIONS_BAR_PLACES = [
  { id: 'projects', label: 'Projects', path: daemonProjectsPath, Icon: FolderKanban },
  { id: 'insights', label: 'Insights', path: daemonAnalyticsPath, Icon: ChartNoAxesCombined },
  { id: 'settings', label: 'Settings', path: daemonSettingsPath, Icon: Settings },
] as const;

/** Another paired machine the switcher can take the reader to. */
export interface SessionsBarMachine {
  readonly daemonId: DaemonId;
  readonly name: string;
  /** Its daemon said a newer release exists (`useMachineUpdates`): a dot in the machine menu. */
  readonly updateAvailable?: boolean;
}

export type SessionsBarPresentation = 'column' | 'rail' | 'drawer';

/** The reload offer's wording and tone, as the app bar's chip has always worded it. */
export interface SessionsBarUpdate {
  readonly label: string;
  readonly title: string;
  readonly tone: 'accent' | 'warn';
}

export interface SessionsBarProps {
  readonly daemonId: DaemonId;
  /** This machine's name, as the reader labelled it. */
  readonly machineName: string;
  /** Every paired machine, this one included, for the switcher. */
  readonly machines: readonly SessionsBarMachine[];
  /** This machine's sessions; `null` while they have not been read. */
  readonly sessions: readonly SessionView[] | null;
  readonly projects: readonly FleetProject[];
  /** The session on screen, if the page is a session. */
  readonly activeSessionId: string | null;
  /** The foot place the page belongs to, if any. */
  readonly active: SessionsBarPlace | null;
  readonly presentation: SessionsBarPresentation;
  readonly onNavigate: (to: string) => void;
  /** Opens the finder. */
  readonly onOpenPalette: () => void;
  /** On a session page: that session's own search, which replaces the finder box. */
  readonly search?: ReactNode;
  /** A newer release waiting, or a tab that failed to load part of itself: an offer, never a reload. */
  readonly update?: SessionsBarUpdate;
  readonly onApplyUpdate?: () => void;
  /** Column only: the reader asked for the icon rail. */
  readonly onCollapse?: () => void;
  /** Rail only: back to the full column. */
  readonly onExpand?: () => void;
  /** Drawer only: closes it. */
  readonly onClose?: () => void;
  readonly onAddMachine: () => void;
  /** Drops a machine heading beside another, from the all-machines list. Absent: the headings stay put. */
  readonly onMoveMachine?: MoveMachine;
  /**
   * How much a row says: the device's Density setting, `null`/absent while the reader has not chosen. Only
   * Full draws the three-line rows; every other value, and no choice, draws one line per session.
   */
  readonly density?: Density | null;
  /** The reader chose a density in the bar's options menu. Absent: the bar offers no such menu. */
  readonly onDensityChange?: (density: Density) => void;
  /** The kind filter this device remembered, read when the bar opens. Absent or null: Interactive. */
  readonly initialMode?: ModeFilter | null;
  /** The reader chose a kind: store it for this device. Absent: the choice lasts only while the bar does. */
  readonly onModeChange?: (mode: ModeFilter) => void;
  /**
   * Opens "Pair a phone with ‹this machine›". Absent when the reader may not pair a device with this
   * machine (`pairing.use` is closed), and then the switcher does not offer it.
   */
  readonly onPairPhone?: () => void;
  /** Sessions instructed to file lessons, which carry a "Learning: passive" chip. */
  readonly learningPassive?: ReadonlySet<string>;
  /** Across every machine: each listed machine's own learners, so every machine's rows carry the mark. */
  readonly machineLearners?: MachineLearners;
  /** Present only while this machine has no runtime: the empty list then leads with creating one. */
  readonly createRuntimeHref?: string;
  /** Where the column's width is remembered. The page-wide store by default, shared with the context rail. */
  readonly rails?: WorkspaceRailPreferenceStore;
  /**
   * Every paired machine's sessions, when the reader's Sessions list setting is All machines: the bar
   * then lists them all (Needs you first, then machine by machine) instead of `sessions` alone.
   */
  readonly machineSources?: readonly MachineSource[];
  /** The clock a machine's "last seen" is measured against. */
  readonly now?: number;
  /**
   * The menu a row opens (right-click, long-press, the Menu key): the host draws it for the pressed ferret.
   * Absent, rows have no menu and the browser's own is left alone.
   */
  readonly renderSessionMenu?: (menu: SessionMenuState, close: (restoreFocus: boolean) => void) => ReactNode;
}

/**
 * The machine menu: every paired machine, then the acts. Two of those acts both "add" something, in
 * opposite directions, so they are worded and marked apart: "Pair a phone with ‹this machine›…" (a QR
 * mark) hands ANOTHER device access to this machine; "Add a machine…" (＋) pairs THIS browser with
 * another computer. The divider is the line between the list and the acts.
 */
const machineMenuItems = ({
  daemonId,
  machineName,
  machines,
  onNavigate,
  onAddMachine,
  onPairPhone,
}: Pick<
  SessionsBarProps,
  'daemonId' | 'machineName' | 'machines' | 'onNavigate' | 'onAddMachine' | 'onPairPhone'
>): readonly ContextMenuItem[] => [
  ...machines.map(machine => ({
    key: String(machine.daemonId),
    label: machine.name,
    ...(machine.daemonId === daemonId || machine.updateAvailable === true
      ? {
          detail: [
            machine.daemonId === daemonId ? 'this one' : '',
            machine.updateAvailable === true ? 'update available' : '',
          ]
            .filter(Boolean)
            .join(' · '),
        }
      : {}),
    ...(machine.updateAvailable === true
      ? { icon: <span aria-hidden="true" className="kt-dot bg-accent" data-machine-menu-update="" /> }
      : {}),
    onSelect: () => onNavigate(daemonSessionsPath(machine.daemonId)),
  })),
  ...(onPairPhone === undefined
    ? []
    : [
        {
          key: 'pair-phone',
          label: `${pairPhoneLabel(machineName)}…`,
          icon: <QrCode aria-hidden="true" size={14} />,
          onSelect: onPairPhone,
          separatorBefore: true,
        },
      ]),
  {
    key: 'add-machine',
    label: 'Add a machine…',
    icon: <Plus aria-hidden="true" size={14} />,
    onSelect: onAddMachine,
    ...(onPairPhone === undefined ? { separatorBefore: true } : {}),
  },
];

function MachineSwitcher(
  props: Pick<
    SessionsBarProps,
    'daemonId' | 'machineName' | 'machines' | 'onNavigate' | 'onAddMachine' | 'onPairPhone'
  >,
) {
  const { machineName, onPairPhone } = props;
  const anyUpdate = props.machines.some(machine => machine.updateAvailable === true);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { touchAffected } = useInputModality();
  const items = machineMenuItems({
    ...props,
    // The sheet that opens captures whatever has focus as the place to return to. The menu's own
    // activation hands focus to nobody (the item is about to unmount), so it is put back on the
    // switcher first: closing the sheet then lands the reader where they started.
    ...(onPairPhone === undefined
      ? {}
      : {
          onPairPhone: () => {
            trigger.current?.focus();
            onPairPhone();
          },
        }),
  });
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label={`Machine: ${machineName}. Switch machine${anyUpdate ? '. An update is available' : ''}`}
        className="fy-sbar__machine"
        data-sbar-machine=""
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          setAnchor({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
        }}
        ref={trigger}
        type="button"
      >
        <span className="fy-sbar__machine-name">{machineName}</span>
        {anyUpdate ? (
          <span
            aria-hidden="true"
            className="kt-dot bg-accent"
            data-sbar-machine-update=""
            title="An update is available"
          />
        ) : null}
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      <ContextMenu
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="Switch machine"
        items={items}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        triggerRef={trigger}
        touch={touchAffected}
      />
    </>
  );
}

/**
 * The finder's opener. It claims Cmd/Ctrl+K only where the chord opens it: on a session page the
 * chord belongs to that session's own search, so the icon beside it stays silent about a key.
 */
function FindButton({
  onOpen,
  iconOnly,
  shortcut,
}: {
  readonly onOpen: () => void;
  readonly iconOnly: boolean;
  readonly shortcut: boolean;
}) {
  return (
    <button
      aria-keyshortcuts={shortcut ? PALETTE_KEYSHORTCUTS : undefined}
      aria-label="Find sessions, settings and places"
      className={iconOnly ? 'fy-sbar__icon' : 'kt-findbox fy-sbar__find'}
      data-app-bar-destination-search=""
      onClick={onOpen}
      title="Find sessions, settings and places"
      type="button"
    >
      <Search aria-hidden="true" size={14} />
      {iconOnly ? null : (
        <>
          <span>Find</span>
          {shortcut ? <kbd>{paletteShortcutLabel()}</kbd> : null}
        </>
      )}
    </button>
  );
}

/** The reader's filter, kept by the bar itself so the column, the rail and the drawer all follow it. */
interface ListFilterProps {
  readonly listFilter: SessionsListFilter;
  readonly onListFilterChange: (next: SessionsListFilter) => void;
}

/** The open session stays listed whatever the filter says: a bar that drops the page on screen reads as broken. */
const isOpen =
  (activeSessionId: string | null) =>
  (view: SessionView): boolean =>
    view.config.id === activeSessionId;

/** Every machine's list under the same filter; only this machine's rows may be the open one. */
const allMachinesFor = (props: SessionsBarProps, listFilter: SessionsListFilter) =>
  props.machineSources === undefined
    ? null
    : allMachinesView(props.machineSources, {
        filter: listFilter,
        keep: (machine, view) => machine === props.daemonId && view.config.id === props.activeSessionId,
        sortRows: true,
      });

const densityWord = (density: Density | null | undefined): 'compact' | 'comfortable' =>
  sidebarCompact(density) ? 'compact' : 'comfortable';

/** The column's and the drawer's content: everything but the frame. */
function SessionsBarBody(props: SessionsBarProps & ListFilterProps & { readonly navigate: (to: string) => void }) {
  const { daemonId, sessions, projects, activeSessionId, active, navigate, listFilter } = props;
  const view = sessionsBarView(sessions ?? [], projects, listFilter, isOpen(activeSessionId));
  const machineView = allMachinesFor(props, listFilter);
  const { counts, hiddenStopped } = machineView ?? view;
  return (
    <>
      {props.update === undefined ? null : (
        <button
          className="kt-badge fy-sbar__notice"
          data-sbar-update=""
          data-tone={props.update.tone}
          onClick={props.onApplyUpdate}
          title={props.update.title}
          type="button"
        >
          {props.update.label}
        </button>
      )}
      <div className="fy-sbar__search">
        {props.search === undefined ? (
          <FindButton iconOnly={false} onOpen={props.onOpenPalette} shortcut />
        ) : (
          <>
            <div className="min-w-0 flex-1">{props.search}</div>
            <FindButton iconOnly onOpen={props.onOpenPalette} shortcut={false} />
          </>
        )}
      </div>
      <SessionsBarFilters
        counts={counts}
        filter={listFilter}
        hiddenStopped={hiddenStopped}
        onChange={props.onListFilterChange}
      />
      <div className="fy-sbar__list scroll-thin">
        {machineView !== null ? (
          !machineView.loaded ? (
            <p className="fy-sbar__empty" role="status">
              Reading sessions…
            </p>
          ) : listFilter.mode !== 'all' && machineView.needsYou.length === 0 && machineView.machines.length === 0 ? (
            <p className="fy-sbar__empty">{sessionsBarEmptyMessage(listFilter, hiddenStopped)}</p>
          ) : (
            <SessionsBarMachines
              activeSessionId={activeSessionId}
              daemonId={daemonId}
              {...(props.learningPassive === undefined ? {} : { learningPassive: props.learningPassive })}
              {...(props.machineLearners === undefined ? {} : { machineLearners: props.machineLearners })}
              {...(props.onMoveMachine === undefined ? {} : { onMoveMachine: props.onMoveMachine })}
              now={props.now ?? Date.now()}
              onNavigate={navigate}
              view={machineView}
            />
          )
        ) : sessions === null ? (
          <p className="fy-sbar__empty" role="status">
            Reading sessions…
          </p>
        ) : view.groups.length === 0 ? (
          <div className="fy-sbar__empty">
            <p className="m-0">
              {listFilter.mode === 'all' && props.createRuntimeHref !== undefined
                ? 'No sessions yet, and nothing can start until this machine has a runtime.'
                : sessionsBarEmptyMessage(listFilter, hiddenStopped)}
            </p>
            {listFilter.mode === 'all' && props.createRuntimeHref !== undefined && (
              <RouteLink
                className="kt-btn mt-2"
                data-variant="primary"
                data-sessions-create-runtime=""
                onNavigate={navigate}
                to={props.createRuntimeHref}
              >
                Create a runtime
              </RouteLink>
            )}
          </div>
        ) : (
          view.groups.map(group => (
            <section aria-label={group.name} className="fy-sbar__group" key={group.path || group.name}>
              <h2 className="fy-sbar__project">
                <span className="truncate">{group.name}</span>
                <span className="fy-sbar__count">{group.rows.length}</span>
              </h2>
              <SessionsBarTree
                activeSessionId={activeSessionId}
                daemonId={daemonId}
                entries={sessionTree(group.rows, sessions ?? [])}
                isActive={row => row.config.id === activeSessionId}
                learns={row => props.learningPassive?.has(row.config.id) === true}
                onNavigate={navigate}
              />
            </section>
          ))
        )}
      </div>
      <nav aria-label="App" className="fy-sbar__foot">
        {SESSIONS_BAR_PLACES.map(place => (
          <RouteLink
            aria-current={active === place.id ? 'page' : undefined}
            className="fy-sbar__place"
            data-sbar-place={place.id}
            key={place.id}
            onNavigate={navigate}
            to={place.path(daemonId)}
          >
            <place.Icon aria-hidden="true" size={15} />
            <span>{place.label}</span>
          </RouteLink>
        ))}
      </nav>
    </>
  );
}

/**
 * "+ New": a plain link to this machine's new-session page — or, when the list shows every machine and
 * there is more than one, a menu asking which machine, this one first.
 */
function NewSessionControl({
  props,
  navigate,
  marked,
}: {
  readonly props: SessionsBarProps;
  readonly navigate: (to: string) => void;
  /** The column's control carries `data-sbar-new`; the rail's never did. */
  readonly marked: boolean;
}) {
  if (props.machineSources !== undefined && props.machines.length > 1)
    return (
      <NewSessionMenu
        className="fy-sbar__icon"
        current={props.daemonId}
        machines={withReach(props.machines, props.machineSources)}
        onNavigate={navigate}
      >
        <Plus aria-hidden="true" size={16} />
      </NewSessionMenu>
    );
  return (
    <RouteLink
      aria-label="New session"
      className="fy-sbar__icon"
      {...(marked ? { 'data-sbar-new': '' } : {})}
      onNavigate={navigate}
      title="New session"
      to={daemonNewSessionPath(props.daemonId)}
    >
      <Plus aria-hidden="true" size={16} />
    </RouteLink>
  );
}

function SessionsBarTop(props: SessionsBarProps & { readonly navigate: (to: string) => void }) {
  const drawer = props.presentation === 'drawer';
  return (
    <div className="fy-sbar__top">
      {drawer ? (
        <button aria-label="Close sessions" className="fy-sbar__icon" onClick={props.onClose} type="button">
          <X aria-hidden="true" size={16} />
        </button>
      ) : (
        <button
          aria-label="Collapse the sessions bar"
          className="fy-sbar__icon"
          data-sbar-collapse=""
          onClick={props.onCollapse}
          title="Collapse"
          type="button"
        >
          <Menu aria-hidden="true" size={16} />
        </button>
      )}
      <MachineSwitcher
        daemonId={props.daemonId}
        machineName={props.machineName}
        machines={props.machines}
        onAddMachine={props.onAddMachine}
        onNavigate={props.navigate}
        {...(props.onPairPhone === undefined ? {} : { onPairPhone: props.onPairPhone })}
      />
      {props.onDensityChange === undefined ? null : (
        <SessionsBarOptions compact={sidebarCompact(props.density)} onChange={props.onDensityChange} />
      )}
      <NewSessionControl marked navigate={props.navigate} props={props} />
    </div>
  );
}

/** The collapsed form: the same places and sessions, as icons and status dots. */
function SessionsRail(props: SessionsBarProps & ListFilterProps) {
  const { daemonId, sessions, projects, activeSessionId, active, onNavigate, listFilter } = props;
  const view = sessionsBarView(sessions ?? [], projects, listFilter, isOpen(activeSessionId));
  const machineView = allMachinesFor(props, listFilter);
  return (
    <nav aria-label="Sessions" className="fy-sbar fy-sbar--rail" data-sessions-bar="rail">
      {props.onExpand === undefined ? null : (
        <button
          aria-label="Expand the sessions bar"
          className="fy-sbar__icon"
          data-sbar-expand=""
          onClick={props.onExpand}
          title="Expand"
          type="button"
        >
          <Menu aria-hidden="true" size={16} />
        </button>
      )}
      <NewSessionControl marked={false} navigate={onNavigate} props={props} />
      <FindButton iconOnly onOpen={props.onOpenPalette} shortcut />
      <ul className="fy-sbar__list fy-sbar__dots scroll-thin">
        {machineView !== null ? (
          <SessionsRailMachineDots
            activeSessionId={activeSessionId}
            daemonId={daemonId}
            onNavigate={onNavigate}
            view={machineView}
          />
        ) : (
          view.groups.flatMap(group =>
            group.rows.map(row => {
              const name = displayCallsign(row.config.teammate) || row.config.label || row.config.id;
              return (
                <li key={row.config.id}>
                  <RouteLink
                    aria-current={row.config.id === activeSessionId ? 'page' : undefined}
                    aria-label={name}
                    className="fy-sbar__dot"
                    onNavigate={onNavigate}
                    title={`${name} — ${sessionsBarSubline(row)}`}
                    to={daemonSessionPath(daemonId, row.config.id)}
                  >
                    <StatusMark view={row} />
                  </RouteLink>
                </li>
              );
            }),
          )
        )}
      </ul>
      <div className="fy-sbar__foot fy-sbar__foot--rail">
        {SESSIONS_BAR_PLACES.map(place => (
          <RouteLink
            aria-current={active === place.id ? 'page' : undefined}
            aria-label={place.label}
            className="fy-sbar__icon"
            key={place.id}
            onNavigate={onNavigate}
            title={place.label}
            to={place.path(daemonId)}
          >
            <place.Icon aria-hidden="true" size={16} />
          </RouteLink>
        ))}
      </div>
    </nav>
  );
}

function SessionsDrawer(props: SessionsBarProps & ListFilterProps) {
  const panel = useRef<HTMLDivElement | null>(null);
  const close = props.onClose ?? (() => undefined);
  const { onKeyDown } = useDialogFocus(true, panel, close);
  const navigate = (to: string): void => {
    close();
    props.onNavigate(to);
  };
  return (
    <div
      aria-label="Sessions"
      aria-modal="true"
      className="kt-overlay fixed inset-0 z-40"
      data-sessions-bar="drawer"
      onKeyDown={onKeyDown}
      ref={panel}
      role="dialog"
      tabIndex={-1}
    >
      <button
        aria-label="Close sessions"
        className="absolute inset-0 bg-scrim"
        onClick={close}
        tabIndex={-1}
        type="button"
      />
      <div className="fy-sbar fy-sbar--drawer" data-sbar-density={densityWord(props.density)}>
        <SessionsBarTop {...props} navigate={navigate} />
        <SessionsBarBody {...props} navigate={navigate} />
      </div>
    </div>
  );
}

/**
 * The full column, at the width the reader dragged it to.
 *
 * The edge is the workspace's own `RailDivider` — drag, arrow keys (Shift for larger steps), and a
 * double-click back to the default — and the width lives in the same remembered store as the context
 * rail's, under `left`, so it survives a reload and is the same on every machine's pages. A drag
 * previews locally and commits once, at the end, so the store is written once per gesture.
 */
function SessionsColumn(props: SessionsBarProps & ListFilterProps) {
  const rails = props.rails ?? workspaceRailPreferences;
  const widths = useSyncExternalStore(rails.subscribe, rails.snapshot, rails.snapshot);
  const [preview, setPreview] = useState<number | null>(null);
  const width = preview ?? widths.left;
  return (
    <>
      <nav
        aria-label="Sessions"
        className={cn('fy-sbar', 'fy-sbar--column')}
        data-sbar-density={densityWord(props.density)}
        data-sessions-bar="column"
        style={{ width: `${width}px` }}
      >
        <SessionsBarTop {...props} navigate={props.onNavigate} />
        <SessionsBarBody {...props} navigate={props.onNavigate} />
      </nav>
      <RailDivider
        onCommit={next => {
          setPreview(null);
          rails.setWidth('left', next);
        }}
        onPreview={setPreview}
        side="left"
        width={width}
      />
    </>
  );
}

/**
 * The row menu's state, kept by the bar so the column, the rail and the drawer share one. A press is a
 * finger when the last thing the reader did was touch a screen; a keyboard open is never one.
 */
function useSessionMenu(enabled: boolean) {
  const [menu, setMenu] = useState<SessionMenuState | null>(null);
  const modality = useRef<string>('mouse');
  useEffect(() => {
    if (!enabled) return;
    const onPointer = (event: PointerEvent): void => {
      modality.current = event.pointerType;
    };
    const onKey = (): void => {
      modality.current = 'keyboard';
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [enabled]);
  const open = useMemo<OpenRowMenu | undefined>(
    () =>
      enabled
        ? (target, x, y, trigger) =>
            setMenu({
              ...target,
              x,
              y,
              trigger,
              touch: modality.current === 'touch' || modality.current === 'pen',
              open: true,
            })
        : undefined,
    [enabled],
  );
  const latest = useRef(menu);
  latest.current = menu;
  const close = useCallback((restoreFocus: boolean): void => {
    const current = latest.current;
    if (restoreFocus && current?.trigger.isConnected === true) current.trigger.focus();
    setMenu(shown => (shown === null ? null : { ...shown, open: false }));
  }, []);
  return { menu, open, close };
}

export function SessionsBar(props: SessionsBarProps) {
  const [listFilter, setListFilter] = useState<SessionsListFilter>({
    ...DEFAULT_LIST_FILTER,
    mode: props.initialMode ?? DEFAULT_LIST_FILTER.mode,
  });
  const onListFilterChange = (next: SessionsListFilter): void => {
    setListFilter(next);
    if (next.mode !== listFilter.mode) props.onModeChange?.(next.mode);
  };
  const { menu, open, close } = useSessionMenu(props.renderSessionMenu !== undefined);
  const filtered = { ...props, listFilter, onListFilterChange };
  const bar =
    props.presentation === 'drawer' ? (
      <SessionsDrawer {...filtered} />
    ) : props.presentation === 'rail' ? (
      <SessionsRail {...filtered} />
    ) : (
      <SessionsColumn {...filtered} />
    );
  return (
    <SessionMenuContext.Provider value={open}>
      {bar}
      {menu === null ? null : props.renderSessionMenu?.(menu, close)}
    </SessionMenuContext.Provider>
  );
}
