/**
 * Top bar — breadcrumb, quiet connection state, app navigation, the Find box and the update/recovery
 * chip — and, on a phone, the bottom app bar. Ported from kteam `ui/src/components/AppBar.tsx`.
 *
 * LEVEL ONE OF THE APP'S NAVIGATION HAS ITS OWN LOOK (the approved usability proposal): plain text
 * links with the current page underlined, never the outlined capital-letter buttons it used to be —
 * those looked exactly like the actions on every page under them. Find is a search box, because it
 * searches. On a phone the same places are a bottom bar — Sessions, Inbox, Projects, Find, Settings
 * and More — above the home indicator, so the top of a phone screen is the page's own.
 *
 * THE INBOX IS A PLACE, NOT A SETTING. It carries a count badge wherever it is drawn (the phone bar, the
 * wide row) — the number of open items across every paired machine, the same number every Inbox
 * badge shows — because the point of it is that the reader sees something is waiting before they look.
 *
 * Three deliberate departures from kteam, all forced by this app's shape:
 *
 * 1. DESTINATIONS ARE DAEMON-SCOPED. kteam linked to bare `/settings`,
 *    `/warden`, `/learning` and `/analytics` because there was exactly one
 *    daemon. Here every destination is built from the daemon whose page the bar
 *    is on (`/d/<daemonId>/settings`), so the bar of one daemon can never
 *    navigate into another daemon's surfaces.
 * 2. NO `HAS_TOKEN` READ-ONLY BADGE. kteam showed it when the daemon had not
 *    substituted a local token, i.e. on a non-loopback origin. This app is a
 *    public static site that is NEVER on the daemon's origin; credentials
 *    always arrive through pairing, so the condition the badge reported cannot
 *    occur and a permanent "read-only" badge would be a lie.
 * 3. STATUS AND THEME ARE PASSED IN, not read from module singletons. The bar
 *    takes the connection status of its own daemon, and the theme control as a
 *    slot. kteam's `showTheme` boolean is gone: passing no slot IS not showing
 *    it, and one prop cannot then contradict the other.
 */

import {
  ChartNoAxesCombined,
  Ellipsis,
  FolderKanban,
  GraduationCap,
  Inbox,
  LayoutList,
  RefreshCw,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Sparkles,
  SquareKanban,
  Users,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useKeyboardOpen } from '../hooks/use-keyboard-open.ts';
import { useLayoutMode } from '../hooks/use-layout-mode.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import {
  daemonAnalyticsPath,
  daemonAgendaPath,
  daemonBoardPath,
  daemonLearningPath,
  daemonProjectsPath,
  daemonSessionsPath,
  daemonSettingsPath,
  daemonSharingPath,
  daemonWardenPath,
  type Route,
} from '../lib/pages/routes.ts';
import { BottomSheet } from './bottom-sheet.tsx';
import { Badge } from './primitives.tsx';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from './palette-shortcut.ts';
import { RouteLink } from './route-link.tsx';
import { UnreadBadge } from './unread-badge.tsx';

/** Why the reload chip is offered. */
export type UpdateReason = 'update' | 'recovery';

/** How this daemon's event stream is doing, in the bar's own vocabulary. */
export type ConnectionStatus = 'open' | 'connecting' | 'reconnecting';

/**
 * The chip's two wordings, as data so they can be asserted directly.
 *
 * THE RECOVERY TITLE NAMES NO CAUSE, and that is a correction rather than a
 * style preference. It used to read "…because a newer version was deployed",
 * but recovery has several possible causes and the chip cannot tell them apart:
 * a plain network blip on a preload raises it with no deploy involved at all,
 * and the chunk error boundary catches every render error — deliberately,
 * because the error a pruned chunk actually produces is an ordinary-looking one
 * that no message filter would recognise — so an everyday render bug raises it
 * too. Blaming a deploy would be a confident lie in most of those cases, and it
 * would send the reader looking for a release note that does not exist.
 *
 * What is true of EVERY path that raises recovery: this tab has already failed
 * to load part of itself, and a reload is the only thing the reader can do
 * about it. That is exactly what the title says and no more. The update wording
 * is untouched — it IS about a version, and it can say so.
 */
