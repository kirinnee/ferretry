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
  GraduationCap,
  LayoutGrid,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type { DaemonId } from '../lib/daemon-connection.ts';
import {
  daemonAnalyticsPath,
  daemonLearningPath,
  daemonSettingsPath,
  daemonWardenPath,
  type Route,
} from '../lib/pages/routes.ts';
import { useLayoutMode } from '../hooks/use-layout-mode.ts';
import { BottomSheet } from './bottom-sheet.tsx';
import { Link } from './link.tsx';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from './palette-shortcut.ts';

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

/**
 * The app-level destinations appear in both the wide tab group and the phone
 * selector. Keeping their path builder, label and icon together stops the two
 * navigation affordances from quietly becoming different information
 * architectures. Theme is deliberately not here: it is a control rather than a
 * destination, and stays with the other right-side controls.
 */
export const APP_BAR_DESTINATIONS = [
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
      // The hover edge stays `--accent-border`: decorative tint on a control
      // whose state never depends on it.
      className="inline-flex shrink-0 items-center gap-xs rounded-control border border-border px-1.5 py-0.5 text-meta text-muted hover:border-accent-border hover:text-fg"
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
  onSelect,
}: {
  destination: AppBarDestination;
  daemon: DaemonId;
  active: boolean;
  onSelect?: () => void;
}) {
  const { Icon } = destination;
  return (
    <Link
      to={destination.path(daemon)}
      aria-current={active ? 'page' : undefined}
      aria-label={destination.label}
      title={destination.title}
      {...(onSelect ? { onClick: onSelect } : {})}
      className="kt-btn kt-btn--sm shrink-0 items-center gap-xs"
    >
      <Icon size={14} aria-hidden="true" />
      <span className="text-meta font-medium">{destination.label}</span>
    </Link>
  );
}

export interface AppBarProps {
  readonly crumbs: readonly Crumb[];
  /** The daemon whose surfaces this bar navigates to. */
  readonly daemon: DaemonId;
  /** Opens the Cmd/Ctrl+K palette. */
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
  /** The theme control, on layouts wide enough for it. */
  readonly themeToggle?: ReactNode;
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
  themeToggle,
}: AppBarProps) {
  const layout = useLayoutMode();
  const [mobileDestinationsOpen, setMobileDestinationsOpen] = useState(false);
  const destinationDialogId = useId();
  const dismissMobileDestinations = () =>
    setMobileDestinationsOpen(current => mobileDestinationMenuOpen(current, 'dismiss'));
  const selectMobileDestination = () =>
    setMobileDestinationsOpen(current => mobileDestinationMenuOpen(current, 'select'));

  return (
    // Not sticky: the shell does not scroll, so the bar is simply the first row
    // of a flex column that fills the viewport. Full bleed — no centred wrapper.
    <header data-density-region="app-bar" className="shrink-0 border-b border-border bg-[var(--bar-bg)]">
      <div className="grid min-h-control w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-sm px-panel font-ui text-ui">
        {/* The first column owns all desktop navigation. The equal flexible side
            columns make the palette genuinely centred without absolute
            positioning, even when status chips appear on the right. */}
        <div className="flex min-w-0 items-center gap-sm">
          {onOpenSidebar && <SidebarDrawerTrigger onOpen={onOpenSidebar} sessionCount={sessionCount} />}
          <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-sm text-muted min-[480px]:flex">
            {crumbTrail(crumbs).map(({ crumb, trail, last }) => (
              // Keyed by the trail rather than the index: two crumbs on one
              // path can repeat a label, so only the accumulated path is unique.
              <span key={trail} className="flex min-w-0 items-center gap-sm">
                {crumb.href ? (
                  <Link to={crumb.href} className="truncate hover:text-fg">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="truncate text-fg font-semibold">{crumb.label}</span>
                )}
                {!last && <span className="text-muted">/</span>}
              </span>
            ))}
          </nav>
          <nav aria-label="Destinations" className="hidden min-w-0 items-center gap-xs md:flex">
            {APP_BAR_DESTINATIONS.map(destination => (
              <DestinationLink
                key={destination.id}
                destination={destination}
                daemon={daemon}
                active={active === destination.id}
              />
            ))}
          </nav>
        </div>
        {/* Always reachable, including at 390px: phones get an icon-only centre
            button while wider layouts show the familiar Cmd/Ctrl+K reminder. */}
        <button
          type="button"
          onClick={onOpenPalette}
          aria-keyshortcuts={PALETTE_KEYSHORTCUTS}
          aria-label="Open command palette"
          title="Jump to a session — the command palette"
          className="kt-chrome inline-flex shrink-0 items-center gap-xs rounded-control border border-border-soft px-badge-x py-0.5 text-meta text-muted hover:border-border hover:text-fg"
          data-app-bar-search
        >
          <Search size={14} aria-hidden="true" />
          <span className="mono hidden sm:inline">{paletteShortcutLabel()}</span>
        </button>
        <div className="flex min-w-0 items-center justify-self-end gap-sm">
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
              <span className="hidden sm:inline">
                {connectionStatus === 'connecting' ? 'connecting' : 'reconnecting'}
              </span>
            </span>
          )}
          {/* UPDATE / RECOVERY CHIP — an offer, never an interruption. A reload
              throws away unsent composer text and the transcript scroll
              position, so nothing here reloads on its own: the new worker sits
              waiting until this is clicked. Two wordings because they are two
              different facts. `aria-live=polite` announces the chip's arrival
              without stealing focus mid-typing; `data-tone=warn` for recovery so
              it does not read as routine. */}
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
      <BottomSheet
        id={destinationDialogId}
        open={mobileDestinationsOpen}
        onClose={dismissMobileDestinations}
        ariaLabel="Choose destination"
        closeLabel="Dismiss destination picker"
        panelClassName="px-panel pb-panel"
      >
        <div className="grid gap-sm pb-sm">
          <div className="grid gap-xs">
            <h2 className="m-0 text-ui font-semibold text-fg">Choose destination</h2>
            <p className="m-0 text-meta text-muted">Select a destination, or dismiss this menu.</p>
          </div>
          <nav aria-label="Destinations" className="grid gap-xs">
            {APP_BAR_DESTINATIONS.map(destination => (
              <DestinationLink
                key={destination.id}
                destination={destination}
                daemon={daemon}
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
