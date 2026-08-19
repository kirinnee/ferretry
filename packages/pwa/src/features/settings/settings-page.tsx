/**
 * The daemon-scoped Settings route surface.
 *
 * Preferences such as theme and density belong to the reader's browser, but
 * destinations and live state that name a daemon are built from explicit
 * connections. That distinction lets this page switch pairings without
 * retaining the previous daemon's link, health result, or action target.
 */

import type { ConnectionChoice } from '@ferretry/relay';
import { ChevronLeft, Palette, Server, SlidersHorizontal } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { DENSITY_OPTIONS, useDensity } from '../../hooks/use-density.ts';
import { type ThemeState, useTheme } from '../../hooks/use-theme.ts';
import type { WardenStatusReader } from '../../hooks/use-warden-status.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonControlsStore } from '../../lib/controls.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { CHAT_WIDTH_OPTIONS, ChatWidthControl } from '../../shell/chat-width-control.tsx';
import { ChoiceRail, type ChoiceRailItem } from '../../shell/choice-rail.tsx';
import { PickerTrigger } from '../../shell/picker-trigger.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { ThemeSettings } from '../../shell/theme-toggle.tsx';
import type { WardenClientFactory } from '../warden/warden-config-card.tsx';
import type { PairingClientFactory } from './add-device-settings.tsx';
import { ComposerEnterKeySettings } from './composer-enter-key-settings.tsx';
import { ComposerSuggestionsSettings } from './composer-suggestions-settings.tsx';
import { type DaemonReachabilityProbe, DaemonSettings, daemonDisplayName } from './daemon-settings.tsx';
import { DaemonSettingsFrame, type DaemonSettingsTabDefinition } from './daemon-settings-frame.tsx';
import { DictationSettings, type DictationSettingsProps } from './dictation-settings.tsx';
import type { GrantClientFactory } from './grants-settings.tsx';
import { MarkdownComposerSettings } from './markdown-composer-settings.tsx';
import {
  isSettingId,
  isSettingsSectionId,
  SETTINGS_SECTIONS,
  type SettingDefinition,
  type SettingId,
  type SettingsSectionDefinition,
  type SettingsSectionId,
  settingDefinition,
  settingsSectionDefinition,
  settingsSectionForSetting,
} from './settings-catalog.ts';

export const TEXT_SCALE_OPTIONS = [
  { id: 'default', label: 'Default', description: 'Use the interface’s designed size.' },
  { id: 'large', label: 'Large', description: '112% of default.' },
  { id: 'larger', label: 'Larger', description: '125% of default.' },
] as const;

const SETTINGS_PICKER_HEIGHT = 'min(72dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))';