export const UPDATE_CHIP = {
  update: {
    label: 'Update ready — reload',
    title: 'A newer version is installed and ready. Reload to use it.',
  },
  recovery: {
    label: 'Reload to recover',
    title: 'This tab could not load part of the app. Reload to recover.',
  },
} as const satisfies Record<UpdateReason, { label: string; title: string }>;

/**
 * THERE IS NO `ACCOUNTS_ENTRY`, and its absence is the point.
 *
 * Accounts was a top-level destination here while everything it shows belongs to ONE machine. Logins
 * and runtimes now live in Settings › Machines, which this bar has never carried either — so the bar
 * offers no row for them. The row was deleted rather than pointed at a path that no longer
 * resolves; `destinationExists` would have dropped such a row silently, which is a worse way to find out.
 */
export const SETTINGS_ENTRY = { label: 'Settings', title: 'Open appearance and density settings' } as const;
export const WARDEN_ENTRY = { label: 'Warden', title: 'Open fleet supervision and verdicts' } as const;
export const LEARNING_ENTRY = { label: 'Learning', title: 'Open fleet learning proposals' } as const;
export const ANALYTICS_ENTRY = { label: 'Analytics', title: 'Query all sessions and graph daily usage' } as const;
export const BOARD_ENTRY = {
  label: 'Board',
  title: 'Every task on every machine as lanes: what is moving, stuck or waiting on you',
} as const;
export const PROJECTS_ENTRY = { label: 'Projects', title: 'Open registered workspaces and folders' } as const;
export const SHARING_ENTRY = {
  label: 'Sharing',
  title: 'Share skills and MCP servers, see what is shared with you, and who can read your catalogs',
} as const;
export const AGENDA_ENTRY = {
  label: 'Inbox',
  title: 'Everything your ferrets are waiting on you for, across every machine',
} as const;

/**
 * The app-level destinations appear in both the wide tab group and the phone
 * selector. Keeping their path builder, label and icon together stops the two
 * navigation affordances from quietly becoming different information
 * architectures. Theme is deliberately not here: it is a control rather than a
 * destination, and stays with the other right-side controls.
 */
export const APP_BAR_DESTINATIONS = [
  { id: 'attention', ...AGENDA_ENTRY, path: daemonAgendaPath, Icon: Inbox },
  { id: 'board', ...BOARD_ENTRY, path: daemonBoardPath, Icon: SquareKanban },
  { id: 'projects', ...PROJECTS_ENTRY, path: daemonProjectsPath, Icon: FolderKanban },
  { id: 'sharing', ...SHARING_ENTRY, path: daemonSharingPath, Icon: Share2 },
  { id: 'analytics', ...ANALYTICS_ENTRY, path: daemonAnalyticsPath, Icon: ChartNoAxesCombined },
  { id: 'warden', ...WARDEN_ENTRY, path: daemonWardenPath, Icon: ShieldCheck },
  { id: 'learning', ...LEARNING_ENTRY, path: daemonLearningPath, Icon: GraduationCap },
  { id: 'settings', ...SETTINGS_ENTRY, path: daemonSettingsPath, Icon: Settings },
] as const;

/**
 * The sessions dashboard, which the bar now names as the first place in the app. It is not one of
 * {@link APP_BAR_DESTINATIONS} because the palette already offers it from its own shell list, and the
 * same row twice would read as two different places.
 */
export const SESSIONS_ENTRY = {
  id: 'sessions',
  label: 'Sessions',
  title: 'Every session on this machine, grouped by project',
  path: daemonSessionsPath,
  Icon: LayoutList,
} as const;

/** Every place the app bar links to, in the order it shows them. */
export const APP_NAVIGATION = [SESSIONS_ENTRY, ...APP_BAR_DESTINATIONS] as const;

type AppNavigationEntry = (typeof APP_NAVIGATION)[number];
export type AppBarDestinationId = AppNavigationEntry['id'];

/** The phone's bottom bar: Sessions · Inbox · Board, then Find and More. Every other place is under More. */
export const TAB_BAR_PLACES: readonly AppBarDestinationId[] = ['sessions', 'attention', 'board'];
export const MORE_PLACES: readonly AppBarDestinationId[] = [
  'projects',
  'sharing',
  'analytics',
  'warden',
  'learning',
  'settings',
];
/** The three Insights views, which sit together under More and share a phone title. */
export const INSIGHTS_PLACES: readonly AppBarDestinationId[] = ['analytics', 'warden', 'learning'];

