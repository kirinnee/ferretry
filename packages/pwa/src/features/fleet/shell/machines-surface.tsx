/**
 * One machine in Settings: its name and status, then its five views as underlined tabs —
 * Runtimes, Credentials, Profiles, Components and Machine (docs/design/account-model.md §4.2).
 *
 * WHICH machine is open is chosen one level up: the Settings sidebar on a desktop and the Machines card
 * on a phone both list every paired machine with its status. This surface used to carry its own
 * switcher too, which was a fourth kind of navigation on one screen.
 *
 * The shell owns the frame and nothing inside a tab. Each tab's surface is supplied by the composition
 * root (`machineTabs`), and until a unit fills one the tab is an honest empty frame — routable, so a
 * link to it works today, but saying it shows nothing yet.
 *
 * Which daemon answers is the page's, never this surface's: picking another tab asks the page to move
 * the address, so no read for one host can be shown under another host's name.
 */

import type { FleetMachineView } from '@ferretry/protocol';
import { Boxes, KeyRound, Layers, Play, SlidersHorizontal } from 'lucide-react';
import { type ComponentType, type ReactNode, useEffect, useRef } from 'react';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import type { DaemonConnection, DaemonId } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import { UnderlineTabs } from '../../../shell/underline-tabs.tsx';
import { distinctDaemonName } from '../../settings/daemon-settings.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { AccountStatus } from './account-status.tsx';
import { reachLabel, reachWord, type ShownReach, shownReachSummary } from './machine-reach.ts';
import { MACHINE_TABS, type MachineTabId } from './machine-route.ts';

/**
 * The paired daemon's own panels — Warden, Secrets, devices, security and the rest — drawn inside the
 * Machine tab. `panel` is the one the address opens, or `undefined` for the list of them.
 */
export type DaemonPanelsRenderer = (panel: string | undefined, onOpen: (panel: string | null) => void) => ReactNode;

/** What every tab surface is handed: the machine, whether it answers, and the way to ask it things. */
export interface MachineTabProps {
  readonly connection: DaemonConnection;
  /** The name the machine is listed by. */
  readonly machineName: string;
  /** `null` until the machine has answered with its setup. */
  readonly machine: FleetMachineView | null;
  /** `false` while it is asleep or offline: show what was last seen, and queue no change (O5). */
  readonly online: boolean;
  /** A reachability check is running. */
  readonly checking: boolean;
  /** Check the machine again. */
  readonly onRetry: () => void;
  /** Through the app's client pool, so every call rides the measured carrier. */
  readonly createClient: FleetClientFactory;
  /** The daemon's connection and security panels, for the Machine tab. */
  readonly daemonPanels?: DaemonPanelsRenderer;
}

export type MachineTabSurfaces = Readonly<Partial<Record<MachineTabId, ComponentType<MachineTabProps>>>>;

/** One glyph per tab, from the set the rest of Settings draws from. */
const TAB_ICONS: Readonly<Record<MachineTabId, ReactNode>> = {
  runtimes: <Play size={15} aria-hidden="true" />,
  credentials: <KeyRound size={15} aria-hidden="true" />,
  profiles: <Layers size={15} aria-hidden="true" />,
  components: <Boxes size={15} aria-hidden="true" />,
  machine: <SlidersHorizontal size={15} aria-hidden="true" />,
};

const TAB_ITEMS = MACHINE_TABS.map(definition => ({
  id: definition.id,
  label: definition.label,
  icon: TAB_ICONS[definition.id],
}));

/** A tab no unit has filled yet. Routable, and honest that it shows nothing. */
export function EmptyMachineTab({ tab, machineName }: { readonly tab: MachineTabId; readonly machineName: string }) {
  const definition = MACHINE_TABS.find(candidate => candidate.id === tab) ?? MACHINE_TABS[0];
  return (
    <section className="kt-panel p-panel" data-machine-tab-empty={tab} aria-labelledby={`machine-tab-${tab}-heading`}>
      <h3 id={`machine-tab-${tab}-heading`} className="m-0 text-row font-semibold text-fg">
        {definition.label}
      </h3>
      <p className="mb-0 mt-1 text-cell leading-base text-muted">{definition.description}</p>
      <p className="mb-0 mt-3 text-cell leading-base text-muted">Nothing is shown here yet for {machineName}.</p>
    </section>
  );
}

/**
 * The empty frame as a tab surface, for the composition root's `machineTabs` map: one line per tab,
 * which the unit that fills the tab replaces with its own surface.
 */
export const emptyMachineTab = (tab: MachineTabId): ComponentType<MachineTabProps> =>
  function EmptyTabSurface({ machineName }: MachineTabProps) {
    return <EmptyMachineTab tab={tab} machineName={machineName} />;
  };

