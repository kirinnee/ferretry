/**
 * What a runtime's profile stack names (`profiles`, `layers`) and the one act that edits a profile's layers
 * (`changeProfileLayers`). The item an `mcp/<name>` or `skills/<name>` layer names is its OWNER's file; this edits only
 * the profile files (`config/profiles/<name>.yaml`) that name it, through the kernel's config writer, so no other
 * plugin's file, no runtime, login or model set is ever touched.
 *
 * Every read is live: nothing is kept between calls (a stale answer here would launch an item a profile no longer
 * names, or hide one it does). Every failure to read or write says so in a sentence; none ends as a success.
 */
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { ConfigWriteAllDocument, ConfigWriteAllOutcome } from '@ferretry/kernel/contract';
import {
  ItemNameSchema,
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
}

const LAYER = /^(mcp|skills)\/([\s\S]*)$/u;

/** Why `layer` is not a layer a caller may add or remove, in words; `undefined` when it is one. */
export function layerNameRefusal(layer: string): string | undefined {
  const match = LAYER.exec(layer);
  if (match === null) return 'a layer is written mcp/<name> or skills/<name>';
  const name = match[2] ?? '';
  if ([...name].some(character => (character.codePointAt(0) ?? 0) < 0x20 || character === '\u007f'))
    return 'a layer name holds a control character';
  if (/^\.+$/u.test(name)) return 'a layer name cannot be only dots';
  if (!ItemNameSchema.safeParse(name).success)
    return 'a layer name is one word or phrase of at most 64 characters with no slash';
  return undefined;
}

/**
 * The MCP servers and skills a profile names, oldest first, with every `profile/<base>` layer expanded where it stands
 * and each item kept once at its newest position (a newer layer overrides an older one). A base that does not exist,
 * or a loop of bases, is refused in a sentence.
 */
function resolveProfileStack(
  profiles: ReadonlyMap<string, ProfileFile>,
  start: string,
):
  | { readonly ok: true; readonly mcp: readonly string[]; readonly skills: readonly string[] }
  | { readonly ok: false; readonly sentence: string } {
  const seen: string[] = [];
  const expand = (name: string, chain: readonly string[]): string | undefined => {
    const profile = profiles.get(name);
    if (profile === undefined)
      return chain.length === 1
        ? `profile ${name} does not exist`
        : `profile ${chain[chain.length - 2]} names the base profile ${name}, which does not exist`;
    for (const layer of profile.contents) {
      if (layer.startsWith(`${PROFILE_LAYER_PREFIX}/`)) {
        const base = layer.slice(PROFILE_LAYER_PREFIX.length + 1);
        if (chain.includes(base))
          return `profile ${name} names the base profile ${base}, which leads back to itself (${[...chain.slice(chain.indexOf(base)), base].join(' → ')})`;
        const refusal = expand(base, [...chain, base]);
        if (refusal !== undefined) return refusal;
        continue;
      }
      seen.push(layer);
    }
    return undefined;
  };
  const refusal = expand(start, [start]);
  if (refusal !== undefined) return { ok: false, sentence: refusal };
  const newest = new Map<string, number>();
  for (const [index, layer] of seen.entries()) newest.set(layer, index);
  const kept = seen.filter((layer, index) => newest.get(layer) === index);
  const named = (kind: 'mcp' | 'skills'): readonly string[] =>
    kept.filter(layer => layer.startsWith(`${kind}/`)).map(layer => layer.slice(kind.length + 1));
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
  const callerRefusal = (governance: unknown, profile: string): ProfileLayerOutcome | undefined => {
    const standing = governanceOf(governance);
    if (standing === undefined) return refuse('this daemon cannot say whether this caller may change the fleet');
    const sentence = configFileWriteRefusal(standing, `profiles/${profile}.yaml`, 'apply');
    return sentence === undefined ? undefined : refuse(sentence);
  };

  const patchOf = (profile: string, contents: readonly string[], etag: string): ConfigWriteAllDocument => ({
    def: PROFILE_ITEMS as never,
    name: profile,
    edit: { patch: { contents } },
    ifMatch: etag,
  });

  /** One document through the writer, in the words of the outcome. */
  const write = async (profile: string, document: ConfigWriteAllDocument): Promise<ProfileLayerOutcome> => {
    let outcome: ConfigWriteAllOutcome;
    try {
      outcome = await deps.writeAll([document]);
    } catch (error) {
      return refuse(`profile ${profile} could not be written: ${errorText(error)}; nothing was changed`);
    }
    switch (outcome.kind) {
      case 'written':
        return { kind: 'written', profiles: [profile] };
      case 'held':
        return { kind: 'held', sentence: outcome.sentence };
      case 'conflict':
        return { kind: 'conflict', profile };
      case 'refused':
        return refuse(
          `profile ${profile} was refused (${outcome.reason}): ${outcome.issues.map(issue => issue.message).join('; ')}`,
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
      const layer: ProfileLayerName = change.layer;
      if (change.kind === 'add') {
        const refused = callerRefusal(governance, change.profile);
        if (refused !== undefined) return refused;
        const wrong = layerNameRefusal(layer);
        if (wrong !== undefined) return refuse(wrong);
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
        return await write(change.profile, patchOf(change.profile, [...file.contents, layer], change.ifMatch ?? etag));
      }

      // Whoever asks is judged first and for every profile, so a caller that may not change the fleet learns nothing
      // about which profiles name the layer.
      const refused = callerRefusal(governance, '*');
      if (refused !== undefined) return refused;
      const wrong = layerNameRefusal(layer);
      if (wrong !== undefined) return refuse(wrong);
      const naming = [...deps.profiles()]
        .filter(([, file]) => file.contents.includes(layer))
        .map(([name]) => name)
        .toSorted((left, right) => left.localeCompare(right));
      const written: string[] = [];
      for (const name of naming) {
        const file = deps.profiles().get(name);
        if (file === undefined) continue;
        const etag = await etagOf(name);
        if (typeof etag !== 'string') return etag;
        const outcome = await write(
          name,
          patchOf(
            name,
            file.contents.filter(entry => entry !== layer),
            etag,
          ),
        );
        if (outcome.kind !== 'written') {
          return written.length === 0 || outcome.kind === 'conflict'
            ? outcome
            : outcome.kind === 'held'
              ? { kind: 'held', sentence: `${outcome.sentence} (already removed from ${written.join(', ')})` }
              : refuse(`${outcome.sentence} (already removed from ${written.join(', ')})`);
        }
        written.push(name);
      }
      return { kind: 'written', profiles: written };
    },
  };
}
