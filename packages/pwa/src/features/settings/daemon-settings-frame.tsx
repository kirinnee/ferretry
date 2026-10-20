/**
 * Settings owned by one paired daemon, shown inside that machine's Machine tab.
 *
 * Browser settings deliberately do not enter this frame.  Every child receives
 * the selected connection, so a request for one host cannot be reused after a
 * reader switches to another host.  Add the next daemon-owned tab by passing a
 * definition in `additionalTabs`; Warden stays first because it is the first
 * shipped daemon configuration surface.
 */

import type { ConnectionChoice } from '@ferretry/relay';
import {
  ChevronLeft,
  ChevronRight,
  CircleArrowUp,
  CircleDollarSign,
  FileCode2,
  Fingerprint,
  Gauge,
  GraduationCap,
  KeyRound,
  Lock,
  PawPrint,
  Radar,
  Route,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Stethoscope,
  Zap,
} from 'lucide-react';
import { type ComponentType, type ReactNode, useMemo } from 'react';
import type { WardenStatusReader } from '../../hooks/use-warden-status.ts';
import type { ConnectionHealthState } from '../../lib/connection-health.ts';
import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { Button } from '../../shell/primitives.tsx';
import { ActiveCarrierCard } from '../carrier/active-carrier-card.tsx';
import { type SecretClientFactory, SecretsSurface } from '../secrets/secrets-surface.tsx';
import { type WardenClientFactory, WardenConfigSurface } from '../warden/warden-config-card.tsx';
import { AddDeviceSurface, type PairingClientFactory } from './add-device-settings.tsx';
import { DaemonHostChecks, type DaemonReachabilityProbe, daemonDisplayName } from './daemon-settings.tsx';
import { type GrantClientFactory, GrantsSurface } from './grants-settings.tsx';
import { type PasskeyClientFactory, SecuritySurface } from './security-settings.tsx';

export interface DaemonSettingsTabProps {
  readonly connection: DaemonConnection;
}

export interface DaemonSettingsTabDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly Surface: ComponentType<DaemonSettingsTabProps>;
}

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
 * `pricing-settings.tsx` and the harness is how a set ends up
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
  // The fingerprint a passkey sheet shows, because this panel is where that sheet is set up.
  security: <Fingerprint size={16} aria-hidden="true" />,
  'resource-limits': <Gauge size={16} aria-hidden="true" />,
  doctor: <Stethoscope size={16} aria-hidden="true" />,
  'model-pricing': <CircleDollarSign size={16} aria-hidden="true" />,
  // A written record, because the panel is the machine's log of who reached it and what they did.
  'security-log': <ScrollText size={16} aria-hidden="true" />,
  // The measured PATH the traffic is on, which is exactly what a route is.
  carrier: <Route size={16} aria-hidden="true" />,
  'host-checks': <Radar size={16} aria-hidden="true" />,
  // Source code in a file, because the panel is the YAML files this machine's settings live in.
  files: <FileCode2 size={16} aria-hidden="true" />,
  // What new ferrets are instructed to learn, and each ferret's own switch.
  learning: <GraduationCap size={16} aria-hidden="true" />,
  // A paw print: a ferret and its pack of sub-ferrets, and the models guide they are picked from.
  pack: <PawPrint size={16} aria-hidden="true" />,
  // A bolt, because the panel holds the optional keys that make the Warden and dictation faster.
  speedups: <Zap size={16} aria-hidden="true" />,
  // A circled arrow up: the version this machine runs, and moving it to a newer one.
  about: <CircleArrowUp size={16} aria-hidden="true" />,
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

/** One empty list for every render, so a frame given no extra panels does not rebuild (and remount) its own. */
const NO_ADDITIONAL_TABS: readonly DaemonSettingsTabDefinition[] = [];

function WardenSettingsTab({
  connection,
  createWardenClient,
}: {
  /* These two are the frame's OWN panels rather than `additionalTabs` entries, so they take a
     connection and not the whole `DaemonSettingsTabProps`: neither sends a reader to another panel,
     and typing them by the seam would oblige the arrows below to forward a capability they ignore. */
  readonly connection: DaemonConnection;
  readonly createWardenClient?: WardenClientFactory;
}) {
  // The Warden's live status is on the Warden page (Insights); Settings holds only its settings.
  return <WardenConfigSurface connection={connection} createClient={createWardenClient} unavailable="message" />;
}

/** No other machine: stable, so the tab table is not rebuilt on every render. */
const NO_OTHER_MACHINES: readonly DaemonConnectionRecord[] = [];

