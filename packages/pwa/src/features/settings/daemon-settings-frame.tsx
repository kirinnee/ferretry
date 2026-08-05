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
import { Check, KeyRound, ShieldCheck } from 'lucide-react';
import { type ComponentType, useMemo, useState } from 'react';
import { useWardenStatus, type WardenStatusReader } from '../../hooks/use-warden-status.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { ActiveCarrierCard } from '../carrier/active-carrier-card.tsx';
import { type SecretClientFactory, SecretsSurface } from '../secrets/secrets-surface.tsx';
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
      createSecretClient,
      createWardenClient,
      onRemoveDaemon,
      onRenameDaemon,
      probeDaemon,
      readWardenStatus,
      relayAdvertised,
    ],
  );
  const [activeTab, setActiveTab] = useState(tabs[0]?.id ?? 'warden');

  const active = tabs.find(tab => tab.id === activeTab) ?? tabs[0];
  if (!active) return null;
  const Surface = active.Surface;

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
        <p className="mb-0 mt-1 text-ui leading-base text-muted">
          These settings change only this machine. They are shared by browsers paired to it, not this browser’s
          appearance or behaviour preferences.
        </p>
      </header>

      <div
        role="tablist"
        aria-label={`${name} daemon settings`}
        // One row, horizontal overflow only. `overflow-x-auto` alone computes
        // `overflow-y` as auto too, which grows the phantom vertical scrollbar
        // kteam's `ui/DESIGN-side-pane-tabs.md` names; pin it hidden. The
        // sibling daemon strip already does this.
        className="mb-3 flex gap-1 overflow-x-auto overflow-y-hidden rounded-panel border border-border bg-surface p-1 shadow-panel"
      >
        {tabs.map(tab => {
          const selected = tab.id === active.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`daemon-settings-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex min-h-[44px] min-w-[132px] flex-1 items-center gap-2 rounded-control px-control-x py-2 text-left focus-visible:outline-focus focus-visible:outline-offset-focus',
                selected ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
              )}
            >
              {tab.id === 'warden' ? <ShieldCheck size={16} aria-hidden="true" /> : null}
              {tab.id === 'secrets' ? <KeyRound size={16} aria-hidden="true" /> : null}
              <span className="min-w-0">
                <span className="block text-ui font-semibold">{tab.label}</span>
                <span className="block truncate text-meta leading-tight text-faint">{tab.description}</span>
              </span>
              {selected ? <Check size={14} className="ml-auto shrink-0" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>

      <div id={`daemon-settings-tab-${active.id}`} role="tabpanel" aria-label={active.label}>
        <Surface connection={connection} />
      </div>
    </section>
  );
}
