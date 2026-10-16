/**
 * The daemon-scoped Settings route surface.
 *
 * Preferences such as theme and density belong to the reader's browser, but
 * destinations and live state that name a daemon are built from explicit
 * connections. That distinction lets this page switch pairings without
 * retaining the previous daemon's link, health result, or action target.
 *
 * ONE LOOK PER LEVEL (the approved usability proposal). The app's own navigation is above this page;
 * here, the sidebar (desktop) or grouped cards (phone) choose a section or a machine; inside a machine,
 * underlined tabs choose a view; and only actions look like buttons.
 */

import type { ConnectionChoice } from '@ferretry/relay';
import { ChevronLeft } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { DENSITY_OPTIONS, useDensity } from '../../hooks/use-density.ts';
import { type ThemeState, useTheme } from '../../hooks/use-theme.ts';
import type { WardenStatusReader } from '../../hooks/use-warden-status.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonControlsStore } from '../../lib/controls.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { daemonMachineSetupPath, daemonSettingsPath } from '../../lib/pages/routes.ts';
import { CHAT_WIDTH_OPTIONS, ChatWidthControl } from '../../shell/chat-width-control.tsx';
import { Button } from '../../shell/primitives.tsx';
import { ThemeSettings } from '../../shell/theme-toggle.tsx';
import type { FleetClientFactory } from '../fleet/fleet-client.ts';
import { machineItemHash } from '../fleet/setup/settings-route.ts';
import { DEFAULT_MACHINE_TAB, type MachineRoute, machineHash, parseMachineHash } from '../fleet/shell/machine-route.ts';
import {
  type DaemonPanelsRenderer,
  MachinesSurface,
  type MachineTabSurfaces,
} from '../fleet/shell/machines-surface.tsx';
import { useMachineReach } from '../fleet/shell/use-machine-reach.ts';
import { InstallAppSetting } from '../install/install-app.tsx';
import type { SecretClientFactory } from '../secrets/secrets-surface.tsx';
import type { WardenClientFactory } from '../warden/warden-config-card.tsx';
import type { PairingClientFactory } from './add-device-settings.tsx';
import { ComposerEnterKeySettings } from './composer-enter-key-settings.tsx';
import { ComposerSuggestionsSettings } from './composer-suggestions-settings.tsx';
import { MotionSetting } from './conversation-settings.tsx';
import { type DaemonReachabilityProbe, daemonDisplayName, distinctDaemonName } from './daemon-settings.tsx';
import { DaemonSettingsFrame, type DaemonSettingsTabDefinition } from './daemon-settings-frame.tsx';
import { DictationSettings, type DictationSettingsProps } from './dictation-settings.tsx';
import type { GrantClientFactory } from './grants-settings.tsx';
import { MarkdownComposerSettings } from './markdown-composer-settings.tsx';
import type { PasskeyClientFactory } from './security-settings.tsx';
import {
  isSettingId,
  isSettingsSectionId,
  type SettingDefinition,
  type SettingId,
  type SettingsSectionId,
  settingDefinition,
  settingsSectionDefinition,
  settingsSectionForSetting,
} from './settings-catalog.ts';
import { SettingsHome, type SettingsMachineEntry, SettingsSidebar } from './settings-navigation.tsx';

export const TEXT_SCALE_OPTIONS = [
  { id: 'default', label: 'Default', description: 'Use the interface’s designed size.' },
  { id: 'large', label: 'Large', description: '112% of default.' },
  { id: 'larger', label: 'Larger', description: '125% of default.' },
] as const;

/**
 * Addresses that used to open the Daemons section or one of its panels. Daemons is part of each
 * machine now, so these land on that machine's Machine tab — a bookmark, a notice's link or a palette
 * row written before the merge still arrives where it meant to.
 */
const LEGACY_DAEMONS_ANCHOR = 'daemons';
const LEGACY_PANEL_ANCHORS: ReadonlySet<string> = new Set([
  'warden',
  'secrets',
  'devices',
  'grants',
  'security',
  'resource-limits',
  'doctor',
  'model-pricing',
  'security-log',
  'carrier',
  'host-checks',
  'files',
]);

const hashWord = (): string => (typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, ''));

const settingFromHash = (): SettingId | null => {
  const value = hashWord();
  return isSettingId(value) ? value : null;
};

