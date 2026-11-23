/**
 * The first-run scan (`GET /v1/runtimes/setup/scan`) and each tool's installed version, read ONCE per onboarding RUN and
 * shared by every page of that run that asks: Claude Code's pages and Codex's pages all draw from the same read, so a
 * back-step or a second page never reads the machine again. A new run (another `run` key on the same client) reads the
 * machine afresh, so neither an answer nor a failure outlives the run it was read for. `scan()` is the one way to read again (after an install or a sign-in).
 *
 * A read nobody asked for is quiet and never raises a passkey prompt; a machine that wants one is answered with `confirm`,
 * and the person's own press (`quiet: false`) may ask. Holds names only: the scan carries no value.
 */
import { daemonOfClient } from '@ferretry/app';
import { isStepUpRefusal } from '@ferretry/app/ui';
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { type SetupScan, SetupScanSchema } from '../../../contract/index.ts';
import type { RuntimesClient } from '../../lib/client.ts';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';
import { HARNESSES, type ToolModel, toolModel, versionOf } from './model.ts';

const SCAN_ROUTE = 'GET /v1/runtimes/setup/scan' as const;
/** Each tool's own update view is served by its own plugin, under its key. */
const updateRoute = (harness: HarnessKey): string => `GET /v1/${harness}/update`;

export type ScanRead =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  /** The machine wants a passkey before it shows the setup; nothing asks until the person presses the button. */
  | { readonly kind: 'confirm' }
  | { readonly kind: 'failed'; readonly sentence: string }
  | {
      readonly kind: 'ready';
      readonly scan: SetupScan;
      readonly versions: Readonly<Record<string, string | null>>;
    };

export interface ScanStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => ScanRead;
  /**
   * Read (again). `quiet` is a read nobody asked for. A ready answer stays on screen while the new one is read. `ahead`: a
   * page mounting may take the read {@link readSetupScanAhead} started for this machine, on this store's first read only.
   */
  readonly scan: (quiet?: boolean, ahead?: boolean) => Promise<void>;
}

/** The reads one scan is: the setup scan and each tool's update view, by harness (a failed update view is `null`). */
interface MachineRead {
  readonly answer: unknown;
  readonly updates: Readonly<Record<string, unknown>>;
}

/** Each tool's installed version, read off its update view; a tool with no view has none. */
const versionsOf = (updates: Readonly<Record<string, unknown>>): Record<string, string | null> =>
  Object.fromEntries(HARNESSES.map(harness => [harness, versionOf(updates[harness])]));

const readMachine = async (client: RuntimesClient, quiet: boolean): Promise<MachineRead> => {
  const [answer, ...views] = await Promise.all([
    client.call(SCAN_ROUTE, { quiet }),
    ...HARNESSES.map(harness => client.call(updateRoute(harness), { quiet: true }).catch(() => null)),
  ]);
  return { answer, updates: Object.fromEntries(HARNESSES.map((harness, at) => [harness, views[at]])) };
};

/**
 * C59 O8-4: THE SCAN READ AHEAD, started when the setup flow opens ({@link readSetupScanAhead}), so the Claude Code and
 * Codex pages find it already answered instead of each waiting on its own read. It is keyed by MACHINE, not by client or
 * run: every plugin's page talks through its own client, and each run has its own store, so one read here stands in for
 * the first read of every store on that machine, for {@link AHEAD_MS} after it started. Only a store's FIRST read takes it:
 * Check again, a read after an install or a sign-in and the Settings re-import (`refresh`) always ask the machine.
 *
 * Each flow opening reads afresh and forgets its read when it closes ({@link forgetSetupScanAhead}), so a flow never shows
 * what an earlier one read. A read still IN FLIGHT when the flow closes is not dropped: it is kept (one per machine, never
 * doubled), a reopening reuses it, and it is cleared once it settles. Every opening also starts the stores of that
 * machine over, so a page of a reopened flow never shows the answer of the flow before (the Claude pages keep one fixed
 * run key). A read that FAILED is handed to exactly one page, which shows the failure and its retry as its own read would
 * have; the next store asks the machine itself.
 */
