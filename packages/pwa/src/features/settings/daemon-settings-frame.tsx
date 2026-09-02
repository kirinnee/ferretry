/**
 * Settings owned by one paired daemon.
 *
 * Browser settings deliberately do not enter this frame.  Every child receives
 * the selected connection, so a request for one host cannot be reused after a
 * reader switches to another host.  Add the next daemon-owned tab by passing a
 * definition in `additionalTabs`; Warden stays first because it is the first
 * shipped daemon configuration surface.
 */

import type { ConnectionChoice } from '@ferretry/relay';
import {
  CircleDollarSign,
  Gauge,
  KeyRound,
  Lock,
  LogIn,
  Radar,
  Route,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Stethoscope,
  Users,
  Variable,
} from 'lucide-react';
import { type ComponentType, type ReactNode, useId, useMemo, useState } from 'react';
import { useWardenStatus, type WardenStatusReader } from '../../hooks/use-warden-status.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { ChoiceRail, type ChoiceRailItem } from '../../shell/choice-rail.tsx';
import { EYEBROW, PanelPath } from '../../shell/panel-typography.tsx';
import { PickerTrigger } from '../../shell/picker-trigger.tsx';
import { ActiveCarrierCard } from '../carrier/active-carrier-card.tsx';
import { type SecretClientFactory, SecretsSurface } from '../secrets/secrets-surface.tsx';
import { type WardenClientFactory, WardenConfigSurface } from '../warden/warden-config-card.tsx';
import { WardenStrip } from '../warden/warden-strip.tsx';
import { AddDeviceSurface, type PairingClientFactory } from './add-device-settings.tsx';
import { DaemonHostChecks, type DaemonReachabilityProbe } from './daemon-settings.tsx';
import { FleetEnvironmentSettings } from './fleet-environment-settings.tsx';
import { type GrantClientFactory, GrantsSurface } from './grants-settings.tsx';

export interface DaemonSettingsTabProps {
  readonly connection: DaemonConnection;
  /**
   * Move to a SIBLING panel of this same frame, by id. Ignored for an id this frame does not mount.
   *
   * A panel that sends a reader to another panel used to have to send them to a ROUTE, which is how
   * Accounts came to be a top-level destination while its data was daemon-scoped. There is no address
   * for a panel — the selection is this frame's own state, deliberately, so switching daemons cannot
   * leave one host's panel name over another host's settings — so the frame hands each surface the one
   * move it could otherwise only fake with a link that goes somewhere else.
   */
  readonly openPanel: (id: string) => void;
}

export interface DaemonSettingsTabDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /**
   * The panel this one BELONGS TO, when it is a level down rather than an eleventh sibling.
   *
   * Declared by the definition rather than by where the composition root happens to list it: the tab
   * factory knows the relation, `App.tsx` knows the mounting order, and only one of those two facts
   * survives somebody reordering an array. {@link orderedDaemonPanels} then puts the child directly
   * under its parent, so the rail's order cannot disagree with the relation it draws.
   */
  readonly parentId?: string;
  readonly Surface: ComponentType<DaemonSettingsTabProps>;
}

/**
 * The panels in rail order: every parent where it was listed, each of its children directly under it.
 *
 * ONE LEVEL, AND NO PANEL CAN EVER FALL OUT OF THE LIST. A row only counts as a child when the id it
 * names belongs to a DIFFERENT panel that is itself top-level, which is what makes this total: a
 * parent that is not mounted, a panel naming itself, and two panels naming each other all come back
 * as ordinary top-level rows rather than disappearing. A settings panel that silently vanished
 * because of how it declared a relation would be unreachable with nothing on screen to say so, and
 * the frame is the last place that should be able to happen.
 */
export const orderedDaemonPanels = (
  tabs: readonly DaemonSettingsTabDefinition[],
): readonly DaemonSettingsTabDefinition[] => {
  const child = (tab: DaemonSettingsTabDefinition): boolean =>
    tabs.some(parent => parent.id === tab.parentId && parent.id !== tab.id && parent.parentId === undefined);
  return tabs.flatMap(tab =>
    child(tab) ? [] : [tab, ...tabs.filter(candidate => candidate.parentId === tab.id && child(candidate))],
  );
};