export interface DaemonSettingsFrameProps {
  readonly connection: DaemonConnection;
  /** The browser's persisted pairing record; only Host checks needs its local metadata. */
  readonly connectionRecord?: DaemonConnectionRecord;
  readonly name: string;
  /** @deprecated Unused since the Warden's status moved to its own page; kept so callers still compile. */
  readonly readWardenStatus?: WardenStatusReader;
  /** Test and harness seam; production uses the daemon-bound default client. */
  readonly createWardenClient?: WardenClientFactory;
  /** The same seam for the secret store. */
  readonly createSecretClient?: SecretClientFactory;
  /** The other machines this browser is paired with, so secrets can be copied to one. */
  readonly otherMachines?: readonly DaemonConnectionRecord[];
  /** And for the grant surface, so no test or harness opens a socket to read a limit. */
  readonly createGrantClient?: GrantClientFactory;
  /** And for pairing, so no harness screenshot can ever contain a real minted code. */
  readonly createPairingClient?: PairingClientFactory;
  /** And for the passkey list, so no harness reads or registers a real credential. */
  readonly createPasskeyClient?: PasskeyClientFactory;
  /** The panel the address opens (`#machines/<machine>/machine/<panel>`); absent shows the list. */
  readonly panel?: string | undefined;
  /** Open a panel, or go back to the list (`null`). The page turns this into an address. */
  readonly onOpenPanel: (panel: string | null) => void;
  /** The words on the way back from an open panel. */
  readonly backLabel?: string;
  /** Fleet and later host-owned settings are supplied here, after Warden. */
  readonly additionalTabs?: readonly DaemonSettingsTabDefinition[];
  /** Measured for this exact daemon connection, never inferred from a preference. */
  readonly carrier?: ConnectionChoice | undefined;
  readonly relayAdvertised?: boolean;
  /** The reconnect loop's state for this daemon, so the Connection tab can say "reconnecting". */
  readonly connectionHealth?: ConnectionHealthState | undefined;
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
  createWardenClient,
  createSecretClient,
  otherMachines = NO_OTHER_MACHINES,
  createGrantClient,
  createPairingClient,
  createPasskeyClient,
  panel,
  onOpenPanel,
  backLabel = 'Machine',
  additionalTabs = NO_ADDITIONAL_TABS,
  carrier,
  relayAdvertised = false,
  connectionHealth,
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
          <WardenSettingsTab connection={activeConnection} createWardenClient={createWardenClient} />
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
            others={otherMachines}
            machineName={daemonDisplayName}
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
        /**
         * Passkeys, right after the limits panel: the confirmation a refused change asks for is made
         * here, so it sits beside the panel that explains the refusal.
         */
        id: 'security',
        label: 'Security',
        description: 'The passkeys this device holds for this machine, and adding another.',
        Surface: ({ connection: activeConnection }) => (
          <SecuritySurface
            connection={activeConnection}
            machineName={name}
            {...(createPasskeyClient ? { createClient: createPasskeyClient } : {})}
          />
        ),
      },
      // A product-owned Doctor surface belongs with the daemon configuration,
      // before the connection carrier and browser-local pairing diagnostics.
      ...additionalTabs,
      {
        id: 'carrier',
        label: 'Connection',
        description: 'How this device reaches the daemon right now: direct, via a relay, or reconnecting.',
        Surface: () => (
          <ActiveCarrierCard
            choice={carrier}
            relayAdvertised={relayAdvertised}
            {...(connectionHealth === undefined ? {} : { health: connectionHealth })}
            machine={name}
          />
        ),
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
    ],
    [
      additionalTabs,
      carrier,
      connectionHealth,
      connectionRecord,
      createGrantClient,
      createPairingClient,
      createPasskeyClient,
      createSecretClient,
      createWardenClient,
      name,
      onRemoveDaemon,
      onRenameDaemon,
      otherMachines,
      probeDaemon,
      relayAdvertised,
    ],
  );
  /**
   * A dynamically supplied panel can disappear between renders, and a link can name one that never
   * existed. Either way the reader lands on the list of panels that DO exist, never on a blank frame.
   */
  const active = panel === undefined ? undefined : tabs.find(tab => tab.id === panel);

  if (active !== undefined) {
    const Surface = active.Surface;
    return (
      <section
        className="flex min-w-0 flex-col gap-3"
        data-daemon-settings-frame={String(connection.daemonId)}
        aria-label={`${active.label} on ${name}`}
      >
        <div>
          <Button
            type="button"
            variant="ghost"
            className="kt-btn--flush-start"
            data-daemon-panel-back=""
            onClick={() => onOpenPanel(null)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
            {backLabel}
          </Button>
        </div>
        <div className="min-w-0" data-daemon-panel-open={active.id}>
          <Surface connection={connection} />
        </div>
      </section>
    );
  }

  return (
    <section
      className="flex min-w-0 flex-col gap-2"
      data-daemon-settings-frame={String(connection.daemonId)}
      aria-labelledby="daemon-settings-heading"
    >
      <div>
        <h4 id="daemon-settings-heading" className="m-0 text-meta font-semibold uppercase text-muted">
          Connection and security
        </h4>
        <p className="mb-0 mt-0.5 text-meta leading-base text-muted">
          This machine: shared by every device paired to {name}. Appearance and behaviour stay on each device.
        </p>
      </div>
      <ul className="kt-groupcard m-0 list-none p-0" aria-label={`${name} connection and security`}>
        {tabs.map(tab => (
          <li key={tab.id}>
            <button
              type="button"
              className="kt-grouprow"
              data-daemon-panel={tab.id}
              onClick={() => onOpenPanel(tab.id)}
            >
              <span className="flex w-5 shrink-0 justify-center text-muted" aria-hidden="true">
                {PANEL_ICONS[tab.id] ?? FALLBACK_PANEL_ICON}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-ui font-semibold text-fg">{tab.label}</span>
                <span className="text-meta leading-tight text-muted">{tab.description}</span>
              </span>
              <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
