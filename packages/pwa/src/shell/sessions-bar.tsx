/**
 * THE SESSIONS BAR — the app's left edge on every machine page (the approved session-view redesign).
 *
 * It replaces three things at once: the Sessions tab, the top navigation row and the duplicate search
 * box. What is on it, top to bottom:
 *
 *   - the machine this page belongs to, which is also the machine switcher, and ＋ for a new session;
 *   - ONE search: the finder (⌘K) everywhere, or this session's own file search on a session page;
 *   - All · Needs you · Running, each with the count choosing it would show;
 *   - the sessions, grouped by project, each a status dot, the agent's name, a "needs you" badge and
 *     one line of what it is doing — the open one is a soft filled pill, never a side bar;
 *   - Projects, Insights (Analytics, Warden, Learning) and Settings, at the bottom.
 *
 * THREE PRESENTATIONS, ONE CONTENT. A desktop column the reader may collapse to an icon rail, a rail the
 * viewport forces below 1100px, and on a phone a drawer behind the session bar's ☰ — modal, with a scrim,
 * Escape and focus handled by the app's one dialog hook. The drawer closes itself on every navigation it
 * starts, because the page it opened is underneath it.
 */

import type { SessionView } from '@ferretry/protocol';
import { ChartNoAxesCombined, ChevronDown, FolderKanban, Menu, Plus, Search, Settings, X } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import { cn } from '../lib/class-names.ts';
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
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from './context-menu.tsx';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from './palette-shortcut.ts';
import { RouteLink } from './route-link.tsx';
import { needsYou, type SessionsBarFilter, sessionsBarSubline, sessionsBarView } from './sessions-bar-model.ts';
import { StatusMark } from './status-mark.tsx';
import { displayCallsign } from '../lib/callsign.ts';

/** The places at the foot of the bar. Insights is Analytics, Warden and Learning together. */
export type SessionsBarPlace = 'sessions' | 'projects' | 'insights' | 'settings';

export const SESSIONS_BAR_PLACES = [
  { id: 'projects', label: 'Projects', path: daemonProjectsPath, Icon: FolderKanban },
  { id: 'insights', label: 'Insights', path: daemonAnalyticsPath, Icon: ChartNoAxesCombined },
  { id: 'settings', label: 'Settings', path: daemonSettingsPath, Icon: Settings },
] as const;

const FILTER_LABEL: Readonly<Record<SessionsBarFilter, string>> = {
  all: 'All',
  'needs-you': 'Needs you',
  running: 'Running',
};
const FILTER_ORDER: readonly SessionsBarFilter[] = ['all', 'needs-you', 'running'];

/** Another paired machine the switcher can take the reader to. */
export interface SessionsBarMachine {
  readonly daemonId: DaemonId;
  readonly name: string;
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
  /** Injected clock, so "finished in the last day" is testable. */
  readonly now?: () => number;
}

function SessionRow({
  view,
  daemonId,
  active,
  onNavigate,
}: {
  readonly view: SessionView;
  readonly daemonId: DaemonId;
  readonly active: boolean;
  readonly onNavigate: (to: string) => void;
}) {
  const name = displayCallsign(view.config.teammate) || view.config.label || view.config.id;
  const waiting = needsYou(view);
  return (
    <li>
      <RouteLink
        aria-current={active ? 'page' : undefined}
        className="fy-sbar__session"
        data-sbar-session={view.config.id}
        onNavigate={onNavigate}
        title={`${name} — ${sessionsBarSubline(view)}`}
        to={daemonSessionPath(daemonId, view.config.id)}
      >
        <StatusMark view={view} />
        <span className="fy-sbar__name">{name}</span>
        {waiting ? (
          <span className="fy-sbar__badge" data-sbar-needs-you="">
            needs you
          </span>
        ) : null}
        <span className="fy-sbar__sub">{sessionsBarSubline(view)}</span>
      </RouteLink>
    </li>
  );
}