/** The panel each desktop tab controls; unchanged, because the harness, the app suite and the docs all name it. */
const DAEMON_PANEL_ID = 'daemon-settings-tab-';
/** Each desktop tab's own id, so the open panel can point its `aria-labelledby` back at it. */
const DAEMON_PANEL_TAB_ID = 'daemon-panel-tab-';
/** The same ceiling the two sibling Settings pickers use: keyboard-safe, never taller than 72dvh. */
const PANEL_PICKER_HEIGHT = 'min(72dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))';

/**
 * ONE ICON PER PANEL — EVERY panel, from one set, at one size.
 *
 * Three of ten rows carrying a glyph is not restraint, it is an unfinished list, and it read as one:
 * the rail's left edge alternated between two x positions all the way down, because a row without an
 * icon does not indent its label. The earlier rule here — "an invented glyph reads as a category that
 * does not exist" — was answering the wrong question. The glyph is not naming a category; it is a
 * per-row landmark, which is what makes a ten-row rail scannable at a glance, and every settings
 * sidebar the reader already uses has one on every row.
 *
 * The whole table is here, in the frame that owns the rail, INCLUDING the ids the composition root
 * supplies through `additionalTabs`. That is deliberate: spreading the choices across `App.tsx`,
 * `pricing-settings.tsx`, `fleet-configuration-surface.tsx` and the harness is how a set ends up
 * mixing sources and sizes, and no `additionalTabs` caller has to know this rail draws icons at all.
 *
 * lucide at 16px — the app's HEADING optical size, per `panel-typography.tsx` — laid out by the rail's
 * own fixed slot, so nothing here sets a width or an alignment. Nothing here encodes health either:
 * there is no per-panel health read on the daemon, so a status dot would be a colour with no evidence.
 */
const PANEL_ICONS: Readonly<Record<string, ReactNode>> = {
  warden: <ShieldCheck size={16} aria-hidden="true" />,
  secrets: <KeyRound size={16} aria-hidden="true" />,
  // A phone, because the panel's subject is the other device — the thing being added, not this one.
  devices: <Smartphone size={16} aria-hidden="true" />,
  // A lock, because this panel is where a refused control is explained — the one glyph that reads as
  // "permission" rather than as an invented category.
  grants: <Lock size={16} aria-hidden="true" />,
  // The environment is a set of NAMED VALUES, which is what this glyph is; a gear would say
  // "configuration", and every panel in this rail is configuration.
  environment: <Variable size={16} aria-hidden="true" />,
  'resource-limits': <Gauge size={16} aria-hidden="true" />,
  doctor: <Stethoscope size={16} aria-hidden="true" />,
  'model-pricing': <CircleDollarSign size={16} aria-hidden="true" />,
  // Accounts on the host, so the glyph is the accounts rather than the machine.
  fleet: <Users size={16} aria-hidden="true" />,
  // The child of Fleet, and the glyph says which half it is: Fleet writes the wrappers, this one is
  // where a login is signed in. A key would have been the obvious pick and is already Secrets'.
  accounts: <LogIn size={16} aria-hidden="true" />,
  // The measured PATH the traffic is on, which is exactly what a route is.
  carrier: <Route size={16} aria-hidden="true" />,
  'host-checks': <Radar size={16} aria-hidden="true" />,
};

/**
 * The glyph a panel gets when this table has never heard of its id.
 *
 * `additionalTabs` is an open seam, so a panel can arrive here that {@link PANEL_ICONS} does not name.
 * The failure mode that matters is the one being fixed: a rail where SOME rows have icons. A neutral
 * fallback keeps the column complete and the left edge straight, and the unit suite asserts every panel
 * the composition root actually mounts has a real entry — so this is a safety net, not a licence.
 */
