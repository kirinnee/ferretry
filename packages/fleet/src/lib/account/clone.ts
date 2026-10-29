/**
 * Clone from another machine (docs/design/account-model.md §3.8, §4.7, E27–E31).
 *
 * A **one-time copy** of components, model sets, profiles and runtimes (L1). The browser holds both
 * connections: it reads the source's export and hands it to the target as data, so this module has
 * two halves that never meet on one machine.
 *
 * - {@link cloneSources} and {@link buildCloneBundle} — the SOURCE: which documents the bundle needs,
 *   then the bundle itself. Each login the copied runtimes use travels as a descriptor (harness, label,
 *   email) and nothing else (L2), and no history travels at all (L3).
 * - {@link planClone} — the TARGET: the next configuration and the documents to write. Each login
 *   becomes an **empty slot** that needs sign-in and keeps its label, and the runtimes keep pointing
 *   at their slot (C8). **Add alongside** keeps what is there and gives a clashing name `-2`;
 *   **Replace** removes the target's components, profiles and runtimes first and **keeps its logins**
 *   (L4, E28). Content naming a path under `/Users/` or `/home/` is flagged to check (L5, E30), a
 *   runtime whose harness is missing is still copied (E29), and a `${secret:NAME}` reference stays a
 *   reference — one the target does not hold is named (L7, G7).
 *
 * ## What runs on the target is listed, and each piece can be left behind
 *
 * MCP servers, hooks and settings start programs on the target the next time an agent launches there,
 * so a copy from a machine that was broken into plants commands. {@link describeClone} lists every one
 * of them in words — the same list the app's preview shows, from `cloneRunnables` in the protocol —
 * and {@link CloneOptions.skip} leaves any component out, with every layer that names it. Everything
 * copied records where it came from: the source's own name, and the daemon id the copying browser
 * verified when it paired with it (`clonedFromDaemon`), because a name is only what a machine says.
 * A carried document whose path is absolute or climbs out with `..` refuses the whole bundle.
 *
 * Pure: a model and documents in, a plan out. Reading the source's files and writing the target's
 * are the setup service's.
 */
import {
  type CloneAgentRuntime,
  type CloneRunnable,
  cloneBundleProblem,
  cloneFileOwned,
  cloneRunnables,
  FLEET_CLONE_BUNDLE_FORMAT,
  type FleetCloneBundle,
  FleetCloneBundleSchema,
  type FleetCloneCredential,
  type FleetCloneFile,
  secretReferencesIn,
  suggestCloneDefault,
} from '@ferretry/protocol';
import type { HarnessKind } from '../manifest.ts';
import { canonicalAssetReference } from '../paths.ts';
import { skillSourceReference } from './adapt.ts';
import { cloudCredentialSentence, parseCloudCredential } from './environment.ts';
import { freeName } from './import.ts';
import { HARNESS_DISPLAY_NAMES } from './layering.ts';
import {
  type AccountModel,
  COMPONENT_KINDS,
  type ComponentKind,
  type Credential,
  type LayeredProfile,
  parseAccountModel,
  parseLayerReference,
  type Runtime,
} from './schema.ts';
import { runtimeHarness } from './scope.ts';

/** Why a bundle cannot be copied. The message is the sentence a person reads. */
export class CloneRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloneRefusal';
  }
}

/** Whether a configured path is inside the asset tree, and so can travel as a document. */
const isAssetRelative = (file: string): boolean =>
  !file.startsWith('/') && !file.startsWith('~') && !file.startsWith('$') && !file.split('/').includes('..');

// ── The source ───────────────────────────────────────────────────────────────────────────────────

/** What the source must read for a bundle: single documents and whole folders, relative to the asset tree. */
export interface CloneSources {
  readonly documents: readonly string[];
  readonly directories: readonly string[];
  /** Paths outside the asset tree: they cannot travel, and the component keeps naming them. */
  readonly outside: readonly string[];
}

/** The documents and folders a bundle of this model carries. */
export function cloneSources(model: AccountModel): CloneSources {
  const documents = new Set<string>();
  const directories = new Set<string>();
  const outside = new Set<string>();
  const note = (path: string, into: Set<string>): void => {
    (isAssetRelative(path) ? into : outside).add(path);
  };
  for (const component of Object.values(model.components.instructions)) note(component.file, documents);
  for (const component of Object.values(model.components.settings)) {
    if (component.file !== undefined) note(component.file, documents);
  }
  for (const component of Object.values(model.components.hooks)) {
    if (component.file !== undefined) note(component.file, documents);
    if (component.directory !== undefined) note(component.directory, directories);
  }
  for (const component of Object.values(model.components.skills)) {
    for (const item of component.items) directories.add(skillSourceReference(item));
  }
  const sorted = (set: Set<string>): string[] => [...set].toSorted();
  return { documents: sorted(documents), directories: sorted(directories), outside: sorted(outside) };
}

