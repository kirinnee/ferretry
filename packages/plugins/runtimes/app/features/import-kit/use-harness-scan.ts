/**
 * The first-run scan (`GET /v1/runtimes/setup/scan`) and each tool's installed version, read ONCE per onboarding RUN and
 * shared by every page of that run that asks: Claude Code's pages and Codex's pages all draw from the same read, so a
 * back-step or a second page never reads the machine again. A new run (another `run` key on the same client) reads the
 * machine afresh, so neither an answer nor a failure outlives the run it was read for. `scan()` is the one way to read again (after an install or a sign-in).
 *
 * A read nobody asked for is quiet and never raises a passkey prompt; a machine that wants one is answered with `confirm`,
 * and the person's own press (`quiet: false`) may ask. Holds names only: the scan carries no value.
 */
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
  /** Read (again). `quiet` is a read nobody asked for. A ready answer stays on screen while the new one is read. */
  readonly scan: (quiet?: boolean) => Promise<void>;
}

export function createScanStore(client: RuntimesClient): ScanStore {
  let state: ScanRead = { kind: 'idle' };
  let generation = 0;
  const listeners = new Set<() => void>();
  const set = (next: ScanRead): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  const scan = async (quiet = true): Promise<void> => {
    generation += 1;
    const mine = generation;
    // No blank-out: what is already read stays until the new answer is in.
    if (state.kind !== 'ready') set({ kind: 'reading' });
    try {
      const [answer, claude, codex] = await Promise.all([
        client.call(SCAN_ROUTE, { quiet }),
        client.call(UPDATE_ROUTE['claude-code'], { quiet: true }).catch(() => null),
        client.call(UPDATE_ROUTE.codex, { quiet: true }).catch(() => null),
      ]);
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
    if (options.refresh === true || store.snapshot().kind === 'idle') void store.scan();
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
