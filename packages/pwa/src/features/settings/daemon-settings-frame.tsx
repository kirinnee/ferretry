/**
 * Settings owned by one paired daemon, shown inside that machine's Machine tab.
 *
 * Browser settings deliberately do not enter this frame.  Every child receives
 * the selected connection, so a request for one host cannot be reused after a
 * reader switches to another host.  Add the next daemon-owned tab by passing a
 * definition in `additionalTabs`; Warden stays first because it is the first
 * shipped daemon configuration surface.
 */

import { DAEMON_FEATURES, type TwoFactorStageId } from '@ferretry/protocol';
import type { ConnectionChoice } from '@ferretry/relay';
import {
  ChevronLeft,
  ChevronRight,
  CircleArrowUp,
  CircleDollarSign,
  ClipboardPaste,
  FileCode2,
  Fingerprint,
  Gauge,
  GraduationCap,
  KeyRound,
  Library,
  Lock,
  PawPrint,
  Radar,
  Route,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  SquareTerminal,
  Stethoscope,
  UserRound,
  Zap,
} from 'lucide-react';
import { type ComponentType, createContext, type ReactNode, useContext, useMemo } from 'react';
import { useCarrierRtt } from '../../hooks/use-carrier-rtt.ts';
import type { WardenStatusReader } from '../../hooks/use-warden-status.ts';
import type { ConnectionHealthState } from '../../lib/connection-health.ts';
import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { machineLacks, machineOffers } from '../../lib/daemon-health.ts';
import { needsNewerFerretry } from '../../lib/machine-update-words.ts';
import {
  useAddKeyStepUp,
  useApprovePasteRuleStepUp,
  useApproveSignInRuleStepUp,
  useDaemonClient,
} from '../../lib/store.tsx';
import { daemonSharingPath } from '../../lib/pages/routes.ts';
import { useOptionalRouter } from '../../lib/router.tsx';
import type { StepUpWords } from '../../lib/step-up-gate.ts';
import { useDaemonHealth } from '../../lib/use-daemon-health.ts';
import { Button } from '../../shell/primitives.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { AccountsSurface } from '../accounts/accounts-surface.tsx';
import { ActiveCarrierCard, type CarrierPreferenceControl } from '../carrier/active-carrier-card.tsx';
import { LoginsSurface } from '../secrets/logins-surface.tsx';
import { type SecretClientFactory, SecretsSurface } from '../secrets/secrets-surface.tsx';
import { CopyRulesSurface } from '../secure-copy/copy-rules-surface.tsx';
import { SignInRulesSurface } from '../secure-copy/sign-in-rules-surface.tsx';
import { TaskPlansSurface } from '../secure-copy/task-plans-surface.tsx';
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
  accounts: <UserRound size={16} aria-hidden="true" />,
  'secure-copy': <ClipboardPaste size={16} aria-hidden="true" />,
  catalogs: <Library size={16} aria-hidden="true" />,
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
  // A paw print: a ferret and its pack of sub-ferrets, and the routing prompt they are picked by.
  pack: <PawPrint size={16} aria-hidden="true" />,
  // A bolt, because the panel holds the optional keys that make the Warden and dictation faster.
  speedups: <Zap size={16} aria-hidden="true" />,
  // A circled arrow up: the version this machine runs, and moving it to a newer one.
  about: <CircleArrowUp size={16} aria-hidden="true" />,
  // A terminal prompt: the command-line agents (Claude Code, Codex) this machine's ferrets run.
  'agent-clis': <SquareTerminal size={16} aria-hidden="true" />,
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

/** No other machine: stable, so the tab table is not rebuilt on every render. */
const NO_OTHER_MACHINES: readonly DaemonConnectionRecord[] = [];

/**
 * WHAT THE FRAME'S OWN PANELS READ THAT CAN CHANGE WHILE ONE IS OPEN — the carrier, the reconnect state,
 * the page's callbacks — handed down through a context rather than closed over.
 *
 * A panel's `Surface` is a component TYPE. A Surface written as an arrow inside the frame is a new type
 * every time any of these changed identity, and React unmounts a subtree whose type changed: the open
 * panel lost what the person was typing, showed its "reading…" placeholder and dropped the scroll
 * position. The app re-renders Settings on every background session poll (every 15 seconds) and the page
 * hands down fresh callbacks each time, so that was "it keeps refreshing, esp after I typed". The panels
 * are now declared once, below, and only RE-RENDER when one of these changes.
 */