/** The section the address opens, or `null` for Settings' own first screen. */
const sectionFromHash = (): SettingsSectionId | null => {
  const value = hashWord();
  if (isSettingsSectionId(value)) return value;
  if (parseMachineHash(window.location.hash) !== null) return 'machines';
  return isSettingId(value) ? settingsSectionForSetting(value) : null;
};

/** Where a legacy Daemons address now lives, for this page's machine; `null` when it is not one. */
const legacyDaemonsTarget = (machineName: string): string | null => {
  const value = hashWord();
  if (value === LEGACY_DAEMONS_ANCHOR) return machineHash(machineName, 'machine');
  return LEGACY_PANEL_ANCHORS.has(value) ? machineItemHash(machineName, 'machine', value) : null;
};

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
  /** And for the passkey list, so no capture reads or registers a real credential. */
  readonly createPasskeyClient?: PasskeyClientFactory;
  /** And for the secret store, so a harness never reaches for the app store's client pool. */
  readonly createSecretClient?: SecretClientFactory;
  /** Future daemon-owned tabs, appended after Warden in the shared frame. */
  readonly daemonSettingsTabs?: readonly DaemonSettingsTabDefinition[];
  /**
   * The Machines section's client, through the app's pool so every read rides the measured carrier.
   * Without one the section says it cannot read a machine rather than dialling an address itself.
   */
  readonly createMachineClient?: FleetClientFactory;
  /** Machines whose background reads are waiting on an unlock, which the Machines list shows as locked. */
  readonly lockedMachines?: readonly DaemonId[];
  /** The Machines tabs' surfaces; a tab nobody supplies is the shell's honest empty frame. */
  readonly machineTabs?: MachineTabSurfaces;
  readonly onRenameDaemon: (daemonId: DaemonId, label?: string) => void;
  /** A machine answered with the name it goes by, so a pairing that predates keeping it can learn it. */
  readonly onMachineNamed?: (daemonId: DaemonId, name: string) => void;
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
  /** How the page commits an in-app navigation; without one it assigns the address. */
  readonly onNavigate?: (to: string) => void;
  readonly className?: string;
}