const FALLBACK_PANEL_ICON: ReactNode = <SlidersHorizontal size={16} aria-hidden="true" />;

const unavailableWardenStatus: WardenStatusReader = async () => {
  throw new Error('No Warden status reader was supplied.');
};

function WardenStatusSurface({
  connection,
  readStatus = unavailableWardenStatus,
}: {
  readonly connection: DaemonConnection;
  readonly readStatus?: WardenStatusReader;
}) {
  const status = useWardenStatus(connection, readStatus);

  if (status !== null) return <WardenStrip status={status} />;
  return (
    <section className="kt-panel p-panel" role="status" aria-label="Warden status unavailable">
      <h3 className="m-0 text-row font-semibold text-fg">Warden status unavailable</h3>
      <p className="mb-0 mt-1 text-cell leading-base text-muted">
        This daemon did not provide a Warden status. Ferretry will not treat a missing read as a clean fleet or a
        default policy.
      </p>
    </section>
  );
}

function WardenVerdictsUnavailable() {
  return (
    <section className="kt-panel p-panel" aria-labelledby="warden-verdicts-unavailable-heading">
      <h3 id="warden-verdicts-unavailable-heading" className="m-0 text-row font-semibold text-fg">
        Recent verdicts unavailable
      </h3>
      <p className="mb-0 mt-1 text-cell leading-base text-muted">
        This daemon does not expose a verdict feed yet, so report provenance is unavailable too. No empty history is
        presented as evidence that the fleet is healthy.
      </p>
    </section>
  );
}

function WardenSettingsTab({
  connection,
  readStatus,
  createWardenClient,
}: {
  /* These two are the frame's OWN panels rather than `additionalTabs` entries, so they take a
     connection and not the whole `DaemonSettingsTabProps`: neither sends a reader to another panel,
     and typing them by the seam would oblige the arrows below to forward a capability they ignore. */
  readonly connection: DaemonConnection;
  readonly readStatus?: WardenStatusReader;
  readonly createWardenClient?: WardenClientFactory;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <WardenStatusSurface connection={connection} readStatus={readStatus} />
      <WardenConfigSurface connection={connection} createClient={createWardenClient} unavailable="message" />
      <WardenVerdictsUnavailable />
    </div>
  );
}

export interface DaemonSettingsFrameProps {
  readonly connection: DaemonConnection;
  /** The browser's persisted pairing record; only Host checks needs its local metadata. */
  readonly connectionRecord?: DaemonConnectionRecord;
  readonly name: string;
  /** All paired daemons are needed only as configuration-copy sources. */
  readonly connections?: readonly DaemonConnection[];
  readonly readWardenStatus?: WardenStatusReader;
  /** Test and harness seam; production uses the daemon-bound default client. */
  readonly createWardenClient?: WardenClientFactory;
  /** The same seam for the secret store. */
  readonly createSecretClient?: SecretClientFactory;
  /** And for the grant surface, so no test or harness opens a socket to read a limit. */
  readonly createGrantClient?: GrantClientFactory;
  /** And for pairing, so no harness screenshot can ever contain a real minted code. */
  readonly createPairingClient?: PairingClientFactory;
  /** Fleet and later host-owned settings are supplied here, after Warden. */
  readonly additionalTabs?: readonly DaemonSettingsTabDefinition[];
  /** Measured for this exact daemon connection, never inferred from a preference. */
  readonly carrier?: ConnectionChoice | undefined;
  readonly relayAdvertised?: boolean;
  readonly probeDaemon?: DaemonReachabilityProbe;
  readonly onRenameDaemon?: (daemonId: DaemonConnection['daemonId'], label?: string) => void;
  readonly onRemoveDaemon?: (daemonId: DaemonConnection['daemonId']) => void;
}

/**
 * The daemon-owned tab frame. The caller keys this component by daemon id, so
 * switching hosts remounts its local tab state rather than retaining a view
 * that names the daemon the reader just left.
 */