interface FrameLive {
  readonly name: string;
  readonly connectionRecord: DaemonConnectionRecord | undefined;
  readonly createWardenClient: WardenClientFactory | undefined;
  readonly createSecretClient: SecretClientFactory | undefined;
  readonly otherMachines: readonly DaemonConnectionRecord[];
  readonly createGrantClient: GrantClientFactory | undefined;
  readonly createPairingClient: PairingClientFactory | undefined;
  readonly createPasskeyClient: PasskeyClientFactory | undefined;
  readonly carrier: ConnectionChoice | undefined;
  readonly relayAdvertised: boolean;
  readonly carrierPreference: CarrierPreferenceControl | undefined;
  readonly connectionHealth: ConnectionHealthState | undefined;
  readonly measureCarrierRtt: (() => Promise<number | undefined>) | undefined;
  readonly probeDaemon: DaemonReachabilityProbe | undefined;
  readonly onRenameDaemon: ((daemonId: DaemonConnection['daemonId'], label?: string) => void) | undefined;
  readonly onRemoveDaemon: ((daemonId: DaemonConnection['daemonId']) => void) | undefined;
}

const FrameLiveContext = createContext<FrameLive | null>(null);

function useFrameLive(): FrameLive {
  const live = useContext(FrameLiveContext);
  if (live === null) throw new Error('a daemon settings panel rendered outside its frame');
  return live;
}

function WardenPanel({ connection }: DaemonSettingsTabProps) {
  const { createWardenClient } = useFrameLive();
  // The Warden's live status is on the Warden page (Insights); Settings holds only its settings.
  return <WardenConfigSurface connection={connection} createClient={createWardenClient} unavailable="message" />;
}

function SecretsPanel({ connection }: DaemonSettingsTabProps) {
  const { createSecretClient, otherMachines } = useFrameLive();
  return (
    <SecretsSurface
      connection={connection}
      {...(createSecretClient ? { createClient: createSecretClient } : {})}
      others={otherMachines}
      machineName={daemonDisplayName}
    />
  );
}

function AccountsPanel({ connection }: DaemonSettingsTabProps) {
  const { createSecretClient } = useFrameLive();
  const routed = useDaemonClient();
  const health = useDaemonHealth(connection);
  const requireAddKey = useAddKeyStepUp();
  const requireRule = useApproveSignInRuleStepUp();
  const createClient = createSecretClient ?? routed;
  // A machine that does not say it has accounts keeps today's saved-logins surface, whatever the reason it is silent.
  if (!machineOffers(health, DAEMON_FEATURES.accountsSignIns))
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {machineLacks(health, DAEMON_FEATURES.accountsSignIns) ? (
          <UpdateNote what="Accounts with their sign-ins, 2FA keys and standing rules" />
        ) : null}
        <LoginsSurface connection={connection} createClient={createClient} />
      </div>
    );
  const withKeys = machineOffers(health, DAEMON_FEATURES.twoFactorKeys);
  const withRules = machineOffers(health, DAEMON_FEATURES.signInRules);
  const lacking = [
    ...(machineLacks(health, DAEMON_FEATURES.twoFactorKeys) ? ['2FA keys'] : []),
    ...(machineLacks(health, DAEMON_FEATURES.signInRules) ? ['standing sign-in rules'] : []),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {lacking.length === 0 ? null : <UpdateNote what={lacking.join(' and ')} />}
      <AccountsSurface
        connection={connection}
        createClient={createClient}
        withKeys={withKeys}
        {...(withRules
          ? {
              rules: {
                askPasskey:
                  requireRule === undefined
                    ? undefined
                    : (stage: `srs_${string}`, words: StepUpWords) => requireRule(connection, stage, words),
              },
            }
          : {})}
        {...(withKeys && requireAddKey !== undefined
          ? { addKey: (stage: TwoFactorStageId, words: string) => requireAddKey(connection, stage, words) }
          : {})}
      />
    </div>
  );
}