/**
 * The name a phone's top bar gives the place, overriding the page's own. The Insights views share one:
 * they sit together under More, so the bar says "Insights" while the tabs below it name the view.
 * Every other page is named by the last crumb of its trail ({@link AppBar}).
 */
export const appBarTitle = (active: AppBarDestinationId | null): string | null =>
  active !== null && INSIGHTS_PLACES.includes(active) ? 'Insights' : null;

const entry = (id: AppBarDestinationId): AppNavigationEntry =>
  APP_NAVIGATION.find(candidate => candidate.id === id) ?? SESSIONS_ENTRY;

/** Which destination, if any, the reader is currently on. A session belongs to Sessions. */
export const appBarDestinationForRoute = (route: Route): AppBarDestinationId | null => {
  switch (route.kind) {
    case 'home':
    case 'sessions':
    case 'session':
    case 'new-session':
      return 'sessions';
    case 'attention':
      return 'attention';
    case 'board':
      return 'board';
    case 'projects':
    case 'project-detail':
    case 'project-lanes':
      return 'projects';
    case 'sharing':
    case 'analytics':
    case 'warden':
    case 'learning':
    case 'settings':
      return route.kind;
    default:
      return null;
  }
};

/**
 * Where the phone's bottom bar is shown. Inside a session the composer owns the bottom of the screen,
 * exactly as a messaging app hides its tab bar inside a conversation; everywhere else it is there.
 */
export const showsTabBar = (route: Route): boolean => route.kind !== 'session' && route.kind !== 'new-session';

type MobileDestinationMenuAction = 'open' | 'dismiss' | 'select';

/**
 * Small, pure state transition so the modal's open/select/dismiss behaviour can
 * be asserted without a DOM test harness. Selecting closes the menu: the reader
 * has committed and the next page is arriving underneath it.
 */
export const mobileDestinationMenuOpen = (_current: boolean, action: MobileDestinationMenuAction): boolean =>
  action === 'open';

export interface Crumb {
  readonly href?: string;
  readonly label: string;
}

export interface CrumbStep {
  readonly crumb: Crumb;
  /** The accumulated path down to this crumb — unique even when labels repeat. */
  readonly trail: string;
  /** The last crumb is the page the reader is on: no link, no separator after it. */
  readonly last: boolean;
}

/** Turns a breadcrumb into renderable steps. Pure, so the separator rule is
 *  asserted without a DOM. */
export const crumbTrail = (crumbs: readonly Crumb[]): readonly CrumbStep[] =>
  crumbs.map((crumb, index) => ({
    crumb,
    trail: crumbs
      .slice(0, index + 1)
      .map(step => step.label)
      .join(' '),
    last: index === crumbs.length - 1,
  }));

export interface SidebarDrawerTriggerProps {
  readonly onOpen: () => void;
  /** The count the rail and the expanded column also show. */
  readonly sessionCount: number;
}

/**
 * The fleet sidebar's opener. It renders ONLY at drawer widths — the rail and
 * the expanded column carry their own — which is why the bar can hand it the
 * opener unconditionally.
 */
export function SidebarDrawerTrigger({ onOpen, sessionCount }: SidebarDrawerTriggerProps) {
  const layout = useLayoutMode();
  if (layout !== 'drawer') return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open the fleet sidebar"
      title="Open the fleet sidebar"
      className="kt-btn kt-btn--sm fy-drawer-trigger shrink-0 items-center gap-xs text-muted"
    >
      <Users size={12} aria-hidden="true" />
      <span className="mono">{sessionCount}</span>
    </button>
  );
}

/**
 * The Inbox count on a PLACE (a tab, a nav link, a heading): THE unread pill the rows draw
 * (`UnreadBadge`), and nothing at zero — a calm place is the good news.
 */
export function AgendaCountBadge({ count, className }: { readonly count: number; readonly className?: string }) {
  return count <= 0 ? null : <UnreadBadge count={count} {...(className === undefined ? {} : { className })} />;
}

