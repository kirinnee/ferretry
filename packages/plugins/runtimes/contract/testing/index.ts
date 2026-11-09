/**
 * @ferretry/plugin-runtimes/contract/testing — the fake and the conformance suite (§7.8). The real implementation and
 * the fake pass the same suite.
 */
import { err, ok, type Result } from '@ferretry/std';
import {
  type ProfileLayerChange,
  type ProfileSummary,
  type ResolveResult,
  type RuntimeHome,
  type RuntimeHomeReader,
  type RuntimeId,
  type RuntimeLayers,
  RuntimeIdSchema,
  type RuntimesApi,
  type RuntimeSummary,
  RuntimeSummarySchema,
} from '../index.ts';

export interface FakeRuntimes extends RuntimesApi {
  setRuntimes(runtimes: readonly RuntimeSummary[], defaultRuntime?: RuntimeId): void;
  /** The homes `homes()` answers, and the reader `home(id)` hands out for each id (an id with no reader gets none). */
  setHomes(homes: readonly RuntimeHome[], readers?: Readonly<Record<string, RuntimeHomeReader>>): void;
  /** The profiles `profiles()` answers, and the layers `layers(id)` answers for each runtime. */
  setProfiles(profiles: readonly ProfileSummary[], layers?: readonly RuntimeLayers[]): void;
  /** Every `changeProfileLayers` call, in order. The fake writes nothing. */
  readonly changes: readonly ProfileLayerChange[];
}

/** An in-memory Runtimes: the machine's runtimes are whatever the test set. */
export function fakeRuntimes(): FakeRuntimes {
  let runtimes: readonly RuntimeSummary[] = [];
  let defaultRuntime: RuntimeId | undefined;
  let homes: readonly RuntimeHome[] = [];
  let readers: Readonly<Record<string, RuntimeHomeReader>> = {};
  let profiles: readonly ProfileSummary[] = [];
  let layerSets: ReadonlyMap<RuntimeId, RuntimeLayers> = new Map();
  const changes: ProfileLayerChange[] = [];
  const get = async (id: RuntimeId): Promise<RuntimeSummary | undefined> => runtimes.find(runtime => runtime.id === id);
  return {
    list: async () => runtimes,
    get,
    default: async () => defaultRuntime,
    resolve: async (id): Promise<ResolveResult> => {
      const wanted = id ?? defaultRuntime;
      const found = wanted === undefined ? undefined : await get(wanted);
      if (found === undefined) return { ok: false, refusal: 'unknown', sentence: 'There is no such runtime.' };
      if (found.disabled !== undefined)
        return { ok: false, refusal: 'disabled', sentence: `${found.id} is switched off.` };
      if (!found.launch.available) return { ok: false, refusal: 'not_signed_in', sentence: found.launch.reason };
      return { ok: true, runtime: found };
    },
    // No fleet is published in memory: there are no homes until a test sets them, and a reader only for a listed id.
    homes: async () => homes,
    home: id => (homes.some(home => home.id === id) ? readers[id] : undefined),
    profiles: async () => profiles,
    layers: async id => layerSets.get(id),
    changeProfileLayers: async change => {
      changes.push(change);
      return { kind: 'written', profiles: change.kind === 'add' ? [change.profile] : [] };
    },
    setRuntimes: (next, nextDefault) => {
      runtimes = next;
      defaultRuntime = nextDefault;
    },
    setHomes: (next, nextReaders = {}) => {
      homes = next;
      readers = nextReaders;
    },
    setProfiles: (next, nextLayers = []) => {
      profiles = next;
      layerSets = new Map(nextLayers.map(set => [set.runtime, set]));
    },
    get changes() {
      return changes;
    },
  };
}

/** What every implementation of `RuntimesApi` must satisfy. Failures come back as sentences so any runner can report them. */
export async function runtimesConformance(make: () => RuntimesApi): Promise<Result<true, readonly string[]>> {
  const failures: string[] = [];
  const api = make();
  for (const runtime of await api.list()) {
    if (!RuntimeSummarySchema.safeParse(runtime).success) failures.push(`list() returns summaries (${runtime.id})`);
  }
  const unknown = await api.resolve(RuntimeIdSchema.parse('no-such-runtime'));
  if (unknown.ok) failures.push('resolve() refuses an unknown runtime');
  else if (unknown.refusal !== 'unknown') failures.push('resolve() names an unknown runtime "unknown"');
  const chosen = await api.default();
  if (chosen !== undefined && (await api.get(chosen)) === undefined)
    failures.push('default() names a runtime that exists');
  // The homes: each id once, and a reader only for an id `homes()` lists.
  const homes = await api.homes();
  if (new Set(homes.map(home => home.id)).size !== homes.length) failures.push('homes() lists each id once');
  if (api.home('no-such-home') !== undefined) failures.push('home() is undefined for an id homes() does not list');
  // The layers: each profile once, and nothing for a runtime that does not exist.
  const profiles = await api.profiles();
  if (new Set(profiles.map(profile => profile.name)).size !== profiles.length)
    failures.push('profiles() lists each name once');
  if ((await api.layers(RuntimeIdSchema.parse('no-such-runtime'))) !== undefined)
    failures.push('layers() is undefined for a runtime that does not exist');
  return failures.length === 0 ? ok(true) : err(failures);
}