/** A machine that answered without a feature name: say so in one line, never leave the group silently shorter. */
function UpdateNote({ what }: { readonly what: string }) {
  return (
    <p className="m-0 text-cell text-muted" data-machine-needs-update="" role="status">
      {needsNewerFerretry(what)}
    </p>
  );
}

function SecureCopyPanel({ connection }: DaemonSettingsTabProps) {
  const { createSecretClient } = useFrameLive();
  const routed = useDaemonClient();
  const health = useDaemonHealth(connection);
  const createClient = createSecretClient ?? routed;
  const requirePasteRule = useApprovePasteRuleStepUp();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <CopyRulesSurface
        connection={connection}
        createClient={createClient}
        staging={machineOffers(health, DAEMON_FEATURES.pasteRulePasskey)}
        {...(requirePasteRule === undefined
          ? {}
          : { askPasskey: (stage, words, act) => requirePasteRule(connection, stage, words, act) })}
      />
      {machineOffers(health, DAEMON_FEATURES.taskPlan) ? (
        <TaskPlansSurface connection={connection} createClient={createClient} />
      ) : machineLacks(health, DAEMON_FEATURES.taskPlan) ? (
        <UpdateNote what="Task plans" />
      ) : null}
      {machineOffers(health, DAEMON_FEATURES.signInRules) ? (
        <SignInRulesSurface connection={connection} createClient={createClient} />
      ) : machineLacks(health, DAEMON_FEATURES.signInRules) ? (
        <UpdateNote what="Standing sign-in rules" />
      ) : null}
    </div>
  );
}

/** Catalogs live on the Sharing page now; this tab id stays so an old link still lands on a sentence that says so. */
function CatalogsPanel({ connection }: DaemonSettingsTabProps) {
  const router = useOptionalRouter();
  const to = daemonSharingPath(connection.daemonId, 'catalogs');
  return (
    <p className="m-0 text-cell text-muted" data-catalogs-moved="">
      <RouteLink
        to={to}
        {...(router === null ? {} : { onNavigate: router.navigate })}
        className="text-accent underline"
      >
        Catalogs moved to Sharing
      </RouteLink>
      . Sharing is where you make, share and read them now.
    </p>
  );
}

function DevicesPanel({ connection }: DaemonSettingsTabProps) {
  const { createPairingClient } = useFrameLive();
  const health = useDaemonHealth(connection);
  return (
    <AddDeviceSurface
      connection={connection}
      rulesOffered={machineOffers(health, DAEMON_FEATURES.signInRules)}
      {...(createPairingClient ? { createClient: createPairingClient } : {})}
    />
  );
}

function GrantsPanel({ connection }: DaemonSettingsTabProps) {
  const { createGrantClient } = useFrameLive();
  return <GrantsSurface connection={connection} {...(createGrantClient ? { createClient: createGrantClient } : {})} />;
}

function SecurityPanel({ connection }: DaemonSettingsTabProps) {
  const { name, createPasskeyClient } = useFrameLive();
  return (
    <SecuritySurface
      connection={connection}
      machineName={name}
      {...(createPasskeyClient ? { createClient: createPasskeyClient } : {})}
    />
  );
}

function CarrierPanel() {
  const { carrier, relayAdvertised, carrierPreference, connectionHealth, measureCarrierRtt, name } = useFrameLive();
  const measured = useCarrierRtt(carrier, measureCarrierRtt);
  return (
    <ActiveCarrierCard
      choice={measured}
      relayAdvertised={relayAdvertised}
      {...(carrierPreference === undefined ? {} : { preference: carrierPreference })}
      {...(connectionHealth === undefined ? {} : { health: connectionHealth })}
      machine={name}
    />
  );
}

function HostChecksPanel() {
  const { connectionRecord, probeDaemon, carrier, onRenameDaemon, onRemoveDaemon } = useFrameLive();
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
        This daemon’s browser pairing record was not supplied, so Ferretry cannot safely show reachability or offer
        pairing changes.
      </p>
    </section>
  );
}

