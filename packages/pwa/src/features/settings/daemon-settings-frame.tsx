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
import { ChevronDown, KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { type ComponentType, type ReactNode, useId, useMemo, useState } from 'react';
import { useWardenStatus, type WardenStatusReader } from '../../hooks/use-warden-status.ts';
import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { ChoiceRail, type ChoiceRailItem } from '../../shell/choice-rail.tsx';
import { ActiveCarrierCard } from '../carrier/active-carrier-card.tsx';
import { type SecretClientFactory, SecretsSurface } from '../secrets/secrets-surface.tsx';
import { AddDeviceSurface, type PairingClientFactory } from './add-device-settings.tsx';
import { type GrantClientFactory, GrantsSurface } from './grants-settings.tsx';
import { type WardenClientFactory, WardenConfigSurface } from '../warden/warden-config-card.tsx';
import { WardenStrip } from '../warden/warden-strip.tsx';
import { type DaemonReachabilityProbe, DaemonHostChecks } from './daemon-settings.tsx';
import { FleetEnvironmentSettings } from './fleet-environment-settings.tsx';

export interface DaemonSettingsTabProps {
  readonly connection: DaemonConnection;
}

export interface DaemonSettingsTabDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly Surface: ComponentType<DaemonSettingsTabProps>;
}

/** The panel each desktop tab controls; unchanged, because the harness, the app suite and the docs all name it. */
const DAEMON_PANEL_ID = 'daemon-settings-tab-';
/** Each desktop tab's own id, so the open panel can point its `aria-labelledby` back at it. */
const DAEMON_PANEL_TAB_ID = 'daemon-panel-tab-';
/** The same ceiling the two sibling Settings pickers use: keyboard-safe, never taller than 72dvh. */
const PANEL_PICKER_HEIGHT = 'min(72dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))';

/**
 * Icons for the two panels that had them before this rail existed. Every other
 * panel is deliberately iconless: an invented glyph reads as a category that
 * does not exist. Nothing here encodes health — there is no per-panel health
 * read on the daemon, so a status dot would be a colour with no evidence.
 */
const PANEL_ICONS: Readonly<Record<string, ReactNode>> = {
  warden: <ShieldCheck size={16} className="shrink-0" aria-hidden="true" />,
  secrets: <KeyRound size={16} className="shrink-0" aria-hidden="true" />,
  // A lock, because this panel is where a refused control is explained — the one glyph that reads as
  // "permission" rather than as an invented category.
  grants: <Lock size={16} className="shrink-0" aria-hidden="true" />,
};

const unavailableWardenStatus: WardenStatusReader = async () => {
  throw new Error('No Warden status reader was supplied.');
};

function WardenStatusSurface({
  connection,
  readStatus = unavailableWardenStatus,
}: DaemonSettingsTabProps & { readonly readStatus?: WardenStatusReader }) {
  const status = useWardenStatus(connection, readStatus);

  if (status !== null) return <WardenStrip status={status} />;
  return (
    <section className="kt-panel p-panel" role="status" aria-label="Warden status unavailable">
      <h3 className="m-0 text-title font-semibold text-fg">Warden status unavailable</h3>
      <p className="mb-0 mt-1 text-ui leading-base text-muted">
        This daemon did not provide a Warden status. Ferretry will not treat a missing read as a clean fleet or a
        default policy.
      </p>
    </section>
  );
}

function WardenVerdictsUnavailable() {
  return (
    <section className="kt-panel p-panel" aria-labelledby="warden-verdicts-unavailable-heading">
      <h3 id="warden-verdicts-unavailable-heading" className="m-0 text-title font-semibold text-fg">
        Recent verdicts unavailable
      </h3>
      <p className="mb-0 mt-1 text-ui leading-base text-muted">
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
}: DaemonSettingsTabProps & {
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
    () => [
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
              <h3 className="m-0 text-title font-semibold text-fg">Host checks unavailable</h3>
              <p className="mb-0 mt-1 text-ui leading-base text-muted">
                This daemon’s browser pairing record was not supplied, so Ferretry cannot safely show reachability or
                offer pairing changes.
              </p>
            </section>
          );
        },
      },
    ],
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
    icon: PANEL_ICONS[tab.id],
  }));

  return (
    <section
      className="min-w-0"
      data-daemon-settings-frame={String(connection.daemonId)}
      id={`daemon-subtab-panel-${String(connection.daemonId)}`}
      aria-labelledby="daemon-settings-heading"
    >
      <header className="mb-3 rounded-panel border border-border bg-surface p-panel shadow-panel">
        <p className="m-0 text-meta font-semibold uppercase tracking-label text-accent">This daemon</p>
        <h3 id="daemon-settings-heading" className="mt-1 text-title font-semibold text-fg">
          {name}
        </h3>
        {/* The saved name identifies the machine; the address disambiguates it.
            An unnamed daemon already shows its address as the name, so it is not
            repeated. The fingerprint stays inside Host checks' disclosure. */}
        {name === connection.baseUrl ? null : (
          <p className="m-0 mt-0.5 break-all font-mono text-meta leading-tight text-faint">{connection.baseUrl}</p>
        )}
        <p className="mb-0 mt-2 text-ui leading-base text-muted">
          These settings change only this machine. They are shared by browsers paired to it, not this browser’s
          appearance or behaviour preferences.
        </p>
      </header>

      <div className="md:grid md:grid-cols-[200px_minmax(0,1fr)] md:items-start md:gap-3">
        {/* The tablist precedes the trigger that replaces it on a narrow screen,
            so document order is reading order: the control that owns the panel
            comes before its alternative, and before the panel itself. */}
        <div
          data-daemon-settings-tabs="desktop"
          className="hidden rounded-panel border border-border bg-surface p-2 shadow-panel md:sticky md:top-2 md:block"
        >
          <p className="m-0 mb-1 px-1 text-meta font-semibold uppercase tracking-label text-faint">Panels</p>
          <ChoiceRail
            presentation="tabs"
            items={items}
            activeId={active.id}
            onSelect={setActiveTab}
            marker="data-daemon-panel"
            label={`${name} settings panels`}
            tabIdPrefix={DAEMON_PANEL_TAB_ID}
            panelIdPrefix={DAEMON_PANEL_ID}
          />
        </div>

        {/* A phone gets no tablist at all: one touch-safe trigger names the open
            panel and opens the app's shared sheet to change it. */}
        <div className="md:hidden" data-daemon-settings-tabs="mobile">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={panelPickerOpen}
            aria-controls="daemon-panel-picker"
            data-daemon-panel-trigger=""
            onClick={() => setPanelPickerOpen(true)}
            className="flex min-h-[52px] w-full items-center gap-2 rounded-control border border-border bg-surface-2 px-control-x py-2 text-left shadow-panel focus-visible:outline-focus focus-visible:outline-offset-focus"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-meta font-semibold uppercase tracking-label text-faint">Daemon panel</span>
              <span className="block truncate text-ui font-semibold text-fg">{active.label}</span>
            </span>
            <ChevronDown size={17} className="shrink-0 text-muted" aria-hidden="true" />
          </button>
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
              <p className="mb-3 mt-1 text-ui leading-base text-muted">Every setting below belongs to {name}.</p>
              <nav aria-label={`${name} settings panels`}>
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
          <Surface connection={connection} />
        </div>
      </div>
    </section>
  );
}
