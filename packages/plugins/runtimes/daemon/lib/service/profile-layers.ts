/**
 * What a runtime's profile stack names (`profiles`, `layers`) and the one act that edits a profile's layers
 * (`changeProfileLayers`). The item an `mcp/<name>` or `skills/<name>` layer names is its OWNER's file; this edits only
 * the profile files (`config/profiles/<name>.yaml`) that name it, through the kernel's config writer, so no other
 * plugin's file, no runtime, login or model set is ever touched.
 *
 * Every read is live: nothing is kept between calls (a stale answer here would launch an item a profile no longer
 * names, or hide one it does). Every failure to read or write says so in a sentence; none ends as a success.
 *
 * A change reads a profile and writes it back, so it runs in the SAME one-at-a-time section as an apply (S67): an
 * apply's documents are key patches with no etag, and one that landed between this act's read and its write would
 * overwrite the layer it just added.
 */
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { ConfigWriteAllDocument, ConfigWriteAllOutcome } from '@ferretry/kernel/contract';
import {
  layerNameRefusal,
  PROFILE_ITEMS,
  PROFILE_LAYER_PREFIX,
  RuntimeIdSchema,
  type ProfileFile,
  type ProfileLayerChange,
  type ProfileLayerName,
  type ProfileLayerOutcome,
  type ProfileSummary,
  type RuntimeFile,
  type RuntimeId,
  type RuntimeLayers,
  type RuntimeLayersApi,
} from '../../../contract/index.ts';
import { configFileWriteRefusal } from './ports.ts';

/** A profile stack that cannot be resolved: the sentence says which profile and why. */
class ProfileLayersRefused extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'ProfileLayersRefused';
  }
}

export interface ProfileLayerDeps {
  /** `config/runtimes/*.yaml`, parsed, live. */
  runtimes(): ReadonlyMap<string, RuntimeFile>;
  /** `config/profiles/*.yaml`, parsed, live. */
  profiles(): ReadonlyMap<string, ProfileFile>;
  /** The etag of one profile file as it is on disk right now (`'absent'` when there is none). Rejects when unreadable. */
  etag(profile: string): Promise<string>;
  /** `ConfigPort.writeAll`: the kernel's all-or-none writer of Runtimes' own files. */
  writeAll(documents: readonly ConfigWriteAllDocument[]): Promise<ConfigWriteAllOutcome>;
  /** Runs `act` in the one-at-a-time section every apply runs in, so no apply is between its read and its write. */
  serialise<T>(act: () => Promise<T>): Promise<T>;
}

/** The layers of a list with each one kept once, at its newest position (a newer layer overrides an older one). */
function newestOnly(layers: readonly string[]): readonly string[] {
  const newest = new Map<string, number>();
  for (const [index, layer] of layers.entries()) newest.set(layer, index);
  return layers.filter((layer, index) => newest.get(layer) === index);
}

type Expansion = { readonly layers: readonly string[] } | { readonly refusal: string };

/**
 * The MCP servers and skills a profile names, oldest first, with every `profile/<base>` layer expanded where it stands
 * and each item kept once at its newest position (a newer layer overrides an older one). A base that does not exist,
 * or a loop of bases, is refused in a sentence.
 *
 * Each profile is expanded ONCE: its expansion does not depend on who reached it, so a base shared by many profiles
 * (a lattice of diamonds) costs one expansion, not one per path. Keeping only the newest copy of each item per
 * profile before the parent concatenates gives the same list as keeping it once at the end.
 */
