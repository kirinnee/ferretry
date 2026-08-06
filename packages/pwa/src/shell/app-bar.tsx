/**
 * Top bar — breadcrumb, quiet connection state, app destinations, the command
 * palette entry and the update/recovery chip. Ported from kteam
 * `ui/src/components/AppBar.tsx`.
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
  FolderKanban,
  GraduationCap,
  LayoutGrid,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useLayoutMode } from '../hooks/use-layout-mode.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import {
  daemonAnalyticsPath,
  daemonLearningPath,
  daemonProjectsPath,
  daemonSettingsPath,
  daemonWardenPath,
  type Route,
} from '../lib/pages/routes.ts';
import { BottomSheet } from './bottom-sheet.tsx';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from './palette-shortcut.ts';
import { RouteLink } from './route-link.tsx';

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

export const SETTINGS_ENTRY = { label: 'Settings', title: 'Open appearance and density settings' } as const;
export const WARDEN_ENTRY = { label: 'Warden', title: 'Open fleet supervision and verdicts' } as const;
export const LEARNING_ENTRY = { label: 'Learning', title: 'Open fleet learning proposals' } as const;
export const ANALYTICS_ENTRY = { label: 'Analytics', title: 'Query all sessions and graph daily usage' } as const;
export const PROJECTS_ENTRY = { label: 'Projects', title: 'Open registered workspaces and folders' } as const;

/**
 * The app-level destinations appear in both the wide tab group and the phone
 * selector. Keeping their path builder, label and icon together stops the two
 * navigation affordances from quietly becoming different information
 * architectures. Theme is deliberately not here: it is a control rather than a
 * destination, and stays with the other right-side controls.
 */
export const APP_BAR_DESTINATIONS = [
  { id: 'projects', ...PROJECTS_ENTRY, path: daemonProjectsPath, Icon: FolderKanban },
  { id: 'analytics', ...ANALYTICS_ENTRY, path: daemonAnalyticsPath, Icon: ChartNoAxesCombined },
  { id: 'warden', ...WARDEN_ENTRY, path: daemonWardenPath, Icon: ShieldCheck },
  { id: 'learning', ...LEARNING_ENTRY, path: daemonLearningPath, Icon: GraduationCap },
  { id: 'settings', ...SETTINGS_ENTRY, path: daemonSettingsPath, Icon: Settings },
] as const;

type AppBarDestination = (typeof APP_BAR_DESTINATIONS)[number];
export type AppBarDestinationId = AppBarDestination['id'];

/** Which destination, if any, the reader is currently on. */
export const appBarDestinationForRoute = (route: Route): AppBarDestinationId | null => {
  switch (route.kind) {
    case 'projects':
    case 'analytics':
    case 'warden':
    case 'learning':
    case 'settings':
      return route.kind;
    default:
      return null;
  }
};

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
      className="kt-btn kt-btn--sm shrink-0 items-center gap-xs text-muted"
    >
      <Users size={12} aria-hidden="true" />
      <span className="mono">{sessionCount}</span>
    </button>
  );
}

function DestinationLink({
  destination,
  daemon,
  active,
  onNavigate,
  onSelect,
}: {
  destination: AppBarDestination;
  daemon: DaemonId;
  active: boolean;
  onNavigate?: (to: string) => void;
  onSelect?: () => void;
}) {
  const { Icon } = destination;
  return (
    <RouteLink
      to={destination.path(daemon)}
      {...(onNavigate ? { onNavigate } : {})}
      aria-current={active ? 'page' : undefined}
      aria-label={destination.label}
      title={destination.title}
      {...(onSelect ? { onClick: onSelect } : {})}
      className="kt-btn kt-btn--sm shrink-0 items-center gap-xs"
    >
      <Icon size={14} aria-hidden="true" />
      <span className="text-meta font-medium">{destination.label}</span>
    </RouteLink>
  );
}