function AppNavLink({
  destination,
  daemon,
  active,
  onNavigate,
  agendaCount,
}: {
  destination: AppNavigationEntry;
  daemon: DaemonId;
  active: boolean;
  onNavigate?: (to: string) => void;
  agendaCount: number;
}) {
  return (
    <RouteLink
      to={destination.path(daemon)}
      {...(onNavigate ? { onNavigate } : {})}
      aria-current={active ? 'page' : undefined}
      title={destination.title}
      data-app-nav={destination.id}
      className="kt-appnav__link"
    >
      {destination.label}
      {destination.id === 'attention' ? <AgendaCountBadge count={agendaCount} /> : null}
    </RouteLink>
  );
}

/** Find, drawn as what it is — a search box — that opens the palette. */
function FindBox({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-keyshortcuts={PALETTE_KEYSHORTCUTS}
      aria-label="Find app destinations, settings & sessions"
      title="Find an app destination, setting, or session"
      className="kt-findbox"
      data-app-bar-destination-search=""
    >
      <Search size={14} aria-hidden="true" />
      <span>Search</span>
      <kbd>{paletteShortcutLabel()}</kbd>
    </button>
  );
}

function AppBarStatus({
  connectionStatus,
  updateReady,
  onApplyUpdate,
}: {
  connectionStatus: ConnectionStatus;
  updateReady: UpdateReason | null;
  onApplyUpdate?: () => void;
}) {
  return (
    <>
      {/* QUIET connection state: nothing at all while the stream is open (the
          normal case), and a small dot — never a modal, never an instruction
          to refresh — while it is reconnecting. The cache keeps working and
          catches up on its own. */}
      {connectionStatus !== 'open' && (
        <span
          className="inline-flex shrink-0 items-center gap-xs text-meta text-muted"
          title={connectionStatus === 'connecting' ? 'connecting to the daemon…' : 'reconnecting to the daemon…'}
        >
          <span className={`kt-dot ${connectionStatus === 'connecting' ? 'bg-warn' : 'bg-err'}`} />
          <span>{connectionStatus === 'connecting' ? 'connecting' : 'reconnecting'}</span>
        </span>
      )}
      {/* UPDATE / RECOVERY CHIP — an offer, never an interruption. A reload
          throws away unsent composer text and the transcript scroll position,
          so nothing here reloads on its own. */}
      {updateReady && (
        <button
          type="button"
          onClick={onApplyUpdate}
          aria-live="polite"
          title={UPDATE_CHIP[updateReady].title}
          className="kt-badge shrink-0 items-center gap-xs hover:text-fg"
          data-tone={updateReady === 'recovery' ? 'warn' : 'accent'}
        >
          <RefreshCw size={11} aria-hidden="true" />
          {UPDATE_CHIP[updateReady].label}
        </button>
      )}
    </>
  );
}

export interface AppBarProps {
  readonly crumbs: readonly Crumb[];
  /** The daemon whose surfaces this bar navigates to. */
  readonly daemon: DaemonId;
  /** Opens the global destination/settings palette. */
  readonly onOpenPalette: () => void;
  /**
   * Opens the fleet sidebar's mobile drawer. Absent on destinations such as
   * Settings, where the fleet sidebar and its bento do not exist.
   */
  readonly onOpenSidebar?: () => void;
  readonly sessionCount?: number;
  readonly connectionStatus?: ConnectionStatus;
  /**
   * Non-null when a newer release is installed and waiting, or when this tab
   * has already failed to lazy-load a chunk. Null hides the chip entirely.
   */
  readonly updateReady?: UpdateReason | null;
  readonly onApplyUpdate?: () => void;
  readonly active?: AppBarDestinationId | null;
  /** How the host commits an in-app navigation. */
  readonly onNavigate?: (to: string) => void;
  /** The theme quick switch, drawn top-right at every width. */
  readonly themeToggle?: ReactNode;
  /**
   * Item #6 owns the actual current-session file/task search. The bar owns its
   * centred geometry now, so that work can mount one real control without
   * restructuring app navigation again. Empty means an intentionally blank
   * slot, never a disabled or decorative fake search.
   */
  readonly currentSessionSearch?: ReactNode;
  /**
   * Whether the phone's bottom bar is on screen under this page. Where it is not — inside a session —
   * the bar keeps a Find button of its own, so the app's search is never more than one tap away.
   */
  readonly tabBarShown?: boolean;
  /** Open Inbox items across every paired machine: the Inbox place's badge. */
  readonly agendaCount?: number;
}

