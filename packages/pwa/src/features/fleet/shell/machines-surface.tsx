/**
 * The Machines surface: one Settings section for the account model (docs/design/account-model.md §4.2).
 *
 * A **switcher** at the top names the machine with a caret. It opens **Machines** — every paired
 * daemon with Online/Offline, its runtime count or "Not set up yet", and **Add machine** (the existing
 * pairing flow). Under it sit the five tabs: Runtimes, Credentials, Profiles, Components, Settings.
 *
 * The shell owns the frame and nothing inside a tab. Each tab's surface is supplied by the composition
 * root (`machineTabs`), and until a unit fills one the tab is an honest empty frame — routable, so a
 * link to it works today, but saying it shows nothing yet. It is the ONE Settings entry for the account model (O1).
 *
 * Which daemon answers is the page's, never this surface's: picking another machine asks the page to
 * go to that daemon's Settings, so no read for one host can be shown under another host's name.
 */

import type { FleetMachineView } from '@ferretry/protocol';
import { Boxes, ChevronDown, ChevronRight, KeyRound, Layers, Play, Plus, SlidersHorizontal } from 'lucide-react';
import { type ComponentType, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import type { DaemonConnection, DaemonId } from '../../../lib/daemon-connection.ts';
import { Badge, Button } from '../../../shell/primitives.tsx';
import { daemonDisplayName } from '../../settings/daemon-settings.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { AccountStatus } from './account-status.tsx';
import { type MachineReach, machineReachSummary, readMachineReach } from './machine-reach.ts';
import { MACHINE_TABS, type MachineTabId } from './machine-route.ts';

/** What every tab surface is handed: the machine, whether it answers, and the way to ask it things. */
export interface MachineTabProps {
  readonly connection: DaemonConnection;
  /** The name the switcher shows. */
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
}

export type MachineTabSurfaces = Readonly<Partial<Record<MachineTabId, ComponentType<MachineTabProps>>>>;

/** One glyph per tab, from the set the rest of Settings draws from. */
const TAB_ICONS: Readonly<Record<MachineTabId, ReactNode>> = {
  runtimes: <Play size={16} aria-hidden="true" />,
  credentials: <KeyRound size={16} aria-hidden="true" />,
  profiles: <Layers size={16} aria-hidden="true" />,
  components: <Boxes size={16} aria-hidden="true" />,
  settings: <SlidersHorizontal size={16} aria-hidden="true" />,
};

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

const reachWord = (reach: MachineReach) =>
  reach.kind === 'checking' ? 'checking' : reach.kind === 'offline' ? 'needs_sign_in' : 'ready';

const reachLabel = (reach: MachineReach): string =>
  reach.kind === 'checking' ? 'Checking' : reach.kind === 'offline' ? 'Offline' : 'Online';

export interface MachinesSurfaceProps {
  /** The daemon this Settings page is for. */
  readonly daemonId: DaemonId;
  readonly connections: readonly DaemonConnectionRecord[];
  readonly tab: MachineTabId;
  /** A link named a machine this browser has not paired, so the page fell back to this one. */
  readonly unknownMachine?: string;
  /** Go to a machine's tab. The page turns this into an address. */
  readonly onOpen: (daemonId: DaemonId, tab: MachineTabId) => void;
  /** The existing pairing flow. */
  readonly onAddMachine: () => void;
  readonly createClient: FleetClientFactory;
  readonly tabs?: MachineTabSurfaces;
}

export function MachinesSurface({
  daemonId,
  connections,
  tab,
  unknownMachine,
  onOpen,
  onAddMachine,
  createClient,
  tabs = {},
}: MachinesSurfaceProps) {
  const [reach, setReach] = useState<ReadonlyMap<DaemonId, MachineReach>>(new Map());
  const [listing, setListing] = useState(false);
  const record = connections.find(candidate => candidate.daemonId === daemonId);

  const check = useCallback(
    (connection: DaemonConnectionRecord): void => {
      setReach(current => new Map(current).set(connection.daemonId, { kind: 'checking' }));
      void readMachineReach(() => createClient(connection)).then(next =>
        setReach(current => new Map(current).set(connection.daemonId, next)),
      );
    },
    [createClient],
  );

  // Keyed by the daemon, not by the record object: a new connections array with the same pairing must
  // not start a second read of a machine that is already being asked.
  const latest = useRef(connections);
  latest.current = connections;
  useEffect(() => {
    const pairing = latest.current.find(candidate => candidate.daemonId === daemonId);
    if (pairing) check(pairing);
  }, [check, daemonId]);

  if (record === undefined)
    return (
      <p className="m-0 text-ui leading-base text-warn" role="alert">
        This machine is not paired with this browser, so its setup cannot be shown.
      </p>
    );

  const name = daemonDisplayName(record);
  const current = reach.get(daemonId) ?? { kind: 'checking' };
  const machine = current.kind === 'online' ? current.machine : null;
  const Surface = tabs[tab];

  const openList = (): void => {
    setListing(true);
    for (const connection of connections) if (connection.daemonId !== daemonId) check(connection);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-machines-surface={String(daemonId)}>
      <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {listing ? (
          <span className="inline-flex min-h-control min-w-0 items-center gap-2 text-row font-semibold text-fg">
            <AccountStatus word={reachWord(current)} label={reachLabel(current)} />
            <span className="min-w-0 truncate">{name}</span>
          </span>
        ) : (
          <button
            type="button"
            data-machine-switcher=""
            aria-label={`Machine: ${name}. Switch machine`}
            onClick={openList}
            className="inline-flex min-h-control min-w-0 max-w-full items-center gap-2 rounded-control text-row font-semibold text-fg transition-colors hover:text-accent"
          >
            <AccountStatus word={reachWord(current)} label={reachLabel(current)} />
            <span className="min-w-0 truncate">{name}</span>
            <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-muted" />
          </button>
        )}
        <span className="text-meta text-muted">{listing ? 'All machines' : reachLabel(current)}</span>
      </header>

      {unknownMachine === undefined ? null : (
        <p className="m-0 text-cell leading-base text-warn" role="status" data-machine-unknown="">
          No paired machine is called {unknownMachine}, so this shows {name}.
        </p>
      )}

      {listing ? (
        <section aria-labelledby="machines-list-heading" data-machines-list="">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h3 id="machines-list-heading" className="m-0 font-display text-title font-semibold tracking-display">
              Machines
            </h3>
            <Button type="button" variant="ghost" size="sm" onClick={() => setListing(false)}>
              Close
            </Button>
          </div>
          <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
            {connections.map(connection => {
              const state = reach.get(connection.daemonId) ?? { kind: 'checking' };
              const here = connection.daemonId === daemonId;
              return (
                <li key={connection.daemonId}>
                  <button
                    type="button"
                    data-machine-choice={String(connection.daemonId)}
                    aria-current={here ? 'true' : undefined}
                    onClick={() => {
                      setListing(false);
                      if (!here) onOpen(connection.daemonId, 'runtimes');
                    }}
                    className="kt-panel flex min-h-control w-full min-w-0 items-center gap-3 p-panel text-left transition-colors hover:border-accent"
                  >
                    <AccountStatus word={reachWord(state)} label={reachLabel(state)} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-row font-semibold text-fg">{daemonDisplayName(connection)}</span>
                      <span className="text-cell text-muted">{machineReachSummary(state)}</span>
                    </span>
                    {here ? (
                      <Badge tone="accent">Current</Badge>
                    ) : (
                      <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
                    )}
                  </button>
                </li>
              );
            })}
            <li>
              <button
                type="button"
                data-machine-add=""
                onClick={onAddMachine}
                className="kt-panel flex min-h-control w-full min-w-0 items-center gap-3 p-panel text-left text-row font-semibold text-fg transition-colors hover:border-accent"
              >
                <Plus size={16} aria-hidden="true" className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1">Add machine</span>
                <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
              </button>
            </li>
          </ul>
          <p className="mb-0 mt-2 text-cell leading-base text-muted">
            Each machine keeps its own credentials, components, profiles and runtimes.
          </p>
        </section>
      ) : (
        <>
          <nav aria-label={`${name} tabs`} data-machine-tabs="">
            {/* EQUAL COLUMNS THAT NEVER CUT A WORD. Every cell grows from the same zero basis but never below its
                own label, so at the default size five labels fit a 390px phone side by side, and at a larger
                text size or a wider theme the ROW scrolls inside itself — never the page, and never as "Creden…". */}
            <ul className="scroll-thin m-0 flex list-none gap-xs overflow-x-auto p-0 md:gap-sm">
              {MACHINE_TABS.map(definition => {
                const selected = definition.id === tab;
                return (
                  <li key={definition.id} className="flex-1">
                    <button
                      type="button"
                      data-machine-tab={definition.id}
                      aria-current={selected ? 'page' : undefined}
                      onClick={() => onOpen(daemonId, definition.id)}
                      className={cn(
                        'flex min-h-control w-full flex-col items-center justify-center gap-xs rounded-control border whitespace-nowrap px-xs py-xs text-2xs md:px-control-x transition-colors md:flex-row md:gap-sm md:text-ui',
                        selected
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-border bg-surface-2 text-fg [@media(hover:hover)]:hover:bg-surface-3',
                      )}
                    >
                      {TAB_ICONS[definition.id]}
                      <span>{definition.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {current.kind === 'offline' ? (
            <div role="status" className="kt-panel p-panel" data-machine-offline="">
              <p className="m-0 text-row font-semibold text-fg">{name} is asleep or offline</p>
              <p className="mb-0 mt-1 text-cell leading-base text-muted">
                You’re seeing what Ferretry last saw. A change needs {name} awake.
              </p>
              <div className="mt-3">
                <Button type="button" size="sm" data-machine-retry="" onClick={() => check(record)}>
                  Check again
                </Button>
              </div>
            </div>
          ) : current.kind === 'unreadable' ? (
            <p role="status" className="m-0 text-cell leading-base text-warn" data-machine-unreadable="">
              {current.reason}
            </p>
          ) : null}

          <div data-machine-tab-panel={tab} className="min-w-0">
            {Surface ? (
              <Surface
                connection={record}
                machineName={name}
                machine={machine}
                online={current.kind !== 'offline'}
                checking={current.kind === 'checking'}
                onRetry={() => check(record)}
                createClient={createClient}
              />
            ) : (
              <EmptyMachineTab tab={tab} machineName={name} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