export interface CloneBundleInput {
  readonly model: AccountModel;
  readonly machine: string;
  readonly exportedAt: string;
  /** Each login's email, where the credentials surface knows one. Display only. */
  readonly emails: Readonly<Record<string, string | undefined>>;
  /** The documents that were read, relative to the asset tree. */
  readonly files: readonly FleetCloneFile[];
  /** Documents that could not be carried, with the reason. */
  readonly notCopied: readonly { readonly path: string; readonly reason: string }[];
}

/** An asset-relative path in its one plain spelling (`./a//b/` → `a/b`); anything else as it is. */
const plainAsset = (path: string): string =>
  isAssetRelative(path) ? canonicalAssetReference(path).replace(/\/+$/u, '') : path;

/** A component with its `file` and `directory` in their plain spelling. */
const plainReferences = (component: Record<string, unknown>): Record<string, unknown> => {
  const plain = { ...component };
  for (const field of ['file', 'directory'] as const) {
    if (typeof plain[field] === 'string') plain[field] = plainAsset(plain[field] as string);
  }
  return plain;
};

/** The bundle `GET /v1/fleet/export` answers: no credential, no history (L1–L3, §7). */
export function buildCloneBundle(input: CloneBundleInput): FleetCloneBundle {
  const { model } = input;
  const used = new Set(Object.values(model.runtimes).map(runtime => runtime.credential));
  const credentials = Object.entries(model.credentials)
    .filter(([id]) => used.has(id))
    .map(([id, credential]) => {
      const email = input.emails[id];
      return {
        id,
        harness: credential.harness,
        ...(credential.label === undefined ? {} : { label: credential.label }),
        ...(email === undefined ? {} : { email }),
        // An environment login travels as its file does: plain values, secret NAMES, its references.
        ...(credential.store === 'environment' ? environmentDescriptor(credential) : {}),
      };
    });
  // ONE SPELLING ON THE WIRE. A target refuses a bundle whose paths could be read two ways
  // (`cloneBundleProblem`), and the starter configuration itself writes `./CLAUDE.md`, so every asset
  // reference and every carried path leaves here in its canonical form, each document once.
  const components = Object.fromEntries(
    Object.entries(model.components).map(([kind, entries]) => [
      kind,
      Object.fromEntries(
        Object.entries(entries as Record<string, Record<string, unknown>>).map(([name, component]) => [
          name,
          plainReferences(component),
        ]),
      ),
    ]),
  );
  const files = new Map<string, FleetCloneFile>();
  for (const file of input.files) {
    const plain = plainAsset(file.path);
    if (!files.has(plain)) files.set(plain, { path: plain, content: file.content });
  }
  return FleetCloneBundleSchema.parse({
    format: FLEET_CLONE_BUNDLE_FORMAT,
    version: 1,
    machine: input.machine,
    exportedAt: input.exportedAt,
    credentials,
    components,
    profiles: model.profiles,
    runtimes: model.runtimes,
    files: [...files.values()],
    notCopied: input.notCopied.map(entry => ({ path: entry.path, reason: entry.reason })),
  });
}

// ── The target ───────────────────────────────────────────────────────────────────────────────────

export type CloneMode = 'alongside' | 'replace';

export interface CloneOptions {
  readonly mode: CloneMode;
  /** The target's name, for the sentences. */
  readonly machine: string;
  /** The harnesses installed on the target (E29). */
  readonly installed: readonly HarnessKind[];
  /** Skill items the target's store already holds: they are kept, never overwritten. */
  readonly existingSkillItems: readonly string[];
  /** Secret names the target's store holds, so a reference it lacks is named (G7). */
  readonly existingSecrets: readonly string[];
  /** Components (`<kind>/<name>`) the person chose not to copy. Each must be one the bundle has. */
  readonly skip?: readonly string[];
  /** The source's daemon id as the copying browser verified it, recorded on everything copied. */
  readonly sourceDaemon?: string;
  /**
   * The source as the person names it in their app (`Liftoff EC2`), for the sentences. The bundle's own
   * `machine` is only what the source called itself, which is usually a hostname.
   */
  readonly sourceName?: string;
  /**
   * The default runtime for new agents once the copy is done: the SOURCE's name for an agent runtime the
   * bundle brings, `null` to leave it unset, or left out to keep the target's own when the copy leaves it
   * standing and otherwise pick a valid one ({@link CloneDefault}).
   */
  readonly defaultRuntime?: string | null;
}