/**
 * One Settings implementation for desktop and narrow screens. Desktop keeps a
 * grouped sidebar beside the open section; a phone shows one level per screen —
 * the grouped cards first, then the section with “‹ Settings” — and the page keeps one
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
  createPasskeyClient,
  createSecretClient,
  daemonSettingsTabs,
  createMachineClient,
  machineTabs,
  lockedMachines,
  onRenameDaemon,
  onMachineNamed,
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
  // `null` is Settings' own first screen: the grouped cards on a phone, Appearance on a desktop.
  const [openedSection, setOpenedSection] = useState<SettingsSectionId | null>(() => sectionFromHash());
  const [machineRoute, setMachineRoute] = useState<MachineRoute>(
    () => parseMachineHash(window.location.hash) ?? { tab: DEFAULT_MACHINE_TAB },
  );
  const followedHash = useRef<string | null>(null);
  const focusFrame = useRef<number | undefined>(undefined);
  const selectedRecord = connections.find(candidate => candidate.daemonId === daemonId);
  const selectedName = selectedRecord === undefined ? undefined : daemonDisplayName(selectedRecord);

  const followHash = useCallback((): void => {
    if (followedHash.current === window.location.hash) return;
    // An address from before Daemons joined Machines is rewritten in place, so Back does not return to it.
    const legacy = selectedName === undefined ? null : legacyDaemonsTarget(selectedName);
    if (legacy !== null) window.history.replaceState(window.history.state, '', legacy);
    followedHash.current = window.location.hash;
    const target = settingFromHash();
    const nextMachineRoute = parseMachineHash(window.location.hash);
    if (nextMachineRoute !== null) setMachineRoute(nextMachineRoute);
    setOpenedSection(sectionFromHash());
    if (target === null) return;
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      const setting = document.getElementById(`settings-${target}`);
      setting?.focus({ preventScroll: false });
    });
  }, [selectedName]);

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

  const activeSection: SettingsSectionId = openedSection ?? 'appearance';
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
      motion: <MotionSetting motion={device.motion} onChange={motion => controls.setDeviceControls({ motion })} />,
      'composer-markdown': (
        <MarkdownComposerSettings
          vimEnabled={device.composerVimMode}
          onChangeVim={composerVimMode => controls.setDeviceControls({ composerVimMode })}
        />
      ),
      'composer-enter-key': (
        <ComposerEnterKeySettings
          preference={device.composerEnterKey}
          phonePreference={device.composerPhoneEnterKey}
          onChange={patch => controls.setDeviceControls(patch)}
        />
      ),
      'composer-suggestions': (
        <ComposerSuggestionsSettings preferences={device} onChange={patch => controls.setDeviceControls(patch)} />
      ),
      theme: <ThemeSettings theme={theme} />,
      'install-app': <InstallAppSetting />,
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

  /**
   * A Machines link names a machine by the name this browser shows for it. The PATH decides which
   * daemon answers, so a link naming another paired machine is a request to go there — never a way
   * to show this daemon's setup under that name. Two pairings can share a name, so a name this daemon
   * carries is always "here" and cannot bounce between them.
   *
   * The machine's ADDRESS still answers for it. A pairing made before the daemon's own name was kept
   * was shown, and linked, by its address; the moment it learns its name, a link written with the old
   * spelling would otherwise land on "not paired with this browser" for a machine that is.
   */
  const named =
    machineRoute.machine === undefined
      ? []
      : connections.filter(c => daemonDisplayName(c) === machineRoute.machine || c.baseUrl === machineRoute.machine);
  const switchTo = named.some(candidate => candidate.daemonId === daemonId) ? undefined : named[0];
  const unknownMachine = machineRoute.machine !== undefined && named.length === 0 ? machineRoute.machine : undefined;
  const go = useCallback(
    (to: string): void => (onNavigate ? onNavigate(to) : window.location.assign(to)),
    [onNavigate],
  );
  const openMachine = useCallback(
    (target: DaemonId, tab: MachineRoute['tab']): void => {
      const record = connections.find(candidate => candidate.daemonId === target);
      if (record) go(`${daemonSettingsPath(target)}${machineHash(daemonDisplayName(record), tab)}`);
    },
    [connections, go],
  );
  const openSection = (id: Exclude<SettingsSectionId, 'machines'>): void => go(`${daemonSettingsPath(daemonId)}#${id}`);
  /** Back to Settings' first screen — on a phone, the grouped cards. */
  const home = (): void => go(daemonSettingsPath(daemonId));
  /** A machine's first run is a full screen of its own, outside Settings. */
  const openSetup = useCallback((target: DaemonId): void => go(daemonMachineSetupPath(target)), [go]);
  const switchToId = activeSection === 'machines' ? switchTo?.daemonId : undefined;
  useEffect(() => {
    if (switchToId !== undefined) openMachine(switchToId, machineRoute.tab);
  }, [machineRoute.tab, openMachine, switchToId]);

  const reach = useMachineReach({
    daemonId,
    connections,
    createClient: createMachineClient,
    ...(lockedMachines === undefined ? {} : { locked: lockedMachines }),
    ...(onMachineNamed === undefined ? {} : { onNamed: onMachineNamed }),
  });
  const machines: readonly SettingsMachineEntry[] = connections.map(connection => ({
    daemonId: connection.daemonId,
    name: distinctDaemonName(connection, connections),
    reach: reach.reachOf(connection.daemonId),
  }));

  const daemonPanels = useMemo<DaemonPanelsRenderer | undefined>(
    () =>
      selectedRecord === undefined
        ? undefined
        : (panel, onOpenPanel) => (
            <DaemonSettingsFrame
              key={String(daemonId)}
              connection={selectedRecord}
              connectionRecord={selectedRecord}
              name={daemonDisplayName(selectedRecord)}
              readWardenStatus={readWardenStatus}
              createWardenClient={createWardenClient}
              {...(createGrantClient ? { createGrantClient } : {})}
              {...(createPairingClient ? { createPairingClient } : {})}
              {...(createPasskeyClient ? { createPasskeyClient } : {})}
              {...(createSecretClient ? { createSecretClient } : {})}
              panel={panel}
              onOpenPanel={onOpenPanel}
              additionalTabs={daemonSettingsTabs}
              carrier={carrier}
              relayAdvertised={relayAdvertised}
              probeDaemon={probeDaemon}
              onRenameDaemon={onRenameDaemon}
              onRemoveDaemon={onRemoveDaemon}
            />
          ),
    [
      carrier,
      createGrantClient,
      createPairingClient,
      createPasskeyClient,
      createSecretClient,
      createWardenClient,
      daemonId,
      daemonSettingsTabs,
      onRemoveDaemon,
      onRenameDaemon,
      probeDaemon,
      readWardenStatus,
      relayAdvertised,
      selectedRecord,
    ],
  );

  const navigation = {
    machines,
    onSection: openSection,
    onMachine: (target: DaemonId) => openMachine(target, DEFAULT_MACHINE_TAB),
    onAddMachine: onAddDaemon,
  };
  const atHome = openedSection === null;

  return (
    <main
      data-settings-scroller
      data-density={density}
      data-settings-at-home={atHome ? 'true' : 'false'}
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
        // The phone's first screen is inset cards on a RECESSED ground, so each group reads as one block.
        atHome && 'max-md:bg-ground',
        className,
      )}
    >
      {/* WIDER, because the wrapped paths were the SAME defect as the empty gutters either side of this
          column: the content column is what was short of room, not the page. 1320px keeps a measure that
          is still readable — the prose inside every panel is capped by its own card. */}
      <div className="mx-auto grid w-full max-w-[1320px] min-w-0 grid-cols-1 items-start gap-3 py-2 md:grid-cols-[15rem_minmax(0,1fr)] md:gap-6 md:py-4">
        <div className="sticky top-2 hidden min-w-0 md:block">
          <h1 className="m-0 mb-3 px-control-x font-display text-display font-bold tracking-display">Settings</h1>
          <SettingsSidebar {...navigation} active={activeSection} activeMachine={daemonId} />
        </div>

        {/* THE PHONE'S FIRST SCREEN, and only there: one level per screen, so the cards are the whole page
            until one is tapped. */}
        {atHome ? (
          <div className="min-w-0 md:hidden">
            <h1 className="m-0 mb-2 pt-1 font-display text-display font-bold tracking-display">Settings</h1>
            <SettingsHome {...navigation} />
          </div>
        ) : null}

        <div className={cn('min-w-0', atHome && 'hidden md:block')}>
          <div className="mb-2 md:hidden">
            <Button type="button" variant="ghost" className="kt-btn--flush-start" data-settings-back="" onClick={home}>
              <ChevronLeft size={16} aria-hidden="true" />
              Settings
            </Button>
          </div>

          <section
            id="settings-section-panel"
            aria-labelledby={
              section.id === 'machines' ? 'settings-machine-heading' : `settings-section-heading-${section.id}`
            }
            data-settings-section={section.id}
            className="min-w-0"
          >
            {section.id === 'machines' ? null : (
              <header className="mb-3">
                <h2
                  id={`settings-section-heading-${section.id}`}
                  className="m-0 font-display text-title font-bold tracking-display text-fg"
                >
                  {section.label}
                </h2>
                <p className="mb-0 mt-1 text-cell leading-base text-muted">{section.description}</p>
              </header>
            )}

            <div className="flex min-w-0 flex-col gap-3">
              {section.settingIds.map(id => {
                const definition = settingDefinition(id);
                return (
                  <SettingsSection key={definition.id} definition={definition}>
                    {controlsById[definition.id]}
                  </SettingsSection>
                );
              })}

              {section.id === 'machines' ? (
                createMachineClient === undefined ? (
                  <p className="m-0 text-ui leading-base text-warn" role="alert">
                    Machines cannot be shown because this page was opened without a way to reach them.
                  </p>
                ) : (
                  <MachinesSurface
                    key={String(daemonId)}
                    daemonId={daemonId}
                    connections={connections}
                    tab={machineRoute.tab}
                    reach={reach.reachOf(daemonId)}
                    onRetry={() => reach.check(daemonId)}
                    {...(unknownMachine === undefined ? {} : { unknownMachine })}
                    onOpen={openMachine}
                    onSetUp={openSetup}
                    createClient={createMachineClient}
                    {...(machineTabs ? { tabs: machineTabs } : {})}
                    {...(daemonPanels === undefined ? {} : { daemonPanels })}
                    {...(onRemoveDaemon === undefined ? {} : { onRemove: onRemoveDaemon })}
                  />
                )
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

/** Kept exported for consumers that need the exact conversation-width contract. */
export { CHAT_WIDTH_OPTIONS };