export interface MachinesSurfaceProps {
  /** The daemon this Settings page is for. */
  readonly daemonId: DaemonId;
  readonly connections: readonly DaemonConnectionRecord[];
  readonly tab: MachineTabId;
  /** What the page's reach read says about this machine. */
  readonly reach: ShownReach;
  /** Ask this machine again. */
  readonly onRetry: () => void;
  /** A link named a machine this browser has not paired, so the page fell back to this one. */
  readonly unknownMachine?: string;
  /** Go to a machine's tab. The page turns this into an address. */
  readonly onOpen: (daemonId: DaemonId, tab: MachineTabId) => void;
  /**
   * Open this machine's first run. Called by itself, once per visit, the first time the machine answers
   * that it is not set up — so nobody has to hunt for a button (docs/design/account-model.md §4.3).
   */
  readonly onSetUp?: (daemonId: DaemonId) => void;
  readonly createClient: FleetClientFactory;
  readonly tabs?: MachineTabSurfaces;
  readonly daemonPanels?: DaemonPanelsRenderer;
}

export function MachinesSurface({
  daemonId,
  connections,
  tab,
  reach,
  onRetry,
  unknownMachine,
  onOpen,
  onSetUp,
  createClient,
  tabs = {},
  daemonPanels,
}: MachinesSurfaceProps) {
  const record = connections.find(candidate => candidate.daemonId === daemonId);

  // A machine that is not set up opens its first run by itself — ONCE per visit, so leaving the flow, or
  // finishing it with nothing chosen, lands on the tabs instead of going round again. Landing on
  // Machines again later offers it again.
  const offered = useRef(false);
  const notSetUp = reach.kind === 'online' && reach.machine.setUp === false;
  useEffect(() => {
    if (!notSetUp || offered.current || onSetUp === undefined) return;
    offered.current = true;
    onSetUp(daemonId);
  }, [daemonId, notSetUp, onSetUp]);

  if (record === undefined)
    return (
      <p className="m-0 text-ui leading-base text-warn" role="alert">
        This machine is not paired with this browser, so its setup cannot be shown.
      </p>
    );

  const name = distinctDaemonName(record, connections);
  const machine = reach.kind === 'online' ? reach.machine : null;
  const Surface = tabs[tab];

  return (
    <div className="flex min-w-0 flex-col gap-3" data-machines-surface={String(daemonId)}>
      <header className="flex min-w-0 flex-col gap-0.5" data-machine-header="">
        <h2
          id="settings-machine-heading"
          className="m-0 min-w-0 [overflow-wrap:anywhere] font-display text-title font-bold tracking-display text-fg"
        >
          {name}
        </h2>
        <span className="inline-flex min-w-0 items-center gap-2 text-cell text-muted" data-machine-status={reach.kind}>
          <AccountStatus word={reachWord(reach)} label={reachLabel(reach)} />
          <span className="min-w-0 truncate">{shownReachSummary(reach)}</span>
        </span>
      </header>

      {unknownMachine === undefined ? null : (
        <p className="m-0 text-cell leading-base text-warn" role="status" data-machine-unknown="">
          No paired machine is called {unknownMachine}, so this shows {name}.
        </p>
      )}

      <UnderlineTabs
        tabs={TAB_ITEMS}
        current={tab}
        onSelect={next => onOpen(daemonId, next)}
        label={`${name} views`}
        marker="data-machine-tab"
      />

      {reach.kind === 'offline' ? (
        <div role="status" className="kt-panel p-panel" data-machine-offline="">
          <p className="m-0 text-row font-semibold text-fg">{name} is asleep or offline</p>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">
            You’re seeing what Ferretry last saw. A change needs {name} awake.
          </p>
          <div className="mt-3">
            <Button type="button" data-machine-retry="" onClick={onRetry}>
              Check again
            </Button>
          </div>
        </div>
      ) : reach.kind === 'unreadable' ? (
        <p role="status" className="m-0 text-cell leading-base text-warn" data-machine-unreadable="">
          {reach.reason}
        </p>
      ) : null}

      <div data-machine-tab-panel={tab} className="min-w-0">
        {Surface ? (
          <Surface
            connection={record}
            machineName={name}
            machine={machine}
            online={reach.kind !== 'offline'}
            checking={reach.kind === 'checking'}
            onRetry={onRetry}
            createClient={createClient}
            {...(daemonPanels === undefined ? {} : { daemonPanels })}
          />
        ) : (
          <EmptyMachineTab tab={tab} machineName={name} />
        )}
      </div>
    </div>
  );
}