const settingFromHash = (): SettingId | null => {
  if (typeof window === 'undefined') return null;
  const value = window.location.hash.replace(/^#/, '');
  return isSettingId(value) ? value : null;
};

const sectionFromHash = (): SettingsSectionId | null => {
  if (typeof window === 'undefined') return null;
  const value = window.location.hash.replace(/^#/, '');
  if (isSettingsSectionId(value)) return value;
  return isSettingId(value) ? settingsSectionForSetting(value) : null;
};

/**
 * ONE ICON PER SECTION, for the same reason the daemon panel rail has one per panel: all the rows or
 * none of them, at one size, from the one set this app already draws from.
 *
 * Three rows is few enough that iconless was defensible on its own — but it is not on its own. It sits
 * beside a ten-row rail that now has them, and the two rails are the same component at two levels of the
 * same screen; one of them being a column of glyphs and the other a column of bare text is the
 * inconsistency, not the fix for it.
 */
const SETTINGS_SECTION_ICONS: Readonly<Record<SettingsSectionId, ReactNode>> = {
  appearance: <Palette size={16} aria-hidden="true" />,
  behaviour: <SlidersHorizontal size={16} aria-hidden="true" />,
  // The machines, not the pairing: this section is where a reader picks WHICH host they are configuring.
  daemons: <Server size={16} aria-hidden="true" />,
};

/**
 * Level one of the shared rail. The section catalogue is a constant, not runtime
 * state, so the rows are built once at module scope rather than per render.
 */
const SETTINGS_SECTION_ITEMS: readonly ChoiceRailItem<SettingsSectionId>[] = SETTINGS_SECTIONS.map(section => ({
  id: section.id,
  label: section.label,
  detail: section.description,
  icon: SETTINGS_SECTION_ICONS[section.id],
}));

function MobileSettingsSectionPicker({
  active,
  definition,
  open,
  onOpen,
  onClose,
  onSelect,
}: {
  readonly active: SettingsSectionId;
  readonly definition: SettingsSectionDefinition;
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly onSelect: (id: SettingsSectionId) => void;
}) {
  const titleId = useId();
  return (
    <div className="md:hidden">
      <PickerTrigger
        eyebrow="Settings section"
        value={definition.label}
        icon={
          <span className="flex w-4 shrink-0 items-center justify-center text-accent" aria-hidden="true">
            {SETTINGS_SECTION_ICONS[definition.id]}
          </span>
        }
        open={open}
        controls="settings-section-picker"
        marker="data-settings-section-trigger"
        onOpen={onOpen}
      />
      <BottomSheet
        id="settings-section-picker"
        open={open}
        onClose={onClose}
        labelledBy={titleId}
        closeLabel="Close settings section picker"
        panelClassName="bg-surface"
        maxHeight={SETTINGS_PICKER_HEIGHT}
        zIndexClass="z-50"
      >
        <div className="min-h-0 overflow-y-auto px-panel pb-4">
          <h2 id={titleId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
            Choose a settings section
          </h2>
          <p className="mb-3 mt-1 text-cell leading-base text-muted">
            Pick one area; the settings underneath stay on this page.
          </p>
          <nav aria-label="Settings sections">
            <ChoiceRail
              items={SETTINGS_SECTION_ITEMS}
              activeId={active}
              marker="data-settings-section-choice"
              onSelect={id => {
                onSelect(id);
                onClose();
              }}
            />
          </nav>
        </div>
      </BottomSheet>
    </div>
  );
}

export { DENSITY_OPTIONS } from '../../hooks/use-density.ts';

export interface SettingsSectionProps {
  readonly definition: SettingDefinition;
  readonly children: ReactNode;
}

/**
 * FOUR LEVELS, and they have to be four different sizes.
 *
 * Everything on this page used to read at `text-title`/`text-ui`: the page title, the section heading,
 * every panel heading, every description, every warning and every path. Uppercase had been sprinkled on
 * top to try to buy back a hierarchy that the type scale was not providing, which is why removing the
 * capitals is only half the fix. The scale, top down:
 *
 *   text-display bold     the page — "Settings"
 *   text-title   bold     the section — "Daemons"
 *   text-row     semibold THIS, a panel inside that section
 *   text-cell    muted    its explanation, the least legible thing in the panel
 *
 * STATE is not on this ladder on purpose. A value, a badge or a verdict is `text-fg` at semibold against
 * muted prose, so the thing a reader came to check is the most legible element in the panel while the
 * sentence explaining it is the quietest — which is the opposite of how these panels read before.
 */
export function SettingsSection({ definition, children }: SettingsSectionProps) {
  const headingId = `settings-${definition.id}-heading`;
  return (
    <section
      id={`settings-${definition.id}`}
      data-setting-id={definition.id}
      tabIndex={-1}
      className="kt-panel p-panel outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-labelledby={headingId}
    >
      <h3 id={headingId} className="m-0 text-row font-semibold text-fg">
        {definition.label}
      </h3>
      <p className="mt-1 text-cell leading-base text-muted">{definition.description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function TextScaleControl({ theme }: { readonly theme: ThemeState }) {
  return (
    <div
      role="radiogroup"
      aria-label="Text size"
      aria-describedby={!theme.textScaleSupported ? 'text-scale-unsupported' : undefined}
      className="grid grid-cols-1 gap-2 sm:grid-cols-3"
    >
      {TEXT_SCALE_OPTIONS.map(option => {
        const checked = (theme.textScaleSupported ? theme.textScale : 'default') === option.id;
        return (
          <label
            key={option.id}
            className={cn(
              'flex min-h-control min-w-0 cursor-pointer flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors',
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
              checked
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border bg-surface-2 text-fg hover:border-accent',
              !theme.textScaleSupported && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="radio"
              name="text-scale"
              value={option.id}
              checked={checked}
              disabled={!theme.textScaleSupported}
              onChange={() => theme.setTextScale(option.id)}
              className="sr-only"
            />
            <span className="text-ui font-semibold">{option.label}</span>
            <span className="text-meta leading-tight text-muted">{option.description}</span>
          </label>
        );
      })}
    </div>
  );
}

export interface SettingsPageProps {
  /** The paired daemon whose Warden link this page exposes. */
  readonly daemonId: DaemonId;
  /** Every runtime pairing currently remembered by this browser. */
  readonly connections: readonly DaemonConnectionRecord[];
  /** Reader-local controls; only device fields are edited here. */
  readonly controls: DaemonControlsStore;
  /** Browser-local dictation capability, shortcut, and enhancer settings. */
  readonly dictation: DictationSettingsProps;
  /** The daemon-aware notification host, supplied by the composition root. */
  readonly notifications?: ReactNode;
  /** A live, credential-scoped read of the typed daemon health endpoint. */
  readonly probeDaemon: DaemonReachabilityProbe;
  /** A daemon-bound Warden status read; no ambient or browser-global client. */
  readonly readWardenStatus?: WardenStatusReader;
  /** Test and harness seam; production uses the selected daemon client. */
  readonly createWardenClient?: WardenClientFactory;
  /** The same seam for the grant surface, so no test or harness opens a socket to read a limit. */
  readonly createGrantClient?: GrantClientFactory;
  /** And for pairing, so no harness capture can ever contain a real minted code. */
  readonly createPairingClient?: PairingClientFactory;
  /** Future daemon-owned tabs, appended after Warden in the shared frame. */
  readonly daemonSettingsTabs?: readonly DaemonSettingsTabDefinition[];
  readonly onSelectDaemon: (daemonId: DaemonId) => void;
  readonly onRenameDaemon: (daemonId: DaemonId, label?: string) => void;
  readonly onRemoveDaemon: (daemonId: DaemonId) => void;
  /** Opens the app's existing connection picker and pairing flow. */
  readonly onAddDaemon: () => void;
  /**
   * WHICH CARRIER THE ACTIVE DAEMON'S TRAFFIC IS ON, measured rather than preferred.
   *
   * `undefined` is a real state and not a missing prop: before the first request there
   * is nothing to name, and the card says so. See `docs/relay-protocol.md` §1 — a
   * surface showing a connection without naming its carrier is not conforming.
   */
  readonly carrier?: ConnectionChoice | undefined;
  /** Whether the live advertisement offers a rendezvous to fall back to at all. */
  readonly relayAdvertised?: boolean;
  /** Called for the header's in-app Back action. */
  readonly onNavigate?: (to: string) => void;
  readonly className?: string;
}

/**
 * One Settings implementation for desktop and narrow screens. Desktop keeps a
 * vertical section list beside the active content; narrow screens replace that
 * persistent list with the app's shared BottomSheet picker. The page keeps one
 * scroll owner on both layouts.
 */
export function SettingsPage({
  daemonId,
  connections,
  controls,
  dictation,
  notifications,
  probeDaemon,
  readWardenStatus,
  createWardenClient,
  createGrantClient,
  createPairingClient,
  daemonSettingsTabs,
  onSelectDaemon,
  onRenameDaemon,
  onRemoveDaemon,
  onAddDaemon,
  carrier,
  relayAdvertised = false,
  onNavigate,
  className,
}: SettingsPageProps) {
  const record = useSyncExternalStore(
    controls.subscribe,
    () => controls.snapshot(),
    () => controls.snapshot(),
  );
  const device = record.device;
  const densityState = useDensity(controls);
  const density = densityState.density;
  const theme = useTheme();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => sectionFromHash() ?? 'appearance');
  const [sectionPickerOpen, setSectionPickerOpen] = useState(false);
  const followedHash = useRef<string | null>(null);
  const focusFrame = useRef<number | undefined>(undefined);

  const followHash = useCallback((): void => {
    if (followedHash.current === window.location.hash) return;
    followedHash.current = window.location.hash;
    const nextSection = sectionFromHash();
    const target = settingFromHash();
    if (nextSection === null) return;
    setActiveSection(nextSection);
    if (target === null) return;
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      const setting = document.getElementById(`settings-${target}`);
      setting?.focus({ preventScroll: false });
    });
  }, []);

  // Router.navigate uses pushState, which causes a React render but no native
  // hashchange. Compare the hash after every commit so a same-route palette
  // deep link still opens its owning section.
  useEffect(followHash);

  useEffect(() => {
    followHash();
    window.addEventListener('hashchange', followHash);
    window.addEventListener('popstate', followHash);
    return () => {
      window.removeEventListener('hashchange', followHash);
      window.removeEventListener('popstate', followHash);
      if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    };
  }, [followHash]);

  const section = settingsSectionDefinition(activeSection);

  const controlsById = useMemo<Record<SettingId, ReactNode>>(
    () => ({
      'text-size': (
        <>
          <TextScaleControl theme={theme} />
          {theme.textScaleSupported ? (
            <p className="mt-2 text-meta leading-base text-faint">
              Sizes never go below Default, so existing 44px touch targets are not reduced.
            </p>
          ) : (
            <p id="text-scale-unsupported" role="status" className="mt-2 text-ui leading-base text-warn">
              Text sizing is unavailable in this browser because it does not support percentage text adjustment. Browser
              and operating-system zoom still work.
            </p>
          )}
        </>
      ),
      density: (
        <>
          <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <legend className="sr-only">Dashboard density</legend>
            {DENSITY_OPTIONS.map(option => {
              const checked = density === option.id;
              return (
                <label
                  key={option.id}
                  className={cn(
                    'flex min-h-control min-w-0 cursor-pointer flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors',
                    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
                    checked
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-border bg-surface-2 text-fg hover:border-accent',
                  )}
                >
                  <input
                    type="radio"
                    name="dashboard-density"
                    value={option.id}
                    checked={checked}
                    onChange={() => densityState.setDensity(option.id)}
                    className="sr-only"
                  />
                  <span className="text-ui font-semibold">{option.label}</span>
                  <span className="text-meta leading-tight text-muted">{option.description}</span>
                </label>
              );
            })}
          </fieldset>
          {densityState.explicit === null && (
            <p className="mt-2 text-meta leading-base text-faint">
              Using the device default. Picking a level saves an explicit choice.
            </p>
          )}
        </>
      ),
      'chat-width': (
        <ChatWidthControl value={device.chatWidth} onChange={chatWidth => controls.setDeviceControls({ chatWidth })} />
      ),
      'composer-markdown': (
        <MarkdownComposerSettings
          vimEnabled={device.composerVimMode}
          onChangeVim={composerVimMode => controls.setDeviceControls({ composerVimMode })}
        />
      ),
      'composer-enter-key': (
        <ComposerEnterKeySettings
          preference={device.composerEnterKey}
          onChange={composerEnterKey => controls.setDeviceControls({ composerEnterKey })}
        />
      ),
      'composer-suggestions': (
        <ComposerSuggestionsSettings preferences={device} onChange={patch => controls.setDeviceControls(patch)} />
      ),
      theme: <ThemeSettings theme={theme} />,
      dictation: <DictationSettings {...dictation} />,
      notifications: notifications ?? (
        <p role="status" className="m-0 text-cell leading-base text-muted">
          Notification delivery is unavailable until this page is composed with the paired daemon’s push-subscription
          host.
        </p>
      ),
    }),
    // `device` rather than its individual fields: the controls store reuses the
    // very same device object for a patch that changed nothing, so depending on
    // the whole record is as cheap as listing four of its fields and cannot fall
    // behind the next one that is added.
    [controls, density, densityState.explicit, densityState.setDensity, device, dictation, notifications, theme],
  );
  const selectedRecord = connections.find(candidate => candidate.daemonId === daemonId);

  return (
    <main
      data-settings-scroller
      data-density={density}
      // `relative` is not layout here — it is what keeps this page's own
      // scrolling INSIDE this element. Half the controls below are `sr-only`
      // radios, and `sr-only` is `position: absolute`: an absolutely positioned
      // box is clipped by an ancestor's overflow only along its CONTAINING BLOCK
      // chain, so with a static scrollport they escape it and land in the fixed
      // `.kt-shell` instead. The shell then has scrollable overflow it must
      // never have, and focusing any one of them — tapping a theme family, a
      // chat width, a notification toggle — makes the browser scroll THE SHELL
      // to reveal it. The app slides up out of the visual viewport with bare
      // surface below it, and nothing can scroll a `position: fixed` box back.
      className={cn(
        'scroll-thin relative h-full min-h-0 w-full overflow-y-auto overscroll-contain px-panel pb-4 [touch-action:pan-y]',
        className,
      )}
    >
      {/* WIDER, because the wrapped paths and the four-line rail rows were the SAME defect as the empty
          gutters either side of this column. At 1440 the old 1080px cap left ~180px unused on both sides
          while a 200px rail tore `/Users/…/claude-personal` into five fragments; the content column is
          what was short of room, not the page. 1320px keeps a measure that is still readable — the prose
          inside every panel is capped by its own card, not by this — and hands the rest to the rail and
          the values. */}
      <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-3 py-2">
        <header className="flex min-w-0 flex-wrap items-center gap-2">
          <RouteLink
            to={`/d/${encodeURIComponent(daemonId)}`}
            onNavigate={onNavigate}
            aria-label="Back to sessions"
            title="All sessions"
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </RouteLink>
          <div className="min-w-0">
            <h1 className="m-0 font-display text-display font-bold tracking-display">Settings</h1>
            <p className="mt-0.5 text-ui text-muted">Browser preferences and daemon connections.</p>
          </div>
        </header>

        <div className="grid min-w-0 grid-cols-1 items-start gap-3 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-5">
          {/* NO CARD, and a single rule instead. As a bordered box this was a short floating panel beside
              a much taller bordered panel, then a THIRD bordered rail inside that one — three cards at one
              depth, each drawing its own edge. Navigation is not a thing being read, so it is separated
              from the content by a rule and the grid gap, which is what every settings sidebar the reader
              already knows looks like. `border-strong`, not `border-soft`: a soft hairline is invisible
              against these surfaces, which is how the rail ended up needing a whole card to be seen. */}
          <nav
            className="sticky top-2 hidden md:block md:border-r md:border-border-strong md:pr-3"
            aria-label="Settings sections"
          >
            <ChoiceRail
              items={SETTINGS_SECTION_ITEMS}
              activeId={activeSection}
              marker="data-settings-section-choice"
              onSelect={setActiveSection}
              // The section's own description is already the panel heading's second line, one column to
              // the right and visible at the same time, so a second copy in the row was pure repetition.
              rows="single-line"
            />
          </nav>

          <div className="min-w-0">
            <MobileSettingsSectionPicker
              active={activeSection}
              definition={section}
              open={sectionPickerOpen}
              onOpen={() => setSectionPickerOpen(true)}
              onClose={() => setSectionPickerOpen(false)}
              onSelect={setActiveSection}
            />

            <section
              id="settings-section-panel"
              aria-labelledby={`settings-section-heading-${section.id}`}
              data-settings-section={section.id}
              className="mt-3 min-w-0 md:mt-0"
            >
              <header className="mb-3 px-1">
                <h2
                  id={`settings-section-heading-${section.id}`}
                  className="m-0 font-display text-title font-bold tracking-display text-fg"
                >
                  {section.label}
                </h2>
                <p className="mb-0 mt-1 text-cell leading-base text-muted">{section.description}</p>
              </header>

              <div className="flex min-w-0 flex-col gap-3">
                {section.settingIds.map(id => {
                  const definition = settingDefinition(id);
                  return (
                    <SettingsSection key={definition.id} definition={definition}>
                      {controlsById[definition.id]}
                    </SettingsSection>
                  );
                })}

                {section.id === 'daemons' ? (
                  <>
                    <DaemonSettings
                      activeDaemonId={daemonId}
                      connections={connections}
                      onSelectDaemon={onSelectDaemon}
                      onAddDaemon={onAddDaemon}
                    />
                    {selectedRecord === undefined ? (
                      <p className="m-0 text-ui leading-base text-warn" role="alert">
                        This daemon is not present in the browser’s pairing registry, so its settings cannot be shown.
                      </p>
                    ) : (
                      <DaemonSettingsFrame
                        key={String(daemonId)}
                        connection={selectedRecord}
                        connectionRecord={selectedRecord}
                        name={daemonDisplayName(selectedRecord)}
                        connections={connections}
                        readWardenStatus={readWardenStatus}
                        createWardenClient={createWardenClient}
                        {...(createGrantClient ? { createGrantClient } : {})}
                        {...(createPairingClient ? { createPairingClient } : {})}
                        additionalTabs={daemonSettingsTabs}
                        carrier={carrier}
                        relayAdvertised={relayAdvertised}
                        probeDaemon={probeDaemon}
                        onRenameDaemon={onRenameDaemon}
                        onRemoveDaemon={onRemoveDaemon}
                      />
                    )}
                  </>
                ) : null}
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

/** Kept exported for consumers that need the exact conversation-width contract. */
export { CHAT_WIDTH_OPTIONS };
