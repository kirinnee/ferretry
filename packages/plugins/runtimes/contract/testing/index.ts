/**
 * @ferretry/plugin-runtimes/contract/testing — the fake and the conformance suite (§7.8). The real implementation and
 * the fake pass the same suite.
 */
import { type CallerGovernance, cap } from '@ferretry/core-gate/contract';
import { err, ok, type Result } from '@ferretry/std';
import {
  layerNameRefusal,
  type ProfileLayerChange,
  type ProfileLayerOutcome,
  type ProfileSummary,
  type ResolveResult,
  type RuntimeAssetSkills,
  type RuntimeHome,
  type MachineTool,
  type RuntimeCheckEnvironment,
  type RuntimeHomeReader,
  type RuntimeView,
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
  /** The fleet's installed skills `assetSkills()` answers (none until set). */
  setAssetSkills(assetSkills: RuntimeAssetSkills): void;
  /** The runtimes and tools `catalog()` and `tools()` answer (none until set). */
  setCatalog(runtimes: readonly RuntimeView[], tools?: readonly MachineTool[]): void;
  /** What `checkEnvironment(runtime)` answers for a runtime (nothing for any other). */
  setCheckEnvironment(runtime: RuntimeId, environment: RuntimeCheckEnvironment): void;
  /**
   * The profiles the fake holds (what `profiles()` answers and `changeProfileLayers` edits), and the layers `layers(id)`
   * answers for each runtime. The layers are exactly what a test sets: a change edits the PROFILES, not these.
   */
  setProfiles(profiles: readonly ProfileSummary[], layers?: readonly RuntimeLayers[]): void;
  /**
   * What `changeProfileLayers` answers instead of editing a profile, once the caller and the layer name have been
   * judged exactly as the real act judges them: a fixed outcome, a function of the change (`undefined` falls back to
   * the faithful edit), or `undefined` to clear it. It is how a test drives `held`, which no profile edit of the real
   * act can produce today, or a `refused` that a write failure would give.
   */
  setChangeOutcome(
    outcome: ProfileLayerOutcome | ((change: ProfileLayerChange) => ProfileLayerOutcome | undefined) | undefined,
  ): void;
  /** Every `changeProfileLayers` call, in order (refused ones too). */
  readonly changes: readonly ProfileLayerChange[];
}

const refused = (sentence: string, code: 'fleet_change_unknown' | 'fleet_change_refused' = 'fleet_change_refused') =>
  ({ kind: 'refused', code, sentence }) as const satisfies ProfileLayerOutcome;

/**
 * The standing a caller of `changeProfileLayers` carries, or `undefined` when it carries none (the value is not a
 * governance). The sentences below are the real act's, word for word; the shared case table in the Runtimes unit tests
 * runs the fake and the real service on the same cases so the two cannot drift.
 */
function standingOf(value: unknown): CallerGovernance | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { readonly governed?: unknown; readonly decide?: unknown };
  return typeof candidate.decide === 'function' && typeof candidate.governed === 'boolean'
    ? (value as CallerGovernance)
    : undefined;
}

/** Why this caller may not change the fleet's profile `path`, in the real act's words; `undefined` when it may. */
function callerRefusal(governance: unknown, path: string): string | undefined {
  const standing = standingOf(governance);
  if (standing === undefined) return 'this daemon cannot say whether this caller may change the fleet';
  try {
    for (const [decision, what] of [
      [standing.decide(cap('fleet', 'configure')), 'change'],
      [standing.decide(cap('fleet', 'use')), 'read'],
    ] as const) {
      if (decision.allowed) continue;
      if (decision.refusal === 'step-up-required')
        return `changing ${path} from this device needs a passkey confirmation`;
      return `this device may not ${what} ${path}`;
    }
  } catch {
    return 'this daemon cannot say whether this caller may change the fleet';
  }
  return undefined;
}