export function AppBar({
  crumbs,
  daemon,
  onOpenPalette,
  onOpenSidebar,
  sessionCount = 0,
  connectionStatus = 'open',
  updateReady = null,
  onApplyUpdate,
  active = null,
  onNavigate,
  themeToggle,
  currentSessionSearch,
  tabBarShown = false,
  agendaCount = 0,
}: AppBarProps) {
  const layout = useLayoutMode();
  const statusVisible = connectionStatus !== 'open' || updateReady !== null;
  // A phone hides the breadcrumb, so the page's name takes the empty centre of the bar instead.
  const title = appBarTitle(active) ?? crumbs[crumbs.length - 1]?.label ?? null;

  return (
    // Not sticky: the shell does not scroll, so the bar is simply the first row
    // of a flex column that fills the viewport. Full bleed — no centred wrapper.
    // Do not add filter/backdrop-filter/transform here: BottomSheet is a child,
    // and a new stacking context would trap its fixed overlay under page content.
    <header data-density-region="app-bar" className="shrink-0 border-b border-border-strong bg-[var(--bar-bg)]">
      <div
        className="grid w-full grid-cols-[minmax(44px,1fr)_minmax(8rem,2fr)_minmax(44px,1fr)] items-center gap-sm px-panel py-1.5 font-ui text-ui md:grid-cols-[minmax(0,1fr)_minmax(16rem,34rem)_minmax(0,1fr)] md:gap-md md:py-md"
        data-app-bar-primary=""
      >
        {/* Identity stays together at the start. */}
        <div className="flex min-w-0 items-center justify-self-start gap-md">
          {onOpenSidebar && <SidebarDrawerTrigger onOpen={onOpenSidebar} sessionCount={sessionCount} />}
          <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-md text-muted min-[480px]:flex">
            {crumbTrail(crumbs).map(({ crumb, trail, last }) => (
              // Keyed by the trail rather than the index: two crumbs on one
              // path can repeat a label, so only the accumulated path is unique.
              <span key={trail} className="flex min-w-0 items-center gap-md">
                {crumb.href ? (
                  <RouteLink to={crumb.href} {...(onNavigate ? { onNavigate } : {})} className="truncate hover:text-fg">
                    {crumb.label}
                  </RouteLink>
                ) : (
                  <span className="truncate text-fg font-semibold">{crumb.label}</span>
                )}
                {!last && <span className="text-muted">/</span>}
              </span>
            ))}
          </nav>
        </div>

        {/* A REAL SLOT, not a fake disabled search. Equal flexible side columns
            keep this exact region centred in the viewport regardless of crumb,
            status, update, or theme widths. Item #6 only has to supply a node. */}
        <div className="flex min-h-control min-w-0 items-center justify-center" data-app-bar-session-search-slot="">
          {currentSessionSearch ? (
            <div className="w-full max-w-[34rem]">{currentSessionSearch}</div>
          ) : title !== null ? (
            // Below 480px the breadcrumb is hidden, which left a phone's bar saying nothing but the fleet
            // count. The page's name takes the empty centre there instead; the stylesheet hides it wherever
            // the breadcrumb shows.
            <span className="truncate font-semibold text-fg min-[480px]:hidden" data-app-bar-title="">
              {title}
            </span>
          ) : null}
        </div>

        <div className="flex min-w-0 items-center justify-self-end gap-md">
          {layout !== 'drawer' && (
            <div className="flex min-w-0 items-center gap-md" data-app-bar-status="">
              <AppBarStatus
                connectionStatus={connectionStatus}
                updateReady={updateReady}
                {...(onApplyUpdate ? { onApplyUpdate } : {})}
              />
            </div>
          )}
          {layout === 'drawer' && !tabBarShown && (
            <button
              type="button"
              onClick={onOpenPalette}
              aria-label="Find app destinations, settings & sessions"
              title="Find an app destination, setting, or session"
              className="kt-btn kt-btn--sm shrink-0 items-center justify-center"
              data-variant="ghost"
              data-app-bar-destination-search=""
            >
              <Search size={18} aria-hidden="true" />
            </button>
          )}
          {/* The theme quick switch is the last thing in the bar at every width: top-right, where a
              thumb or a pointer finds it without opening Settings. */}
          {themeToggle}
        </div>
      </div>

      {/* LEVEL ONE: the app's places as plain text, the current one underlined ON the bar's own bottom
          edge, and Find as a search box at the end of the same row. A phone has the bottom bar instead. */}
      {layout !== 'drawer' && (
        <div className="flex min-w-0 items-end justify-between gap-md px-panel font-ui" data-app-bar-destination-row="">
          <nav aria-label="Destinations" className="kt-appnav scroll-thin overflow-x-auto">
            {APP_NAVIGATION.map(destination => (
              <AppNavLink
                key={destination.id}
                destination={destination}
                daemon={daemon}
                {...(onNavigate ? { onNavigate } : {})}
                active={active === destination.id}
                agendaCount={agendaCount}
              />
            ))}
          </nav>
          <div className="flex shrink-0 items-center self-center pb-xs">
            <FindBox onOpen={onOpenPalette} />
          </div>
        </div>
      )}

      {/* Transient phone state gets a full-width second row rather than being
          wedged between the centred seam and the sidebar opener. */}
      {layout === 'drawer' && statusVisible && (
        <div
          className="flex min-h-control items-center justify-center gap-md border-t border-border-soft px-panel py-xs font-ui"
          data-app-bar-status=""
        >
          <AppBarStatus
            connectionStatus={connectionStatus}
            updateReady={updateReady}
            {...(onApplyUpdate ? { onApplyUpdate } : {})}
          />
        </div>
      )}
    </header>
  );
}

