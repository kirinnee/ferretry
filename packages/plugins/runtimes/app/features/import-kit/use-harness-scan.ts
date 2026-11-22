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
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { type SetupScan, SetupScanSchema } from '../../../contract/index.ts';
import type { RuntimesClient } from '../../lib/client.ts';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';
import { HARNESSES, type ToolModel, toolModel, versionOf } from './model.ts';

const SCAN_ROUTE = 'GET /v1/runtimes/setup/scan' as const;
const UPDATE_ROUTE: Readonly<Record<HarnessKey, string>> = {
  'claude-code': 'GET /v1/claude-code/update',
  codex: 'GET /v1/codex/update',
};

export type ScanRead =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  /** The machine wants a passkey before it shows the setup; nothing asks until the person presses the button. */
  | { readonly kind: 'confirm' }
  | { readonly kind: 'failed'; readonly sentence: string }
  | {
      readonly kind: 'ready';
      readonly scan: SetupScan;
      readonly versions: Readonly<Record<HarnessKey, string | null>>;
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

/** The three reads one scan is: the setup scan and each tool's update view (a failed update view is `null`). */
interface MachineRead {
  readonly answer: unknown;
  readonly claude: unknown;
  readonly codex: unknown;
}

const readMachine = async (client: RuntimesClient, quiet: boolean): Promise<MachineRead> => {
  const [answer, claude, codex] = await Promise.all([
    client.call(SCAN_ROUTE, { quiet }),
    client.call(UPDATE_ROUTE['claude-code'], { quiet: true }).catch(() => null),
    client.call(UPDATE_ROUTE.codex, { quiet: true }).catch(() => null),
  ]);
  return { answer, claude, codex };
};

/**
 * C59 O8-4: THE SCAN READ AHEAD, started when the setup flow opens ({@link readSetupScanAhead}), so the Claude Code and
 * Codex pages find it already answered instead of each waiting on its own read. It is keyed by MACHINE, not by client or
 * run: every plugin's page talks through its own client, and each run has its own store, so one read here stands in for
 * the first read of every store on that machine, for {@link AHEAD_MS} after it started. Only a store's FIRST read takes it:
 * Check again, a read after an install or a sign-in and the Settings re-import (`refresh`) always ask the machine.
 *
 * Each flow opening reads afresh (one already in flight is shared, never doubled) and forgets its read when it closes
 * ({@link forgetSetupScanAhead}), so a flow never shows what an earlier one read. A read that FAILED is handed to exactly one page, which shows the failure and its retry as its own read would
 * have; the next store asks the machine itself.
 */
const AHEAD_MS = 10 * 60_000;
interface Ahead {
  readonly at: number;
  readonly read: Promise<MachineRead>;
  /** Set once the read settles: `ok` or `failed`. */
  settled?: 'ok' | 'failed';
}
const AHEAD = new Map<object | string, Ahead>();
const machineOf = (client: RuntimesClient): object | string => daemonOfClient(client) ?? client;

/** Start the scan for `client`'s machine now, quietly (one still in flight is shared). Never throws. */
export function readSetupScanAhead(client: RuntimesClient, nowMs: number = Date.now()): void {
  const machine = machineOf(client);
  const held = AHEAD.get(machine);
  if (held !== undefined && held.settled === undefined) return;
  const ahead: Ahead = { at: nowMs, read: readMachine(client, true) };
  AHEAD.set(machine, ahead);
  ahead.read.then(
    () => {
      ahead.settled = 'ok';
    },
    () => {
      ahead.settled = 'failed';
    },
  );
}

/** The flow that started a read ahead has closed: no later store, and no later flow, takes what it read. */
export function forgetSetupScanAhead(client: RuntimesClient): void {
  AHEAD.delete(machineOf(client));
}

/** The read started ahead for `client`'s machine, if it may still stand in for a first read (a failed one, only once). */
const aheadFor = (client: RuntimesClient, nowMs: number): Promise<MachineRead> | undefined => {
  const machine = machineOf(client);
  const held = AHEAD.get(machine);
  if (held === undefined || nowMs - held.at >= AHEAD_MS) return undefined;
  if (held.settled === 'failed') AHEAD.delete(machine);
  return held.read;
};

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
      const { answer, claude, codex } = await (started ?? readMachine(client, quiet));
      if (mine !== generation) return;
      const parsed = SetupScanSchema.safeParse(answer);
      if (!parsed.success && quiet) return set({ kind: 'confirm' });
      set({
        kind: 'ready',
        scan: SetupScanSchema.parse(answer),
        versions: { 'claude-code': versionOf(claude), codex: versionOf(codex) },
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

/**
 * One store per client and run: a client is per daemon, so another machine is another store and nothing crosses machines.
 * Only the latest run of a client is kept: asking for another `run` drops the old store, so the next page reads again.
 */
const STORES = new WeakMap<RuntimesClient, { readonly run: string; readonly store: ScanStore }>();
export const scanStoreFor = (client: RuntimesClient, run: string): ScanStore => {
  const known = STORES.get(client);
  if (known?.run === run) return known.store;
  const made = createScanStore(client);
  STORES.set(client, { run, store: made });
  return made;
};

export interface HarnessScan {
  readonly read: ScanRead;
  /** Both tools' models once the scan is read; null before. */
  readonly models: Readonly<Record<HarnessKey, ToolModel>> | null;
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
  const store = scanStoreFor(client, options.run);
  const read = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => {
    if (options.refresh === true || store.snapshot().kind === 'idle') void store.scan(true, options.refresh !== true);
  }, [store, options.refresh]);
  const models = useMemo(
    () =>
      read.kind === 'ready'
        ? (Object.fromEntries(
            HARNESSES.map(harness => [harness, toolModel(harness, read.scan, read.versions[harness])]),
          ) as Record<HarnessKey, ToolModel>)
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