function MachineSwitcher({
  daemonId,
  machineName,
  machines,
  onNavigate,
  onAddMachine,
}: Pick<SessionsBarProps, 'daemonId' | 'machineName' | 'machines' | 'onNavigate' | 'onAddMachine'>) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const items: readonly ContextMenuItem[] = [
    ...machines.map(machine => ({
      key: String(machine.daemonId),
      label: machine.name,
      ...(machine.daemonId === daemonId ? { detail: 'this one' } : {}),
      onSelect: () => onNavigate(daemonSessionsPath(machine.daemonId)),
    })),
    { key: 'add-machine', label: 'Add a machine…', onSelect: onAddMachine },
  ];
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label={`Machine: ${machineName}. Switch machine`}
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
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      <ContextMenu
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="Switch machine"
        items={items}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        triggerRef={trigger}
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

/** The column's and the drawer's content: everything but the frame. */
function SessionsBarBody(props: SessionsBarProps & { readonly navigate: (to: string) => void }) {
  const { daemonId, sessions, projects, activeSessionId, active, navigate, now = Date.now } = props;
  const [filter, setFilter] = useState<SessionsBarFilter>('all');
  const view = sessionsBarView(sessions ?? [], projects, filter, now(), activeSessionId);
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
      <fieldset aria-label="Show sessions" className="fy-sbar__filters">
        {FILTER_ORDER.map(id => (
          <button
            aria-pressed={filter === id}
            className="fy-sbar__chip"
            data-sbar-filter={id}
            key={id}
            onClick={() => setFilter(id)}
            type="button"
          >
            {FILTER_LABEL[id]} <span className="fy-sbar__count">{view.counts[id]}</span>
          </button>
        ))}
      </fieldset>
      <div className="fy-sbar__list scroll-thin">
        {sessions === null ? (
          <p className="fy-sbar__empty" role="status">
            Reading sessions…
          </p>
        ) : view.groups.length === 0 ? (
          <p className="fy-sbar__empty">
            {filter === 'all' ? 'No sessions running.' : `No sessions match ${FILTER_LABEL[filter]}.`}
          </p>
        ) : (
          view.groups.map(group => (
            <section aria-label={group.name} className="fy-sbar__group" key={group.path || group.name}>
              <h2 className="fy-sbar__project">
                <span className="truncate">{group.name}</span>
                <span className="fy-sbar__count">{group.rows.length}</span>
              </h2>
              <ul>
                {group.rows.map(row => (
                  <SessionRow
                    active={row.config.id === activeSessionId}
                    daemonId={daemonId}
                    key={row.config.id}
                    onNavigate={navigate}
                    view={row}
                  />
                ))}
              </ul>
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
      />
      <RouteLink
        aria-label="New session"
        className="fy-sbar__icon"
        data-sbar-new=""
        onNavigate={props.navigate}
        title="New session"
        to={daemonNewSessionPath(props.daemonId)}
      >
        <Plus aria-hidden="true" size={16} />
      </RouteLink>
    </div>
  );
}

/** The collapsed form: the same places and sessions, as icons and status dots. */
function SessionsRail(props: SessionsBarProps) {
  const { daemonId, sessions, projects, activeSessionId, active, onNavigate, now = Date.now } = props;
  const view = sessionsBarView(sessions ?? [], projects, 'all', now(), activeSessionId);
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
      <RouteLink
        aria-label="New session"
        className="fy-sbar__icon"
        onNavigate={onNavigate}
        title="New session"
        to={daemonNewSessionPath(daemonId)}
      >
        <Plus aria-hidden="true" size={16} />
      </RouteLink>
      <FindButton iconOnly onOpen={props.onOpenPalette} shortcut />
      <ul className="fy-sbar__list fy-sbar__dots scroll-thin">
        {view.groups.flatMap(group =>
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

function SessionsDrawer(props: SessionsBarProps) {
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
      <div className="fy-sbar fy-sbar--drawer">
        <SessionsBarTop {...props} navigate={navigate} />
        <SessionsBarBody {...props} navigate={navigate} />
      </div>
    </div>
  );
}

export function SessionsBar(props: SessionsBarProps) {
  if (props.presentation === 'drawer') return <SessionsDrawer {...props} />;
  if (props.presentation === 'rail') return <SessionsRail {...props} />;
  return (
    <nav aria-label="Sessions" className={cn('fy-sbar', 'fy-sbar--column')} data-sessions-bar="column">
      <SessionsBarTop {...props} navigate={props.onNavigate} />
      <SessionsBarBody {...props} navigate={props.onNavigate} />
    </nav>
  );
}