export interface AppTabBarProps {
  readonly daemon: DaemonId;
  readonly active?: AppBarDestinationId | null;
  readonly onNavigate?: (to: string) => void;
  /** Find opens the same palette as the desktop's search box. */
  readonly onOpenPalette: () => void;
  /** Open Agenda items across every paired machine: the Inbox tab's badge. */
  readonly agendaCount?: number;
  /** Cards to test plus cards waiting on the owner, across every machine: the Board tab's badge. */
  readonly boardCount?: number;
  /** The shell's What's new door: a row in More, so release notes are findable from the phone's own menu. */
  readonly whatsNew?: { readonly open: () => void; readonly unread: boolean };
}

/** The Board tab's count: the same pill as the Inbox's, announced as what it counts. */
function BoardCountBadge({ count }: { readonly count: number }) {
  if (count <= 0) return null;
  return (
    <>
      <UnreadBadge announce={false} className="kt-tabbar__badge" count={count} />
      <span className="sr-only">{`${count} board ${count === 1 ? 'card needs' : 'cards need'} you`}</span>
    </>
  );
}

const TAB_ICONS: Readonly<Record<AppBarDestinationId, ReactNode>> = {
  sessions: <LayoutList size={20} aria-hidden="true" />,
  attention: <Inbox size={20} aria-hidden="true" />,
  board: <SquareKanban size={20} aria-hidden="true" />,
  projects: <FolderKanban size={20} aria-hidden="true" />,
  sharing: <Share2 size={20} aria-hidden="true" />,
  analytics: <ChartNoAxesCombined size={20} aria-hidden="true" />,
  warden: <ShieldCheck size={20} aria-hidden="true" />,
  learning: <GraduationCap size={20} aria-hidden="true" />,
  settings: <Settings size={20} aria-hidden="true" />,
};

/**
 * The phone's level one: a bottom bar with Sessions, Inbox and Board plus Find and More (Projects,
 * Sharing, Analytics, Warden, Learning, Settings), safe-area aware so it sits above the home indicator. Rendered by the shell only at drawer
 * widths, and not inside a session ({@link showsTabBar}).
 *
 * WHILE THE KEYBOARD IS UP THE BAR IS GONE (`data-kb-hide`). It rode up above the keyboard and sat on top
 * of the very field being typed into, in 55 of the ~430px a phone has left. Its More sheet is the one thing
 * here that can be open, so it closes through its own dismissal path first, as the `data-kb-hide` contract
 * in index.css requires.
 */