/** What became of "Default runtime for new agents", so the preview and the description can say it. */
export type CloneDefault =
  /** The target had none and the copy chose none. */
  | { readonly kind: 'none' }
  /** The target's own default is still a runtime after the copy. */
  | { readonly kind: 'kept'; readonly runtime: string }
  /** The person chose it (or the source's was carried), under the name it lands with. */
  | { readonly kind: 'chosen'; readonly runtime: string }
  /** The person chose to leave it unset. */
  | { readonly kind: 'unset' }
  /** The target's default would have dangled, so the copy replaced it: `now` is absent when no runtime fits. */
  | { readonly kind: 'repaired'; readonly was: string; readonly now?: string };

/** One thing that took another name because the target already had one (E28). */
export interface CloneRename {
  readonly what: 'component' | 'profile' | 'runtime' | 'login';
  readonly from: string;
  readonly to: string;
}

/** One empty slot the copy creates, and the runtimes that point at it (C8, E31). */
export interface CloneSlot {
  readonly id: string;
  readonly harness: HarnessKind;
  readonly label?: string;
  readonly email?: string;
  readonly runtimes: readonly string[];
}

export interface ClonePlan {
  readonly model: AccountModel;
  /** Documents to write, relative to the asset tree. */
  readonly files: readonly FleetCloneFile[];
  readonly renamed: readonly CloneRename[];
  readonly slots: readonly CloneSlot[];
  /** Components whose content names a path that may not exist here (E30), with the first such path. */
  readonly checkPaths: readonly { readonly reference: string; readonly path: string }[];
  /** Harnesses a copied runtime uses that the target does not have (E29). */
  readonly missingHarnesses: readonly HarnessKind[];
  /** `${secret:NAME}` references the target's store does not hold (G7). */
  readonly missingSecrets: readonly string[];
  /** Cloud credential references a copied environment login names: the target must have each one. */
  readonly references: readonly { readonly login: string; readonly reference: string; readonly sentence: string }[];
  /** Skill items the target already had, kept as they were. */
  readonly keptSkillItems: readonly string[];
  readonly copied: {
    readonly components: number;
    readonly modelSets: number;
    readonly profiles: number;
    readonly runtimes: number;
  };
  /** Replace only: what the target lost first. */
  readonly removed: { readonly components: number; readonly profiles: number; readonly runtimes: number };
  readonly notCopied: readonly { readonly path: string; readonly reason: string }[];
  /** Every copied component that runs something here, under the name it lands with. */
  readonly runnables: readonly CloneRunnable[];
  /** The components the person chose not to copy, as the bundle named them. */
  readonly skipped: readonly string[];
  /** Where "Default runtime for new agents" ended up. */
  readonly defaultRuntime: CloneDefault;
}