export function DaemonSettingsFrame({
  connection,
  connectionRecord,
  name,
  connections = [connection],
  readWardenStatus,
  createWardenClient,
  createSecretClient,
  createGrantClient,
  createPairingClient,
  additionalTabs = [],
  carrier,
  relayAdvertised = false,
  probeDaemon,
  onRenameDaemon,
  onRemoveDaemon,
}: DaemonSettingsFrameProps) {
  const tabs = useMemo<readonly DaemonSettingsTabDefinition[]>(
    () =>
      orderedDaemonPanels([
        {
          id: 'warden',
          label: 'Warden',
          description: 'Supervision, account failover, and policy for this daemon.',
          Surface: ({ connection: activeConnection }) => (
            <WardenSettingsTab
              connection={activeConnection}
              readStatus={readWardenStatus}
              createWardenClient={createWardenClient}
            />
          ),
        },
        {
          id: 'secrets',
          label: 'Secrets',
          description: 'Credentials agents can use without ever holding one.',
          Surface: ({ connection: activeConnection }) => (
            <SecretsSurface
              connection={activeConnection}
              {...(createSecretClient ? { createClient: createSecretClient } : {})}
            />
          ),
        },
        {
          /**
           * Adding a device, immediately after the two panels that own this machine's own configuration.
           *
           * It is here rather than in a global Settings section because a pairing code belongs to ONE
           * machine: the code, the device list and every revoke are read from this tab's connection, so a
           * reader can never revoke a device on the daemon they just switched away from.
           */
          id: 'devices',
          label: 'Add a device',
          description: 'Pair another phone or browser with this machine, and revoke one.',
          Surface: ({ connection: activeConnection }) => (
            <AddDeviceSurface
              connection={activeConnection}
              {...(createPairingClient ? { createClient: createPairingClient } : {})}
            />
          ),
        },
        {
          /**
           * The operator's limits, second, because it is the panel that explains why another panel's
           * control is refused. A reader who meets a disabled control in Warden or Fleet is sent here,
           * so it must not be buried after the tabs that send them.
           */
          id: 'grants',
          label: 'What devices may do',
          description: 'Per-capability limits for callers that are not on this machine.',
          Surface: ({ connection: activeConnection }) => (
            <GrantsSurface
              connection={activeConnection}
              {...(createGrantClient ? { createClient: createGrantClient } : {})}
            />
          ),
        },
        {
          // Environment carries VALUES between daemons; Secrets deliberately does not — a secret is
          // copied explicitly and per-secret or not at all, never as a side effect of copying
          // configuration. See `docs/secrets.md`; that copy path is still a declared GAP.
          id: 'environment',
          label: 'Environment',
          description: 'Copy safe fleet profile environment between daemons.',
          Surface: ({ connection: activeConnection }) => (
            <FleetEnvironmentSettings connection={activeConnection} connections={connections} />
          ),
        },
        // A product-owned Doctor surface belongs with the daemon configuration,
        // before the connection carrier and browser-local pairing diagnostics.
        ...additionalTabs,
        {
          id: 'carrier',
          label: 'Carrier',
          description: 'The measured path this daemon is using right now.',
          Surface: () => <ActiveCarrierCard choice={carrier} relayAdvertised={relayAdvertised} />,
        },
        {
          id: 'host-checks',
          label: 'Host checks',
          description: 'Reachability and this browser’s pairing for this daemon.',
          Surface: () => {
            if (connectionRecord && probeDaemon && onRenameDaemon && onRemoveDaemon)
              return (
                <DaemonHostChecks
                  connection={connectionRecord}
                  probeDaemon={probeDaemon}
                  carrier={carrier}
                  onRenameDaemon={onRenameDaemon}
                  onRemoveDaemon={onRemoveDaemon}
                />
              );
            return (
              <section className="kt-panel p-panel" role="status" aria-label="Host checks unavailable">
                <h3 className="m-0 text-row font-semibold text-fg">Host checks unavailable</h3>
                <p className="mb-0 mt-1 text-cell leading-base text-muted">
                  This daemon’s browser pairing record was not supplied, so Ferretry cannot safely show reachability or
                  offer pairing changes.
                </p>
              </section>
            );
          },
        },
      ]),
    [
      additionalTabs,
      carrier,
      connectionRecord,
      connections,
      createGrantClient,
      createPairingClient,
      createSecretClient,
      createWardenClient,
      onRemoveDaemon,
      onRenameDaemon,
      probeDaemon,
      readWardenStatus,
      relayAdvertised,
    ],
  );
  // The selection lives HERE, inside the frame the caller keys by daemon id, so
  // switching hosts remounts it. Hoisting it beside the rail would survive that
  // remount and show daemon B under daemon A's panel name.
  const [activeTab, setActiveTab] = useState(tabs[0]?.id ?? 'warden');
  const [panelPickerOpen, setPanelPickerOpen] = useState(false);
  const pickerTitleId = useId();

  /**
   * A dynamically supplied panel can disappear between renders. The fallback is
   * resolved at render time and deliberately fail-closed: the reader lands on a
   * panel that exists rather than on a blank frame, and the choice is always the
   * first one, so it is predictable rather than positional guesswork.
   *
   * `activeTab` itself is left alone. If that panel is supplied again it becomes
   * selected again, which is the behaviour a reader who never chose to leave it
   * would expect; nothing else reads the id, so a selection with no panel is
   * inert rather than wrong.
   */
  const active = tabs.find(tab => tab.id === activeTab) ?? tabs[0];
  if (!active) return null;
  const Surface = active.Surface;
  const items: readonly ChoiceRailItem[] = tabs.map(tab => ({
    id: tab.id,
    label: tab.label,
    detail: tab.description,
    icon: PANEL_ICONS[tab.id] ?? FALLBACK_PANEL_ICON,
    ...(tab.parentId === undefined ? {} : { parentId: tab.parentId }),
  }));
  const activeIcon = PANEL_ICONS[active.id] ?? FALLBACK_PANEL_ICON;
  /** Only ever a panel this frame really mounts; an unknown id leaves the reader where they are. */
  const openPanel = (id: string): void => {
    if (tabs.some(tab => tab.id === id)) setActiveTab(id);
  };

  return (
    <section
      className="min-w-0"
      data-daemon-settings-frame={String(connection.daemonId)}
      id={`daemon-subtab-panel-${String(connection.daemonId)}`}
      aria-labelledby="daemon-settings-heading"
    >
      {/* ONE LEVEL OF CONTAINMENT. This was a bordered card, and everything it introduces — the rail
          beside it and every panel below it — is also a bordered card, so three of them competed at the
          same depth. It is now separated by TONE and a single rule instead, which is what a header at
          the top of a column is: the panels keep the borders, because they are the things being read. */}
      <header className="mb-3 border-b border-border pb-3">
        <p className={cn(EYEBROW, 'text-accent')}>This daemon</p>
        {/* The machine's name stays at SECTION level. Every card below it stepped down to `text-row`,
            and this heading is one rung above them: it names the thing all ten panels belong to. */}
        <h3 id="daemon-settings-heading" className="mt-1 text-title font-semibold text-fg">
          {name}
        </h3>
        {/* The saved name identifies the machine; the address disambiguates it.
            An unnamed daemon already shows its address as the name, so it is not
            repeated. The fingerprint stays inside Host checks' disclosure.

            An address is ONE TOKEN: `break-all` tore it into a stack of fragments
            that reads as a corrupted value rather than a wrapped one. */}
        {name === connection.baseUrl ? null : (
          <PanelPath value={connection.baseUrl} className="mt-0.5 text-meta leading-tight text-faint" />
        )}
        <p className="mb-0 mt-2 text-cell leading-base text-muted">
          These settings change only this machine. They are shared by browsers paired to it, not this browser’s
          appearance or behaviour preferences.
        </p>
      </header>

      <div className="md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:items-start md:gap-md">
        {/* The tablist precedes the trigger that replaces it on a narrow screen,
            so document order is reading order: the control that owns the panel
            comes before its alternative, and before the panel itself.

            NO CARD AROUND IT, for the same reason the header above lost its own: a
            bordered box of rows beside a bordered panel of content is two cards at
            one depth, and the rail is navigation rather than a thing being read. */}
        <div data-daemon-settings-tabs="desktop" className="hidden md:sticky md:top-2 md:block">
          <p className={cn(EYEBROW, 'mb-1 px-control-x')}>Panels</p>
          <ChoiceRail
            presentation="tabs"
            items={items}
            activeId={active.id}
            onSelect={setActiveTab}
            marker="data-daemon-panel"
            label={`${name} settings panels`}
            tabIdPrefix={DAEMON_PANEL_TAB_ID}
            panelIdPrefix={DAEMON_PANEL_ID}
            // SINGLE LINE beside the panel. Ten two-line rows made this rail 900px tall next to a 250px
            // panel — the rail was the tallest thing on the page — and the descriptions ran to two, three
            // and four lines, so there was no shared row height to have a rhythm with. The sentence is not
            // lost: the panel one column to the right opens with its own heading and its own explanation,
            // the sheet on a phone still carries it, and Cmd/Ctrl+K searches all ten by description.
            rows="single-line"
          />
        </div>

        {/* A phone gets no tablist at all: one touch-safe trigger names the open
            panel and opens the app's shared sheet to change it. */}
        <div className="md:hidden" data-daemon-settings-tabs="mobile">
          <PickerTrigger
            eyebrow="Daemon panel"
            value={active.label}
            icon={activeIcon}
            open={panelPickerOpen}
            controls="daemon-panel-picker"
            marker="data-daemon-panel-trigger"
            onOpen={() => setPanelPickerOpen(true)}
          />
          <BottomSheet
            id="daemon-panel-picker"
            open={panelPickerOpen}
            onClose={() => setPanelPickerOpen(false)}
            labelledBy={pickerTitleId}
            closeLabel="Close daemon panel picker"
            panelClassName="bg-surface"
            maxHeight={PANEL_PICKER_HEIGHT}
            zIndexClass="z-50"
          >
            <div className="min-h-0 overflow-y-auto px-panel pb-4">
              <h2 id={pickerTitleId} className="m-0 font-display text-title font-semibold tracking-display text-fg">
                Choose a panel
              </h2>
              <p className="mb-3 mt-1 text-cell leading-base text-muted">Every setting below belongs to {name}.</p>
              <nav aria-label={`${name} settings panels`}>
                {/* Two-line rows HERE, unlike the desktop rail: a sheet row is being chosen blind, so
                    the description is the only thing telling ten rows apart behind a closed sheet. */}
                <ChoiceRail
                  items={items}
                  activeId={active.id}
                  marker="data-daemon-panel-choice"
                  onSelect={id => {
                    setActiveTab(id);
                    setPanelPickerOpen(false);
                  }}
                />
              </nav>
            </div>
          </BottomSheet>
        </div>

        <div
          id={`${DAEMON_PANEL_ID}${active.id}`}
          role="tabpanel"
          aria-labelledby={`${DAEMON_PANEL_TAB_ID}${active.id}`}
          className="mt-3 min-w-0 md:mt-0"
        >
          {/* NO PANEL HEADER HERE, and that was tried first.
              Repeating the rail row's label and description above the surface looked like the honest way
              to pay for the desktop rail going single-line. It is not: every one of these ten surfaces
              already opens with its own heading and its own sentence, so the header made a THIRD title
              for the same panel and added height to a page whose complaint was clutter — the harness's
              own "does the resource-limit evidence still fit one screen" check failed on it, which is how
              it got caught. The rail's second line is redundant on desktop rather than missing: the panel
              is beside the row, already explaining itself. On a phone it is not redundant, because the
              sheet is chosen with the panel hidden behind it, so the sheet keeps it. */}
          <Surface connection={connection} openPanel={openPanel} />
        </div>
      </div>
    </section>
  );
}