export function AppTabBar({
  daemon,
  active = null,
  onNavigate,
  onOpenPalette,
  agendaCount = 0,
  boardCount = 0,
  whatsNew,
}: AppTabBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();
  const keyboardOpen = useKeyboardOpen();
  useEffect(() => {
    if (keyboardOpen) setMoreOpen(current => mobileDestinationMenuOpen(current, 'dismiss'));
  }, [keyboardOpen]);
  const select = (): void => setMoreOpen(current => mobileDestinationMenuOpen(current, 'select'));
  const place = (id: AppBarDestinationId) => {
    const destination = entry(id);
    return (
      <RouteLink
        key={id}
        to={destination.path(daemon)}
        {...(onNavigate ? { onNavigate } : {})}
        aria-current={active === id ? 'page' : undefined}
        data-app-tab={id}
        className="kt-tabbar__item"
      >
        <span className="kt-tabbar__icon">
          {TAB_ICONS[id]}
          {id === 'attention' ? <AgendaCountBadge className="kt-tabbar__badge" count={agendaCount} /> : null}
          {id === 'board' ? <BoardCountBadge count={boardCount} /> : null}
        </span>
        <span className="kt-tabbar__label">{destination.label}</span>
      </RouteLink>
    );
  };
  const inMore = active !== null && MORE_PLACES.includes(active);
  return (
    <>
      <nav aria-label="App" className="kt-tabbar" data-app-tab-bar="" data-kb-hide="" data-safe-bottom="">
        {TAB_BAR_PLACES.map(place)}
        <button
          type="button"
          className="kt-tabbar__item"
          onClick={onOpenPalette}
          data-app-tab="find"
          aria-label="Find app destinations, settings & sessions"
        >
          <Search size={20} aria-hidden="true" />
          <span>Find</span>
        </button>
        <button
          type="button"
          className="kt-tabbar__item"
          onClick={() => setMoreOpen(current => mobileDestinationMenuOpen(current, 'open'))}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-controls={moreId}
          aria-current={inMore ? 'page' : undefined}
          data-app-tab="more"
        >
          <Ellipsis size={20} aria-hidden="true" />
          <span>More</span>
        </button>
      </nav>
      <BottomSheet
        id={moreId}
        open={moreOpen}
        onClose={() => setMoreOpen(current => mobileDestinationMenuOpen(current, 'dismiss'))}
        ariaLabel="More places"
        closeLabel="Dismiss more places"
        panelClassName="px-panel pb-panel"
      >
        <nav
          aria-label="More places"
          className="scroll-thin flex min-h-0 flex-1 flex-col gap-xs overflow-y-auto overscroll-contain pb-[calc(var(--gap-md)+var(--safe-bottom))]"
          data-app-more-list=""
        >
          <h2 className="m-0 mb-sm shrink-0 text-title font-semibold text-fg">More</h2>
          {MORE_PLACES.map(id => {
            const destination = entry(id);
            return (
              <RouteLink
                key={id}
                to={destination.path(daemon)}
                {...(onNavigate ? { onNavigate } : {})}
                aria-current={active === id ? 'page' : undefined}
                onClick={select}
                data-app-more={id}
                className="kt-navpill min-h-[48px] shrink-0"
              >
                <span className="flex w-5 shrink-0 justify-center" aria-hidden="true">
                  {TAB_ICONS[id]}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold">{destination.label}</span>
                  <span className="kt-navpill__sub">{destination.title}</span>
                </span>
              </RouteLink>
            );
          })}
          {whatsNew === undefined ? null : (
            <button
              type="button"
              className="kt-navpill min-h-[48px] shrink-0 text-left"
              data-app-more-whats-new=""
              onClick={() => {
                select();
                whatsNew.open();
              }}
            >
              <span className="flex w-5 shrink-0 justify-center" aria-hidden="true">
                <Sparkles size={20} />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-sm font-semibold">
                  What’s new
                  {whatsNew.unread ? (
                    <Badge tone="accent" data-app-more-whats-new-unread="">
                      New
                    </Badge>
                  ) : null}
                </span>
                <span className="kt-navpill__sub">See the latest changes to Ferretry</span>
              </span>
            </button>
          )}
        </nav>
      </BottomSheet>
    </>
  );
}