/** A path under a person's home on macOS or Linux, as it appears in text. */
const HOME_PATH = /\/(?:Users|home)\/[^\s"'`,;)}\]]+/u;

type MutableComponents = Record<ComponentKind, Record<string, Record<string, unknown>>>;

const countComponents = (components: AccountModel['components'], kinds: readonly ComponentKind[]): number =>
  kinds.reduce((total, kind) => total + Object.keys(components[kind]).length, 0);

const NON_MODEL_KINDS = COMPONENT_KINDS.filter(kind => kind !== 'modelSets');

/**
 * The bundle, refused with a sentence when it is not one — or when the review could misread it
 * (`cloneBundleProblem`): a carried path outside the asset tree or spelled two ways, the same path twice,
 * a component reference spelled two ways, or a file no carried component owns. What is planned from an
 * accepted bundle is exactly what the review listed.
 */
export function parseCloneBundle(input: unknown): FleetCloneBundle {
  const parsed = FleetCloneBundleSchema.safeParse(input);
  if (!parsed.success) {
    throw new CloneRefusal(
      'That is not a setup exported by Ferretry, or it was exported by a version this machine cannot read.',
    );
  }
  const problem = cloneBundleProblem(parsed.data);
  if (problem !== null) throw new CloneRefusal(problem);
  return parsed.data;
}

/**
 * The bundle without the components the person left out: each one, every layer that names it, and
 * every document only it carried. A skip that names nothing in the bundle is refused, so a stale
 * review can never be mistaken for one that left something out.
 */
function withoutSkipped(bundle: FleetCloneBundle, skip: readonly string[], sourceName: string): FleetCloneBundle {
  if (skip.length === 0) return bundle;
  const skipped = new Set(skip);
  const components: Record<string, Record<string, unknown>> = {};
  const leftOut: Readonly<Record<string, unknown>>[] = [];
  for (const [kind, entries] of Object.entries(bundle.components)) {
    components[kind] = {};
    for (const [name, component] of Object.entries(entries)) {
      if (!skipped.delete(`${kind}/${name}`)) (components[kind] as Record<string, unknown>)[name] = component;
      else if (typeof component === 'object' && component !== null) leftOut.push(component as Record<string, unknown>);
    }
  }
  const unknown = [...skipped][0];
  if (unknown !== undefined) {
    throw new CloneRefusal(`The setup from ${sourceName} has no ${unknown} to leave out. Review it again.`);
  }
  const profiles = Object.fromEntries(
    Object.entries(bundle.profiles).map(([name, profile]) => {
      const layers = (profile as { layers?: unknown }).layers;
      return [
        name,
        Array.isArray(layers)
          ? { ...(profile as object), layers: layers.filter(layer => !skip.includes(layer as string)) }
          : profile,
      ];
    }),
  );
  const kept = Object.values(components).flatMap(entries => Object.values(entries)) as Record<string, unknown>[];
  const files = bundle.files.filter(
    file =>
      !leftOut.some(component => cloneFileOwned(component, file.path)) ||
      kept.some(component => cloneFileOwned(component, file.path)),
  );
  return { ...bundle, components, profiles, files };
}

/** The bundle as a model of its own, so a damaged one is refused before anything is renamed. */
function bundleModel(bundle: FleetCloneBundle, sourceName: string): AccountModel {
  const credentials: Record<string, Credential> = {};
  for (const credential of bundle.credentials) {
    // An environment login keeps its halves, so a runtime on its Codex half still reads as one.
    credentials[credential.id] =
      credential.store === 'environment'
        ? (environmentCredential(credential) as Credential)
        : { harness: credential.harness, store: 'ferretry' };
  }
  try {
    return parseAccountModel({
      version: 2,
      credentials,
      components: bundle.components,
      profiles: bundle.profiles,
      runtimes: bundle.runtimes,
    });
  } catch (error) {
    const first = (error as { issues?: readonly { message: string }[] }).issues?.[0]?.message;
    throw new CloneRefusal(
      `The setup from ${sourceName} cannot be copied${first === undefined ? '' : `: ${first}`}. Nothing was changed.`,
    );
  }
}

/** The file a renamed component's document moves to, never one the target already uses. */
function movedFile(file: string, from: string, to: string, used: ReadonlySet<string>): string {
  if (!isAssetRelative(file)) return file;
  const dot = file.lastIndexOf('.');
  const slash = file.lastIndexOf('/');
  const stem = dot > slash ? file.slice(0, dot) : file;
  const extension = dot > slash ? file.slice(dot) : '';
  const renamedStem = from !== to && stem.endsWith(`/${from}`) ? `${stem.slice(0, -from.length)}${to}` : stem;
  const freeStem = freeName(renamedStem, candidate => used.has(`${candidate}${extension}`));
  return `${freeStem}${extension}`;
}

/** Every asset-tree document the model's components name. */
function referencedFiles(model: AccountModel): Set<string> {
  const files = new Set<string>();
  for (const kind of ['instructions', 'settings', 'hooks'] as const) {
    for (const component of Object.values(model.components[kind]) as { file?: string; directory?: string }[]) {
      if (component.file !== undefined) files.add(component.file);
      if (component.directory !== undefined) files.add(component.directory);
    }
  }
  return files;
}

/**
 * Plan copying a bundle onto this machine. Throws {@link CloneRefusal} when the bundle is damaged or
 * the copy would make a configuration this machine cannot read.
 */
export function planClone(target: AccountModel, offered: FleetCloneBundle, options: CloneOptions): ClonePlan {
  const skipped = [...new Set(options.skip ?? [])].toSorted();
  const sourceName = options.sourceName ?? offered.machine;
  const bundle = withoutSkipped(offered, skipped, sourceName);
  const source = bundleModel(bundle, sourceName);
  // Where it came from, on everything copied. Whatever the source said about its own items' origin is
  // replaced: that is the source's claim, and this copy's origin is the source.
  const origin = {
    clonedFrom: bundle.machine,
    ...(options.sourceDaemon === undefined ? {} : { clonedFromDaemon: options.sourceDaemon }),
  };
  const replace = options.mode === 'replace';
  const base: AccountModel = replace
    ? {
        ...target,
        components: { instructions: {}, mcp: {}, skills: {}, settings: {}, hooks: {}, modelSets: {} },
        profiles: {},
        runtimes: {},
        advanced: { ...target.advanced, commands: [] },
      }
    : target;
  const renamed: CloneRename[] = [];

  // Logins: one empty slot per descriptor, under a free id. Replace keeps every login there was.
  const credentialIds = new Map<string, string>();
  const credentials: Record<string, Credential> = { ...base.credentials };
  for (const credential of bundle.credentials) {
    const id = freeName(credential.id, candidate => credentials[candidate] !== undefined);
    if (id !== credential.id) renamed.push({ what: 'login', from: credential.id, to: id });
    credentialIds.set(credential.id, id);
    const label = credential.label ?? credential.email;
    credentials[id] =
      credential.store === 'environment'
        ? ({ ...environmentCredential(credential), ...origin } as Credential)
        : {
            harness: credential.harness,
            store: 'ferretry',
            ...(label === undefined ? {} : { label }),
            ...origin,
          };
  }

  // Components: a clashing name takes `-2`, and its document moves with it.
  const components = Object.fromEntries(
    COMPONENT_KINDS.map(kind => [kind, { ...base.components[kind] }]),
  ) as MutableComponents;
  const componentNames = new Map<string, string>();
  const usedFiles = referencedFiles(base);
  const fileMoves = new Map<string, string>();
  const checkPaths: { reference: string; path: string }[] = [];
  const contents = new Map(bundle.files.map(file => [file.path, file.content]));
  for (const kind of COMPONENT_KINDS) {
    for (const [name, value] of Object.entries(source.components[kind]) as [string, Record<string, unknown>][]) {
      const free = freeName(name, candidate => components[kind][candidate] !== undefined);
      if (free !== name) renamed.push({ what: 'component', from: `${kind}/${name}`, to: `${kind}/${free}` });
      componentNames.set(`${kind}/${name}`, `${kind}/${free}`);
      const { clonedFrom: _claimed, clonedFromDaemon: _claimedDaemon, ...own } = value;
      const copy: Record<string, unknown> = { ...own, ...origin };
      for (const field of ['file', 'directory'] as const) {
        const file = copy[field];
        if (typeof file !== 'string' || !isAssetRelative(file) || field === 'directory') continue;
        const moved = fileMoves.get(file) ?? movedFile(file, name, free, usedFiles);
        fileMoves.set(file, moved);
        usedFiles.add(moved);
        copy[field] = moved;
      }
      components[kind][free] = copy;
      const text = [JSON.stringify(value), ...['file', 'directory'].map(field => contents.get(value[field] as string))]
        .filter(entry => entry !== undefined)
        .join('\n');
      const path = HOME_PATH.exec(text)?.[0];
      if (path !== undefined) checkPaths.push({ reference: `${kind}/${free}`, path });
    }
  }

  // Profiles, then runtimes: every reference follows the rename.
  const profileNames = new Map<string, string>();
  const profiles: Record<string, LayeredProfile> = { ...base.profiles };
  const chosenProfiles = new Set<string>();
  for (const name of Object.keys(source.profiles)) {
    const free = freeName(name, candidate => profiles[candidate] !== undefined || chosenProfiles.has(candidate));
    chosenProfiles.add(free);
    if (free !== name) renamed.push({ what: 'profile', from: name, to: free });
    profileNames.set(name, free);
  }
  for (const [name, profile] of Object.entries(source.profiles)) {
    profiles[profileNames.get(name) as string] = {
      layers: profile.layers.map(layer => {
        const reference = parseLayerReference(layer);
        if (reference?.kind === 'profile') return `profile/${profileNames.get(reference.name) as string}`;
        return componentNames.get(layer) as string;
      }) as LayeredProfile['layers'],
    };
  }
  const runtimes: Record<string, Runtime> = { ...base.runtimes };
  const runtimeNames = new Map<string, string>();
  const copiedAgents: CloneAgentRuntime[] = [];
  const slotRuntimes = new Map<string, string[]>();
  const missingHarnesses = new Set<HarnessKind>();
  const commandNames = new Set(base.advanced.commands.map(command => command.wrapper));
  for (const [name, runtime] of Object.entries(source.runtimes)) {
    const free = freeName(name, candidate => runtimes[candidate] !== undefined || commandNames.has(candidate));
    if (free !== name) renamed.push({ what: 'runtime', from: name, to: free });
    runtimeNames.set(name, free);
    const credential = credentialIds.get(runtime.credential) as string;
    runtimes[free] = {
      credential,
      profile: profileNames.get(runtime.profile) as string,
      agent: runtime.agent,
      ...(runtime.harness === undefined ? {} : { harness: runtime.harness }),
    };
    slotRuntimes.set(credential, [...(slotRuntimes.get(credential) ?? []), free]);
    const harness = runtimeHarness(source, runtime) as HarnessKind;
    if (runtime.agent) copiedAgents.push({ name, harness });
    if (!options.installed.includes(harness)) missingHarnesses.add(harness);
  }

  const { machine, defaultRuntime } = defaultAfterCopy({
    base,
    runtimes,
    runtimeNames,
    copiedAgents,
    sourceName,
    requested: options.defaultRuntime,
  });

  // Documents: each under the path its component now names. A skill item the target has is kept.
  const existingItems = new Set(options.existingSkillItems);
  const keptSkillItems = new Set<string>();
  const files: FleetCloneFile[] = [];
  for (const file of bundle.files) {
    const moved = fileMoves.get(file.path);
    if (moved !== undefined) {
      files.push({ path: moved, content: file.content });
      continue;
    }
    const item = /^skills\/([^/]+)\//u.exec(file.path)?.[1];
    if (item !== undefined && existingItems.has(item)) {
      keptSkillItems.add(item);
      continue;
    }
    files.push(file);
  }

  let model: AccountModel;
  try {
    model = parseAccountModel({ ...base, machine, credentials, components, profiles, runtimes });
  } catch (error) {
    const first = (error as { issues?: readonly { message: string }[] }).issues?.[0]?.message;
    throw new CloneRefusal(
      `Copying the setup from ${sourceName} would leave ${options.machine} with a setup it cannot read${first === undefined ? '' : `: ${first}`}. Nothing was changed. Fix that on ${options.machine} (Settings › Machine), or copy again with the other choice for its existing setup.`,
    );
  }

  const held = new Set(options.existingSecrets);
  // An environment login is copied whole, so what it needs is said rather than left as an empty slot.
  const environmentLogins = bundle.credentials.filter(credential => credential.store === 'environment');
  const missingSecrets = [
    ...new Set([
      ...secretReferencesIn(JSON.stringify(source.components)),
      ...environmentLogins.flatMap(credential =>
        secretReferencesIn(JSON.stringify([credential.env ?? {}, credential.claude ?? {}, credential.codex ?? {}])),
      ),
    ]),
  ].filter(name => !held.has(name));
  const references = environmentLogins.flatMap(credential => {
    const reference =
      credential.cloudCredential === undefined ? undefined : parseCloudCredential(credential.cloudCredential);
    if (reference === undefined || credential.cloudCredential === undefined) return [];
    return [
      {
        login: credentialIds.get(credential.id) as string,
        reference: credential.cloudCredential,
        sentence: cloudCredentialSentence(reference),
      },
    ];
  });
  const environmentIds = new Set(environmentLogins.map(credential => credentialIds.get(credential.id)));
  const descriptors = new Map(bundle.credentials.map(credential => [credentialIds.get(credential.id), credential]));
  const slots: CloneSlot[] = [...credentialIds.values()]
    .filter(id => !environmentIds.has(id))
    .map(id => {
      const descriptor = descriptors.get(id);
      return {
        id,
        harness: (credentials[id] as Credential).harness,
        ...(descriptor?.label === undefined ? {} : { label: descriptor.label }),
        ...(descriptor?.email === undefined ? {} : { email: descriptor.email }),
        runtimes: slotRuntimes.get(id) ?? [],
      };
    });

  return {
    model,
    files,
    renamed,
    slots,
    checkPaths,
    missingHarnesses: [...missingHarnesses].toSorted(),
    missingSecrets,
    references,
    keptSkillItems: [...keptSkillItems].toSorted(),
    copied: {
      components: countComponents(source.components, NON_MODEL_KINDS),
      modelSets: Object.keys(source.components.modelSets).length,
      profiles: Object.keys(source.profiles).length,
      runtimes: Object.keys(source.runtimes).length,
    },
    removed: replace
      ? {
          components: countComponents(target.components, COMPONENT_KINDS),
          profiles: Object.keys(target.profiles).length,
          runtimes: Object.keys(target.runtimes).length,
        }
      : { components: 0, profiles: 0, runtimes: 0 },
    notCopied: bundle.notCopied,
    runnables: cloneRunnables(bundle).map(runnable => {
      const reference = componentNames.get(runnable.reference) as string;
      return { ...runnable, reference, name: reference.slice(runnable.kind.length + 1) };
    }),
    skipped,
    defaultRuntime,
  };
}

/**
 * "Default runtime for new agents" once the copy is applied. It must name an AGENT runtime that exists,
 * and Replace removes the target's own runtimes while the machine settings stay, so a default left alone
 * would name a runtime that is gone. The person's choice wins; otherwise the target's own default stays
 * when it is still there; otherwise the copy picks one of the same family ({@link suggestCloneDefault})
 * and the plan says so. It never drops a default silently and never writes one that cannot resolve.
 */
function defaultAfterCopy(input: {
  readonly base: AccountModel;
  readonly runtimes: Readonly<Record<string, Runtime>>;
  readonly runtimeNames: ReadonlyMap<string, string>;
  readonly copiedAgents: readonly CloneAgentRuntime[];
  readonly sourceName: string;
  readonly requested: string | null | undefined;
}): { readonly machine: AccountModel['machine']; readonly defaultRuntime: CloneDefault } {
  const { base, runtimes, runtimeNames, copiedAgents, sourceName, requested } = input;
  const { defaultRuntime: _current, ...rest } = base.machine;
  const without = rest as AccountModel['machine'];
  if (requested === null) return { machine: without, defaultRuntime: { kind: 'unset' } };
  if (requested !== undefined) {
    const landed = runtimeNames.get(requested);
    if (landed === undefined || !copiedAgents.some(agent => agent.name === requested)) {
      throw new CloneRefusal(
        `${requested} can't be the default runtime: the setup from ${sourceName} has no agent runtime by that name (${copiedAgents.map(agent => agent.name).join(', ') || 'it has none'}). Pick another one.`,
      );
    }
    return { machine: { ...without, defaultRuntime: landed }, defaultRuntime: { kind: 'chosen', runtime: landed } };
  }
  const current = base.machine.defaultRuntime;
  if (current === undefined) return { machine: without, defaultRuntime: { kind: 'none' } };
  if (runtimes[current]?.agent === true)
    return { machine: base.machine, defaultRuntime: { kind: 'kept', runtime: current } };
  const droppedHarness =
    base.runtimes[current] === undefined ? undefined : runtimeHarness(base, base.runtimes[current]);
  const picked = suggestCloneDefault({ candidates: copiedAgents, droppedHarness });
  const now = picked === undefined ? undefined : runtimeNames.get(picked);
  return {
    machine: now === undefined ? without : { ...without, defaultRuntime: now },
    defaultRuntime: { kind: 'repaired', was: current, ...(now === undefined ? {} : { now }) },
  };
}

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

/** One thing a copied component runs, as one line; a whole document follows on its own lines, indented. */
function runnableLine(reference: string, entry: CloneRunnable['entries'][number]): string {
  if (!entry.document) return `Runs: ${reference} — ${entry.label}: ${entry.text}`;
  const body = entry.text.replace(/\n$/u, '').split('\n');
  return [
    `Runs: ${reference} — ${entry.label}, ${plural(body.length, 'line')}:`,
    ...body.map(line => `  ${line}`),
  ].join('\n');
}

function defaultSentence(outcome: CloneDefault, machine: string): string | undefined {
  switch (outcome.kind) {
    case 'chosen':
      return `Default runtime for new agents on ${machine}: ${outcome.runtime}.`;
    case 'unset':
      return `Default runtime for new agents on ${machine}: none. Pick one in Settings › Machine before starting an agent without naming a runtime.`;
    case 'repaired':
      return outcome.now === undefined
        ? `${machine}'s default runtime for new agents (${outcome.was}) is replaced by this copy and the copy has no agent runtime to take its place, so it is left unset.`
        : `${machine}'s default runtime for new agents (${outcome.was}) is replaced by this copy, so new agents start on ${outcome.now} instead. Change it in the preview if you want another.`;
    default:
      return undefined;
  }
}

/** What applying the copy would do, as the confirm card says it (§4.7 Preview and Done). */
export function describeClone(
  plan: ClonePlan,
  bundle: FleetCloneBundle,
  machine: string,
  sourceName: string = bundle.machine,
): readonly string[] {
  const lines: string[] = [];
  if (plan.removed.runtimes + plan.removed.profiles + plan.removed.components > 0) {
    lines.push(
      `Replaces what ${machine} has: ${plural(plan.removed.components, 'component')}, ${plural(plan.removed.profiles, 'profile')} and ${plural(plan.removed.runtimes, 'runtime')} go first. Its logins stay.`,
    );
  }
  lines.push(
    `Copies ${plural(plan.copied.components, 'component')}, ${plural(plan.copied.modelSets, 'model set')}, ${plural(plan.copied.profiles, 'profile')} and ${plural(plan.copied.runtimes, 'runtime')} from ${sourceName}.`,
  );
  for (const reference of plan.skipped) lines.push(`Leaves out ${reference}: you chose not to copy it.`);
  if (plan.runnables.length > 0) {
    lines.push(
      `${plural(plan.runnables.length, 'component')} from ${sourceName} can make ${machine} run something: MCP servers, hooks and settings start programs when an agent launches, and instructions and skills are text an agent follows. Everything each one carries is listed here; leave out any you don’t trust.`,
    );
  }
  for (const runnable of plan.runnables) {
    for (const entry of runnable.entries) lines.push(runnableLine(runnable.reference, entry));
  }
  if (plan.slots.length > 0) {
    const slots = plan.slots
      .map(slot => `${slot.email ?? slot.label ?? slot.id} (used by ${plural(slot.runtimes.length, 'runtime')})`)
      .join(', ');
    lines.push(
      `Doesn't copy ${plural(plan.slots.length, 'login')}: each becomes an empty slot on ${machine} that needs sign-in, and its runtimes keep pointing at it — ${slots}.`,
    );
  }
  lines.push(`Doesn't copy history: past sessions stay on ${sourceName}.`);
  const runtimeRenames = plan.renamed.filter(rename => rename.what !== 'login');
  if (runtimeRenames.length > 0) {
    lines.push(
      `${plural(runtimeRenames.length, 'name')} already used here got a new one: ${runtimeRenames.map(rename => `${rename.from} → ${rename.to}`).join(', ')}.`,
    );
  }
  const chosen = defaultSentence(plan.defaultRuntime, machine);
  if (chosen !== undefined) lines.push(chosen);
  for (const check of plan.checkPaths) lines.push(`Check after copying: ${check.reference} names ${check.path}.`);
  for (const harness of plan.missingHarnesses) {
    lines.push(
      `${HARNESS_DISPLAY_NAMES[harness]} isn't installed on ${machine}: its runtimes are copied and wait for it.`,
    );
  }
  if (plan.missingSecrets.length > 0) {
    lines.push(
      `${machine}'s secret store has no ${plan.missingSecrets.join(', ')}: add ${plan.missingSecrets.length === 1 ? 'it' : 'them'} before those runtimes launch.`,
    );
  }
  for (const reference of plan.references) {
    lines.push(
      `Login ${reference.login} uses ${reference.sentence.replace('this machine', machine)} (${reference.reference}). A reference is never copied: set it up on ${machine} before its runtimes launch.`,
    );
  }
  for (const item of plan.keptSkillItems)
    lines.push(`Skill ${item} is already on ${machine}, so its copy there was kept.`);
  for (const entry of plan.notCopied) lines.push(`Not copied: ${entry.path} (${entry.reason}).`);
  return lines;
}

/**
 * An environment login as the bundle carries it (docs/provider-presets.md): exactly what its file holds.
 * No file may hold a raw key, so `env` is plain values and `${secret:NAME}` references only.
 */
function environmentDescriptor(credential: Credential): Partial<FleetCloneCredential> {
  return {
    store: 'environment',
    ...(credential.env === undefined ? {} : { env: { ...credential.env } }),
    ...(credential.preset === undefined ? {} : { preset: credential.preset }),
    ...(credential.cloudCredential === undefined ? {} : { cloudCredential: credential.cloudCredential }),
    ...(credential.codexProvider === undefined ? {} : { codexProvider: { ...credential.codexProvider } }),
    ...(credential.claude === undefined ? {} : { claude: structuredClone(credential.claude) }),
    ...(credential.codex === undefined ? {} : { codex: structuredClone(credential.codex) }),
  };
}

/** An environment login on the target, from its descriptor. The model's own parse checks every field. */
function environmentCredential(descriptor: FleetCloneCredential): Record<string, unknown> {
  return {
    harness: descriptor.harness,
    store: 'environment',
    ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
    ...(descriptor.env === undefined ? {} : { env: { ...descriptor.env } }),
    ...(descriptor.preset === undefined ? {} : { preset: descriptor.preset }),
    ...(descriptor.cloudCredential === undefined ? {} : { cloudCredential: descriptor.cloudCredential }),
    ...(descriptor.codexProvider === undefined ? {} : { codexProvider: { ...descriptor.codexProvider } }),
    ...(descriptor.claude === undefined ? {} : { claude: structuredClone(descriptor.claude) }),
    ...(descriptor.codex === undefined ? {} : { codex: structuredClone(descriptor.codex) }),
  };
}