const AHEAD_MS = 10 * 60_000;
interface Ahead {
  readonly at: number;
  readonly read: Promise<MachineRead>;
  /** Set once the read settles: `ok` or `failed`. */
  settled?: 'ok' | 'failed';
  /** The flow that started it closed while it was in flight: kept for a reopening only, dropped when it settles. */
  closed?: true;
}
const AHEAD = new Map<object | string, Ahead>();
const machineOf = (client: RuntimesClient): object | string => daemonOfClient(client) ?? client;

/**
 * One store per MACHINE and run: every plugin talks through its own client, so the key is the machine (as the read ahead's
 * is), and a flow opening starts over the store every plugin's page of that machine would otherwise reuse. Another machine is
 * another store and nothing crosses machines. Only the latest run of a machine is kept: asking for another `run` drops the
 * old store, so the next page reads again.
 */
const STORES = new Map<object | string, { readonly run: string; readonly store: ScanStore }>();

/**
 * Start the scan for `client`'s machine now, quietly. A read still in flight is shared, never doubled: that includes one
 * the previous flow left when it closed. A flow opening (anything but a read of the flow still open) starts the machine's
 * stores over, so no page shows an earlier flow's answer. Never throws.
 */
export function readSetupScanAhead(client: RuntimesClient, nowMs: number = Date.now()): void {
  const machine = machineOf(client);
  const held = AHEAD.get(machine);
  if (held === undefined || held.closed === true || held.settled !== undefined) STORES.delete(machine);
  if (held !== undefined && held.settled === undefined) {
    delete held.closed;
    return;
  }
  const ahead: Ahead = { at: nowMs, read: readMachine(client, true) };
  AHEAD.set(machine, ahead);
  const settle = (outcome: 'ok' | 'failed'): void => {
    ahead.settled = outcome;
    // Its flow closed while it was in flight and nobody reopened: nothing may take it now.
    if (ahead.closed === true && AHEAD.get(machine) === ahead) AHEAD.delete(machine);
  };
  ahead.read.then(
    () => settle('ok'),
    () => settle('failed'),
  );
}

/**
 * The flow that started a read ahead has closed: no later store, and no later flow, takes what it read. A read still in
 * flight is kept (a reopening reuses it, one scan call) and cleared when it settles.
 */
export function forgetSetupScanAhead(client: RuntimesClient): void {
  const machine = machineOf(client);
  const held = AHEAD.get(machine);
  if (held === undefined) return;
  if (held.settled === undefined) held.closed = true;
  else AHEAD.delete(machine);
}

/** The read started ahead for `client`'s machine, if it may still stand in for a first read (a failed one, only once). */
const aheadFor = (client: RuntimesClient, nowMs: number): Promise<MachineRead> | undefined => {
  const machine = machineOf(client);
  const held = AHEAD.get(machine);
  if (held === undefined || held.closed === true || nowMs - held.at >= AHEAD_MS) return undefined;
  if (held.settled === 'failed') AHEAD.delete(machine);
  return held.read;
};

/**
 * The read started ahead for `client`'s machine, LOOKED AT and never taken: a failed read stays for the one page that is to show
 * its failure, and nothing here starts, replaces or consumes a read. `undefined` when no flow holds one that may still stand.
 */
const peekAhead = (client: RuntimesClient, nowMs: number): Promise<MachineRead> | undefined => {
  const held = AHEAD.get(machineOf(client));
  if (held === undefined || held.closed === true || nowMs - held.at >= AHEAD_MS) return undefined;
  return held.read;
};

/** The tools' models of one machine read, or null when the scan did not answer (a refusal, or a passkey it wants). */
const modelsOf = (read: MachineRead): Readonly<Record<string, ToolModel>> | null => {
  const parsed = SetupScanSchema.safeParse(read.answer);
  if (!parsed.success) return null;
  const versions = versionsOf(read.updates);
  return Object.fromEntries(
    HARNESSES.map(harness => [harness, toolModel(harness, parsed.data, versions[harness] ?? null)]),
  );
};

/**
 * The models the setup flow's own read ahead found, for a page that only NOTES what the machine holds (the AI picker's "Found
 * on this computer"). It reads ONLY that read, a failure included (null: no note), never asks the machine itself and never
 * touches the machine's scan store, so another page that reads the scan (the Settings import) is not disturbed and the note
 * costs no extra scan, however often the page is drawn again. Null while the read is out, and when no flow holds one.
 */