function resolveProfileStack(
  profiles: ReadonlyMap<string, ProfileFile>,
  start: string,
):
  | { readonly ok: true; readonly mcp: readonly string[]; readonly skills: readonly string[] }
  | { readonly ok: false; readonly sentence: string } {
  // Only a profile whose whole subtree resolved is remembered, so a profile in a loop is never in here.
  const expanded = new Map<string, readonly string[]>();
  const expand = (name: string, chain: readonly string[]): Expansion => {
    const done = expanded.get(name);
    if (done !== undefined) return { layers: done };
    const profile = profiles.get(name);
    if (profile === undefined)
      return {
        refusal:
          chain.length === 1
            ? `profile ${name} does not exist`
            : `profile ${chain[chain.length - 2]} names the base profile ${name}, which does not exist`,
      };
    const layers: string[] = [];
    for (const layer of profile.contents) {
      if (!layer.startsWith(`${PROFILE_LAYER_PREFIX}/`)) {
        layers.push(layer);
        continue;
      }
      const base = layer.slice(PROFILE_LAYER_PREFIX.length + 1);
      if (chain.includes(base))
        return {
          refusal: `profile ${name} names the base profile ${base}, which leads back to itself (${[...chain.slice(chain.indexOf(base)), base].join(' → ')})`,
        };
      const inner = expand(base, [...chain, base]);
      if ('refusal' in inner) return inner;
      for (const kept of inner.layers) layers.push(kept);
    }
    const kept = newestOnly(layers);
    expanded.set(name, kept);
    return { layers: kept };
  };
  const stack = expand(start, [start]);
  if ('refusal' in stack) return { ok: false, sentence: stack.refusal };
  const named = (kind: 'mcp' | 'skills'): readonly string[] =>
    stack.layers.filter(layer => layer.startsWith(`${kind}/`)).map(layer => layer.slice(kind.length + 1));
  return { ok: true, mcp: named('mcp'), skills: named('skills') };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What a caller of `changeProfileLayers` is, as far as it can be told: a governance only when it carries one. */
function governanceOf(value: unknown): CallerGovernance | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { readonly governed?: unknown; readonly decide?: unknown };
  return typeof candidate.decide === 'function' && typeof candidate.governed === 'boolean'
    ? (value as CallerGovernance)
    : undefined;
}

const refuse = (sentence: string, code: 'fleet_change_unknown' | 'fleet_change_refused' = 'fleet_change_refused') =>
  ({ kind: 'refused', code, sentence }) as const satisfies ProfileLayerOutcome;