/** An in-memory Runtimes: the machine's runtimes are whatever the test set. */
export function fakeRuntimes(): FakeRuntimes {
  let runtimes: readonly RuntimeSummary[] = [];
  let defaultRuntime: RuntimeId | undefined;
  let homes: readonly RuntimeHome[] = [];
  let readers: Readonly<Record<string, RuntimeHomeReader>> = {};
  let assetSkills: RuntimeAssetSkills = { skills: async () => [], skillManifest: async () => undefined };
  const checkEnvironments = new Map<string, RuntimeCheckEnvironment>();
  let catalogRuntimes: readonly RuntimeView[] = [];
  let catalogTools: readonly MachineTool[] = [];
  let profiles: readonly ProfileSummary[] = [];
  let layerSets: ReadonlyMap<RuntimeId, RuntimeLayers> = new Map();
  let forced: Parameters<FakeRuntimes['setChangeOutcome']>[0];
  let revision = 0;
  const changes: ProfileLayerChange[] = [];
  /** A profile as the fake keeps it after an edit: its layers changed and a new etag, as a real file's would be. */
  const edited = (profile: ProfileSummary, layers: readonly string[]): ProfileSummary => {
    revision += 1;
    return { name: profile.name, layers, etag: `fake-etag-${String(revision)}` };
  };
  const byName = (): readonly ProfileSummary[] =>
    profiles.toSorted((left, right) => left.name.localeCompare(right.name));
  /** The real act's answer to a change that passed the caller and the name checks, over the profiles held here. */
  const apply = (change: ProfileLayerChange): ProfileLayerOutcome => {
    if (change.kind === 'add') {
      const profile = profiles.find(candidate => candidate.name === change.profile);
      if (profile === undefined) return refused(`profile ${change.profile} does not exist`, 'fleet_change_unknown');
      const stale = change.ifMatch !== undefined && change.ifMatch !== profile.etag;
      if (stale) return { kind: 'conflict', profile: profile.name };
      if (profile.layers.includes(change.layer)) return { kind: 'written', profiles: [] };
      profiles = profiles.map(candidate =>
        candidate === profile ? edited(profile, [...profile.layers, change.layer]) : candidate,
      );
      return { kind: 'written', profiles: [profile.name] };
    }
    const naming = byName().filter(profile => profile.layers.includes(change.layer));
    const names = new Set(naming.map(profile => profile.name));
    profiles = profiles.map(profile =>
      names.has(profile.name)
        ? edited(
            profile,
            profile.layers.filter(layer => layer !== change.layer),
          )
        : profile,
    );
    return { kind: 'written', profiles: naming.map(profile => profile.name) };
  };
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
    // No asset tree is published in memory: it lists nothing until a test sets one.
    assetSkills: () => assetSkills,
    profiles: async () => byName(),
    layers: async id => layerSets.get(id),
    changeProfileLayers: async (change, governance) => {
      changes.push(change);
      // As the real act: the caller is judged first (so nothing is learnt about which profiles exist), then the name.
      const caller = callerRefusal(
        governance,
        change.kind === 'add' ? `profiles/${change.profile}.yaml` : 'the profile files',
      );
      if (caller !== undefined) return refused(caller);
      const wrong = layerNameRefusal(change.layer);
      if (wrong !== undefined) return refused(wrong);
      const instead = typeof forced === 'function' ? forced(change) : forced;
      return instead ?? apply(change);
    },
    setChangeOutcome: next => {
      forced = next;
    },
    setRuntimes: (next, nextDefault) => {
      runtimes = next;
      defaultRuntime = nextDefault;
    },
    setAssetSkills: next => {
      assetSkills = next;
    },
    catalog: async () => catalogRuntimes,
    tools: async () => catalogTools,
    setCatalog: (next, nextTools = []) => {
      catalogRuntimes = next;
      catalogTools = nextTools;
    },
    checkEnvironment: async runtime => checkEnvironments.get(runtime),
    setCheckEnvironment: (runtime, environment) => {
      checkEnvironments.set(runtime, environment);
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
  // A caller that carries no standing may change nothing, whatever it asks.
  const ungoverned = await api.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/conformance-probe' });
  if (ungoverned.kind !== 'refused') failures.push('changeProfileLayers() refuses a caller that carries no governance');
  return failures.length === 0 ? ok(true) : err(failures);
}