export function useScanAhead(client: RuntimesClient): Readonly<Record<string, ToolModel>> | null {
  const [models, setModels] = useState<Readonly<Record<string, ToolModel>> | null>(null);
  useEffect(() => {
    let live = true;
    const ahead = peekAhead(client, Date.now());
    if (ahead === undefined) {
      setModels(null);
      return;
    }
    ahead.then(
      read => live && setModels(modelsOf(read)),
      () => live && setModels(null),
    );
    return () => {
      live = false;
    };
  }, [client]);
  return models;
}

export function createScanStore(client: RuntimesClient): ScanStore {
  let state: ScanRead = { kind: 'idle' };
  let generation = 0;
  const listeners = new Set<() => void>();
  const set = (next: ScanRead): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  const scan = async (quiet = true, ahead = false): Promise<void> => {
    generation += 1;
    const mine = generation;
    // Only a store's first read, asked by a page mounting (never a press or a refresh), may take the read started ahead.
    const started = ahead && quiet && state.kind === 'idle' ? aheadFor(client, Date.now()) : undefined;
    // No blank-out: what is already read stays until the new answer is in.
    if (state.kind !== 'ready') set({ kind: 'reading' });
    try {
      // The read ahead IS this store's first read: its answer, or its failure (shown with the retry), never a second call.
      const { answer, updates } = await (started ?? readMachine(client, quiet));
      if (mine !== generation) return;
      const parsed = SetupScanSchema.safeParse(answer);
      if (!parsed.success && quiet) return set({ kind: 'confirm' });
      set({
        kind: 'ready',
        scan: SetupScanSchema.parse(answer),
        versions: versionsOf(updates),
      });
    } catch (error) {
      if (mine !== generation) return;
      if (quiet && isStepUpRefusal(error)) set({ kind: 'confirm' });
      else set({ kind: 'failed', sentence: changeRefusalSentence(error) });
    }
  };
  return {
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => state,
    scan,
  };
}

export const scanStoreFor = (client: RuntimesClient, run: string): ScanStore => {
  const known = STORES.get(machineOf(client));
  if (known?.run === run) return known.store;
  const made = createScanStore(client);
  STORES.set(machineOf(client), { run, store: made });
  return made;
};

export interface HarnessScan {
  readonly read: ScanRead;
  /** Both tools' models once the scan is read; null before. */
  readonly models: Readonly<Record<string, ToolModel>> | null;
  /** The person's own press: may ask for the passkey. */
  readonly look: () => Promise<void>;
  /** Read again quietly (after an install or a sign-in that is not a press). */
  readonly rescan: (quiet?: boolean) => Promise<void>;
}

/**
 * The shared scan of one run. `run` names the onboarding run (or the Settings re-import) the pages belong to. `refresh`
 * reads again when the hook mounts even if a read exists (the Settings re-import wants the machine as it is now); the
 * default reads only when nothing has been read yet in this run.
 */
export function useScan(
  client: RuntimesClient,
  options: { readonly run: string; readonly refresh?: boolean },
): HarnessScan {
  // A page drawn in advance (hidden, no effects) must never evict the live run's store: the render only LOOKS the run's store
  // up and falls back to its own, and the run's store is registered by the page's effect, which a hidden page never runs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another run of the same page is another store
  const own = useMemo(() => createScanStore(client), [client, options.run]);
  const machine = machineOf(client);
  const known = STORES.get(machine);
  const store = known?.run === options.run ? known.store : own;
  const read = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => {
    if (STORES.get(machine)?.run !== options.run) STORES.set(machine, { run: options.run, store });
    if (options.refresh === true || store.snapshot().kind === 'idle') void store.scan(true, options.refresh !== true);
  }, [machine, store, options.run, options.refresh]);
  const models = useMemo(
    () =>
      read.kind === 'ready'
        ? Object.fromEntries(
            HARNESSES.map(harness => [harness, toolModel(harness, read.scan, read.versions[harness] ?? null)]),
          )
        : null,
    [read],
  );
  return { read, models, look: () => store.scan(false), rescan: store.scan };
}

/** One tool's page: the shared scan of this `run` and that tool's model (null until read). */
export function useHarnessScan(
  client: RuntimesClient,
  harness: HarnessKey,
  run: string,
): HarnessScan & { readonly model: ToolModel | null } {
  const shared = useScan(client, { run });
  return { ...shared, model: shared.models?.[harness] ?? null };
}
