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
import type { ConfigFileStatus, ConfigWriteAllDocument, ConfigWriteAllOutcome } from '@ferretry/kernel/contract';
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
import { expandStack, type StackFailure } from '../account/layering.ts';
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
  /**
   * What the kernel says of one profile file right now (`ConfigPort.fileState`). Read right AFTER `etag(profile)`: once
   * the etag is answered the kernel's settled view describes that disk text, so the state and the etag agree.
   */
  state(profile: string): Pick<ConfigFileStatus, 'state' | 'sentences'>;
  /** `ConfigPort.writeAll`: the kernel's all-or-none writer of Runtimes' own files. */
  writeAll(documents: readonly ConfigWriteAllDocument[]): Promise<ConfigWriteAllOutcome>;
  /** Runs `act` in the one-at-a-time section every apply runs in, so no apply is between its read and its write. */
  serialise<T>(act: () => Promise<T>): Promise<T>;
}

/**
 * Why a stack of bases cannot be expanded, in a sentence naming the profile. A profile's layers are read as plain text
 * and none of them can fail to parse, so the expansion has no 'layer' failure here.
 */
function stackRefusal(failure: Exclude<StackFailure<never>, { readonly kind: 'layer' }>, start: string): string {
  switch (failure.kind) {
    case 'unknown-profile':
      return failure.chain.length === 1
        ? `profile ${failure.profile} does not exist`
        : `profile ${failure.chain[failure.chain.length - 2]} names the base profile ${failure.profile}, which does not exist`;
    case 'loop':
      return `profile ${failure.profile} names the base profile ${failure.cycle[failure.cycle.length - 1]}, which leads back to itself (${failure.cycle.join(' → ')})`;
    case 'too-deep':
      return `profile ${start} sits under more than ${failure.limit} bases in a chain, which is too deep to read`;
    case 'too-large':
      return `profile ${failure.profile} expands to more than ${failure.limit} layers, which is too many to read`;
  }
}

/**
 * The MCP servers and skills a profile names, oldest first, with every `profile/<base>` layer expanded where it stands
 * and each item kept once at its newest position (a newer layer overrides an older one). A base that does not exist,
 * a loop of bases, or a stack beyond the bounds is refused in a sentence.
 *
 * The expansion is the account model's own (`expandStack`, ONE owner of how bases layer): each profile is expanded
 * once however many profiles reach it, so a lattice of diamonds costs one expansion per profile, not one per path.
 */
function resolveProfileStack(
  profiles: ReadonlyMap<string, ProfileFile>,
  start: string,
):
  | { readonly ok: true; readonly mcp: readonly string[]; readonly skills: readonly string[] }
  | { readonly ok: false; readonly sentence: string } {
  const stack = expandStack<string>(
    name => profiles.get(name)?.contents,
    text =>
      text.startsWith(`${PROFILE_LAYER_PREFIX}/`)
        ? { kind: 'base', name: text.slice(PROFILE_LAYER_PREFIX.length + 1) }
        : { kind: 'leaf', key: text, item: text },
    start,
  );
  // The leaf reader above never answers `fail`, so the expansion's failure type has no 'layer' arm.
  if (!stack.ok) return { ok: false, sentence: stackRefusal(stack.failure, start) };
  const named = (kind: 'mcp' | 'skills'): readonly string[] =>
    stack.entries
      .map(entry => entry.key)
      .filter(layer => layer.startsWith(`${kind}/`))
      .map(layer => layer.slice(kind.length + 1));
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

  /**
   * The refusal of a profile file that does not check on disk. Such a file keeps its LAST GOOD value in effect while its
   * etag is the digest of the broken text, so a patch built from that value and pinned to that etag would replace the
   * owner's broken edit whole and answer `written`. Fix the file first: nothing is ever written over it. A file that is
   * absent, valid or held is not judged here (a held one is refused by the writer itself).
   */
  const brokenRefusal = (profile: string): ProfileLayerOutcome | undefined => {
    let status: Pick<ConfigFileStatus, 'state' | 'sentences'>;
    try {
      status = deps.state(profile);
    } catch (error) {
      return refuse(`profile ${profile} could not be read, so nothing was changed: ${errorText(error)}`);
    }
    if (status.state !== 'invalid') return undefined;
    const problem = status.sentences.length === 0 ? 'it does not check' : status.sentences.join('; ');
    return refuse(
      `profile ${profile} does not check on disk (profiles/${profile}.yaml: ${problem}), so nothing was changed: fix the file first`,
    );
  };

  const add = async (change: Extract<ProfileLayerChange, { kind: 'add' }>): Promise<ProfileLayerOutcome> => {
    const layer: ProfileLayerName = change.layer;
    // The etag FIRST, then the value it describes: answering the etag refreshes what `profiles()` holds (an on-disk edit
    // the watcher has not reloaded yet is read now), so the value below is at least as new as this etag, PROVIDED the
    // file checks (a broken one keeps an older last good value: refused below). A value that is NEWER than the etag (the
    // file moved after) only makes the writer's `ifMatch` fail, a refusal; the other order pinned a fresh etag to an old
    // value and silently overwrote the edit.
    const etag = await etagOf(change.profile);
    if (typeof etag !== 'string') return etag;
    const broken = brokenRefusal(change.profile);
    if (broken !== undefined) return broken;
    const file = deps.profiles().get(change.profile);
    if (file === undefined) return refuse(`profile ${change.profile} does not exist`, 'fleet_change_unknown');
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

  /**
   * Every profile naming the layer loses it in ONE set: all of them, or (a conflict, a refusal) none. The profiles are
   * the ones the service knows when the list is read: a profile file made on the disk behind the service, and not yet
   * reloaded, is not in it and keeps the layer. Nothing is written to it, so nothing is lost; once the service has
   * reloaded it (its watcher, or a reload that anything causes), asking again removes the layer from it too.
   */
  const removeEverywhere = async (layer: ProfileLayerName): Promise<ProfileLayerOutcome> => {
    // For EVERY profile the etag comes first and the value after it (the same rule as `add`): which profiles name the
    // layer, and what each is rewritten to, is decided from a value at least as new as the etag it is pinned to, so an
    // edit not yet reloaded is read now or refused by the writer, never overwritten.
    const names = [...deps.profiles().keys()].toSorted((left, right) => left.localeCompare(right));
    const documents: ConfigWriteAllDocument[] = [];
    for (const name of names) {
      const etag = await etagOf(name);
      if (typeof etag !== 'string') return etag;
      // One broken file refuses the WHOLE set: nothing has been written yet, and nothing is.
      const broken = brokenRefusal(name);
      if (broken !== undefined) return broken;
      const file = deps.profiles().get(name);
      if (file === undefined || !file.contents.includes(layer)) continue;
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
        // The etag first, then the layers it describes (never a fresh etag over layers read before it).
        const etag = await deps.etag(name);
        const file = deps.profiles().get(name);
        if (file === undefined) continue;
        summaries.push({ name, layers: [...file.contents], etag });
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