function DestinationFinderButton({
  onOpen,
  roomy = false,
  shortcutAvailable = true,
}: {
  onOpen: () => void;
  roomy?: boolean;
  /** False when Cmd/Ctrl+K belongs to the mounted current-session search. */
  shortcutAvailable?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-keyshortcuts={shortcutAvailable ? PALETTE_KEYSHORTCUTS : undefined}
      aria-label={roomy ? 'Search app, settings & sessions' : 'Find app destinations, settings & sessions'}
      title="Find an app destination, setting, or session"
      className={
        roomy
          ? 'kt-btn w-full items-center justify-start gap-sm px-control-x'
          : 'kt-btn kt-btn--sm shrink-0 items-center gap-xs'
      }
      data-app-bar-destination-search=""
    >
      <Search size={roomy ? 16 : 14} aria-hidden="true" />
      <span className={roomy ? 'text-ui font-semibold' : 'text-meta font-medium'}>
        {roomy ? 'Search app, settings & sessions' : 'Find'}
      </span>
      {shortcutAvailable ? (
        <span
          className={
            roomy ? 'mono ml-auto hidden text-meta text-muted min-[440px]:inline' : 'mono ml-auto text-meta text-muted'
          }
        >
          {paletteShortcutLabel()}
        </span>
      ) : null}
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
  /** The theme control, on layouts wide enough for it. */
  readonly themeToggle?: ReactNode;
  /**
   * Item #6 owns the actual current-session file/task search. The bar owns its
   * centred geometry now, so that work can mount one real control without
   * restructuring app navigation again. Empty means an intentionally blank
   * slot, never a disabled or decorative fake search.
   */
  readonly currentSessionSearch?: ReactNode;
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
}: AppBarProps) {
  const layout = useLayoutMode();
  const [mobileDestinationsOpen, setMobileDestinationsOpen] = useState(false);
  const destinationDialogId = useId();
  const dismissMobileDestinations = () =>
    setMobileDestinationsOpen(current => mobileDestinationMenuOpen(current, 'dismiss'));
  const selectMobileDestination = () =>
    setMobileDestinationsOpen(current => mobileDestinationMenuOpen(current, 'select'));
  const openPaletteFromMobileDestinations = () => {
    selectMobileDestination();
    onOpenPalette();
  };
  const statusVisible = connectionStatus !== 'open' || updateReady !== null;

  return (
    // Not sticky: the shell does not scroll, so the bar is simply the first row
    // of a flex column that fills the viewport. Full bleed — no centred wrapper.
    // Do not add filter/backdrop-filter/transform here: BottomSheet is a child,
    // and a new stacking context would trap its fixed overlay under page content.
    <header data-density-region="app-bar" className="shrink-0 border-b border-border bg-[var(--bar-bg)]">
      <div
        className="grid w-full grid-cols-[minmax(44px,1fr)_minmax(8rem,2fr)_minmax(44px,1fr)] items-center gap-sm px-panel py-md font-ui text-ui md:grid-cols-[minmax(0,1fr)_minmax(16rem,34rem)_minmax(0,1fr)] md:gap-md"
        data-app-bar-primary=""
      >
        {/* Identity stays together at the start. Destinations have their own
            group below on wider layouts and their own picker on phones. */}
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
          {currentSessionSearch && <div className="w-full max-w-[34rem]">{currentSessionSearch}</div>}
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
          {/* Keep the established standalone picker for desktop. On a phone the
              only theme control is Settings, so hidden chrome does not mount a
              second theme instance behind the sheet. */}
          {layout !== 'drawer' && themeToggle}
          {/* Phone navigation is a real modal selector, not a horizontally
              scrollable tab strip. It stays at the right edge while search owns
              the centre column. */}
          {layout === 'drawer' && (
            <button
              type="button"
              onClick={() => setMobileDestinationsOpen(current => mobileDestinationMenuOpen(current, 'open'))}
              aria-label="Choose destination"
              aria-haspopup="dialog"
              aria-expanded={mobileDestinationsOpen}
              aria-controls={destinationDialogId}
              title="Choose destination"
              className="kt-btn kt-btn--sm shrink-0 items-center justify-center"
            >
              <LayoutGrid size={18} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Desktop/tablet destinations form one explicit group on their own row.
          The global palette belongs with app navigation; it no longer poses as
          the current-session search in the centre slot. Phones get the modal
          destination picker below, never a horizontal strip. */}
      {layout !== 'drawer' && (
        <div className="px-panel pb-sm font-ui text-ui" data-app-bar-destination-row="">
          <nav
            aria-label="Destinations"
            className="mx-auto flex w-fit max-w-full items-center gap-xs rounded-panel border border-border-soft bg-surface px-sm py-xs"
          >
            <DestinationFinderButton onOpen={onOpenPalette} shortcutAvailable={currentSessionSearch === undefined} />
            <span aria-hidden="true" className="mx-xs h-control-sm w-px shrink-0 bg-border-soft" />
            {APP_BAR_DESTINATIONS.map(destination => (
              <DestinationLink
                key={destination.id}
                destination={destination}
                daemon={daemon}
                {...(onNavigate ? { onNavigate } : {})}
                active={active === destination.id}
              />
            ))}
          </nav>
        </div>
      )}

      {/* Transient phone state gets a full-width second row rather than being
          wedged between the centred seam and destination trigger. */}
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

      <BottomSheet
        id={destinationDialogId}
        open={mobileDestinationsOpen}
        onClose={dismissMobileDestinations}
        ariaLabel="Choose destination"
        closeLabel="Dismiss destination picker"
        panelClassName="px-panel pb-panel"
      >
        <div className="grid gap-md pb-md">
          <div className="grid gap-xs">
            <h2 className="m-0 text-title font-semibold text-fg">Choose destination</h2>
            <p className="m-0 text-ui text-muted">Select a destination, search the app, or dismiss this menu.</p>
          </div>
          <DestinationFinderButton
            onOpen={openPaletteFromMobileDestinations}
            roomy
            shortcutAvailable={currentSessionSearch === undefined}
          />
          <nav aria-label="Destinations" className="grid gap-sm border-t border-border-soft pt-md">
            {APP_BAR_DESTINATIONS.map(destination => (
              <DestinationLink
                key={destination.id}
                destination={destination}
                daemon={daemon}
                {...(onNavigate ? { onNavigate } : {})}
                active={active === destination.id}
                onSelect={selectMobileDestination}
              />
            ))}
          </nav>
          <button type="button" onClick={dismissMobileDestinations} className="kt-btn justify-center">
            Dismiss
          </button>
        </div>
      </BottomSheet>
    </header>
  );
}