export function createProfileLayers(deps: ProfileLayerDeps): RuntimeLayersApi {
  /** The refusal of a caller that may not change the fleet: the same standing `apply` demands. */
  const callerRefusal = (governance: unknown, path: string): ProfileLayerOutcome | undefined => {
    const standing = governanceOf(governance);
    if (standing === undefined) return refuse('this daemon cannot say whether this caller may change the fleet');
    let sentence: string | undefined;
    try {
      sentence = configFileWriteRefusal(standing, path, 'apply');
    } catch {
      // A standing that cannot answer is no standing: refused, never a rejection, and nothing was written.
      return refuse('this daemon cannot say whether this caller may change the fleet');
    }
    return sentence === undefined ? undefined : refuse(sentence);
  };

  const patchOf = (profile: string, contents: readonly string[], etag: string): ConfigWriteAllDocument => ({
    def: PROFILE_ITEMS as never,
    name: profile,
    edit: { patch: { contents } },
    ifMatch: etag,
  });

  const describe = (profiles: readonly string[]): string =>
    profiles.length === 1 ? `profile ${profiles[0] ?? ''}` : `profiles ${profiles.join(', ')}`;

  /**
   * These documents through the writer, ALL OR NONE, in the words of the outcome. `written` names every profile; any
   * other outcome means nothing at all was written.
   */
  const writeSet = async (
    profiles: readonly string[],
    documents: readonly ConfigWriteAllDocument[],
  ): Promise<ProfileLayerOutcome> => {
    let outcome: ConfigWriteAllOutcome;
    try {
      outcome = await deps.writeAll(documents);
    } catch (error) {
      return refuse(`${describe(profiles)} could not be written: ${errorText(error)}; nothing was changed`);
    }
    switch (outcome.kind) {
      case 'written':
        return { kind: 'written', profiles };
      case 'held':
        return { kind: 'held', sentence: outcome.sentence };
      case 'conflict':
        return { kind: 'conflict', profile: outcome.name ?? profiles[0] ?? '' };
      case 'refused':
        return refuse(
          `${describe(profiles)} was refused (${outcome.reason}): ${outcome.issues.map(issue => issue.message).join('; ')}`,
        );
    }
  };

  const etagOf = async (profile: string): Promise<string | ProfileLayerOutcome> => {
    try {
      return await deps.etag(profile);
    } catch (error) {
      return refuse(`profile ${profile} could not be read, so nothing was changed: ${errorText(error)}`);
    }
  };

  const add = async (change: Extract<ProfileLayerChange, { kind: 'add' }>): Promise<ProfileLayerOutcome> => {
    const layer: ProfileLayerName = change.layer;
    const file = deps.profiles().get(change.profile);
    if (file === undefined) return refuse(`profile ${change.profile} does not exist`, 'fleet_change_unknown');
    const etag = await etagOf(change.profile);
    if (typeof etag !== 'string') return etag;
    if (file.contents.includes(layer)) {
      // Already there: nothing to write. A caller that read the profile before it moved is still told.
      return change.ifMatch !== undefined && change.ifMatch !== etag
        ? { kind: 'conflict', profile: change.profile }
        : { kind: 'written', profiles: [] };
    }
    return await writeSet(
      [change.profile],
      [patchOf(change.profile, [...file.contents, layer], change.ifMatch ?? etag)],
    );
  };

  /** Every profile naming the layer loses it in ONE set: all of them, or (a conflict, a refusal) none. */
  const removeEverywhere = async (layer: ProfileLayerName): Promise<ProfileLayerOutcome> => {
    const naming = [...deps.profiles()]
      .filter(([, file]) => file.contents.includes(layer))
      .map(([name]) => name)
      .toSorted((left, right) => left.localeCompare(right));
    const documents: ConfigWriteAllDocument[] = [];
    for (const name of naming) {
      const file = deps.profiles().get(name);
      if (file === undefined) continue;
      const etag = await etagOf(name);
      if (typeof etag !== 'string') return etag;
      documents.push(
        patchOf(
          name,
          file.contents.filter(entry => entry !== layer),
          etag,
        ),
      );
    }
    if (documents.length === 0) return { kind: 'written', profiles: [] };
    return await writeSet(
      documents.flatMap(document => (document.name === undefined ? [] : [document.name])),
      documents,
    );
  };

  return {
    profiles: async (): Promise<readonly ProfileSummary[]> => {
      const names = [...deps.profiles().keys()].toSorted((left, right) => left.localeCompare(right));
      const summaries: ProfileSummary[] = [];
      for (const name of names) {
        const file = deps.profiles().get(name);
        if (file === undefined) continue;
        summaries.push({ name, layers: [...file.contents], etag: await deps.etag(name) });
      }
      return summaries;
    },

    layers: async (runtime: RuntimeId): Promise<RuntimeLayers | undefined> => {
      const file = deps.runtimes().get(runtime);
      if (file === undefined) return undefined;
      const stack = resolveProfileStack(deps.profiles(), file.profile);
      if (!stack.ok) throw new ProfileLayersRefused(`${runtime}: ${stack.sentence}`);
      return { runtime: RuntimeIdSchema.parse(runtime), profile: file.profile, mcp: stack.mcp, skills: stack.skills };
    },

    changeProfileLayers: async (change: ProfileLayerChange, governance?: unknown): Promise<ProfileLayerOutcome> => {
      // Whoever asks is judged first (for `remove-everywhere`, for every profile), so a caller that may not change the
      // fleet learns nothing about which profiles exist or name the layer.
      const refused = callerRefusal(
        governance,
        change.kind === 'add' ? `profiles/${change.profile}.yaml` : 'the profile files',
      );
      if (refused !== undefined) return refused;
      const wrong = layerNameRefusal(change.layer);
      if (wrong !== undefined) return refuse(wrong);
      // The read and the write of the file happen inside the section, never across an apply.
      return await deps.serialise(async () =>
        change.kind === 'add' ? await add(change) : await removeEverywhere(change.layer),
      );
    },
  };
}