/** The frame's own panels before the composition root's, declared once so each keeps its identity. */
const LEADING_TABS: readonly DaemonSettingsTabDefinition[] = [
  {
    id: 'warden',
    label: 'Warden',
    description: 'Supervision, AI login failover, and policy for this daemon.',
    Surface: WardenPanel,
  },
  {
    id: 'secrets',
    label: 'Secrets',
    description: 'Env vars for the programs ferrets run.',
    Surface: SecretsPanel,
  },
  {
    id: 'accounts',
    label: 'Accounts',
    description: 'Who ferrets sign in as: username, password and 2FA keys, per site.',
    Surface: AccountsPanel,
  },
  {
    id: 'secure-copy',
    label: 'Secure copy',
    description: 'Values moved without a ferret seeing them, and paste rules.',
    Surface: SecureCopyPanel,
  },
  {
    id: 'catalogs',
    label: 'Catalogs',
    description: 'Moved: catalogs are on the Sharing page now.',
    Surface: CatalogsPanel,
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
    label: 'Devices',
    description: 'Pair another phone or browser with this machine, and revoke one.',
    Surface: DevicesPanel,
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
    Surface: GrantsPanel,
  },
  {
    /**
     * Passkeys, right after the limits panel: the confirmation a refused change asks for is made
     * here, so it sits beside the panel that explains the refusal.
     */
    id: 'security',
    label: 'Security',
    description: 'The passkeys this device holds for this machine, and adding another.',
    Surface: SecurityPanel,
  },
  // A product-owned Doctor surface belongs with the daemon configuration (`additionalTabs`, next),
  // before the connection carrier and browser-local pairing diagnostics.
];

/** The frame's own panels after the composition root's. */
const TRAILING_TABS: readonly DaemonSettingsTabDefinition[] = [
  {
    id: 'carrier',
    label: 'Connection',
    description:
      'How this device reaches the daemon right now — direct, WebRTC, a Cloudflare tunnel or a relay — and which of them it may use.',
    Surface: CarrierPanel,
  },
  {
    id: 'host-checks',
    label: 'Host checks',
    description: 'Reachability and this browser’s pairing for this daemon.',
    Surface: HostChecksPanel,
  },
];

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
  /** This machine's connection preference on this device (§15), offered on the Connection panel. */
  readonly carrierPreference?: CarrierPreferenceControl | undefined;
  /** The reconnect loop's state for this daemon, so the Connection tab can say "reconnecting". */
  readonly connectionHealth?: ConnectionHealthState | undefined;
  /** This machine's peer-to-peer round trip, asked while the Connection panel shows a WebRTC carrier. */
  readonly measureCarrierRtt?: (() => Promise<number | undefined>) | undefined;
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
  carrierPreference,
  connectionHealth,
  measureCarrierRtt,
  probeDaemon,
  onRenameDaemon,
  onRemoveDaemon,
}: DaemonSettingsFrameProps) {
  const tabs = useMemo<readonly DaemonSettingsTabDefinition[]>(
    () => [...LEADING_TABS, ...additionalTabs, ...TRAILING_TABS],
    [additionalTabs],
  );
  const live = useMemo<FrameLive>(
    () => ({
      name,
      connectionRecord,
      createWardenClient,
      createSecretClient,
      otherMachines,
      createGrantClient,
      createPairingClient,
      createPasskeyClient,
      carrier,
      relayAdvertised,
      carrierPreference,
      connectionHealth,
      measureCarrierRtt,
      probeDaemon,
      onRenameDaemon,
      onRemoveDaemon,
    }),
    [
      name,
      connectionRecord,
      createWardenClient,
      createSecretClient,
      otherMachines,
      createGrantClient,
      createPairingClient,
      createPasskeyClient,
      carrier,
      relayAdvertised,
      carrierPreference,
      connectionHealth,
      measureCarrierRtt,
      probeDaemon,
      onRenameDaemon,
      onRemoveDaemon,
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
          <FrameLiveContext.Provider value={live}>
            <Surface connection={connection} />
          </FrameLiveContext.Provider>
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
