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
 * Pure: a model and documents in, a plan out. Reading the source's files and writing the target's
 * are the setup service's.
 */
import {
  FLEET_CLONE_BUNDLE_FORMAT,
  type FleetCloneBundle,
  FleetCloneBundleSchema,
  type FleetCloneFile,
  secretReferencesIn,
} from '@ferretry/protocol';
import type { HarnessKind } from '../manifest.ts';
import { skillSourceReference } from './adapt.ts';
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
      };
    });
  return FleetCloneBundleSchema.parse({
    format: FLEET_CLONE_BUNDLE_FORMAT,
    version: 1,
    machine: input.machine,
    exportedAt: input.exportedAt,
    credentials,
    components: model.components,
    profiles: model.profiles,
    runtimes: model.runtimes,
    files: input.files,
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
}

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
}

/** A path under a person's home on macOS or Linux, as it appears in text. */
const HOME_PATH = /\/(?:Users|home)\/[^\s"'`,;)}\]]+/u;

type MutableComponents = Record<ComponentKind, Record<string, Record<string, unknown>>>;

const countComponents = (components: AccountModel['components'], kinds: readonly ComponentKind[]): number =>
  kinds.reduce((total, kind) => total + Object.keys(components[kind]).length, 0);

const NON_MODEL_KINDS = COMPONENT_KINDS.filter(kind => kind !== 'modelSets');

/** The bundle, refused with a sentence when it is not one. */
export function parseCloneBundle(input: unknown): FleetCloneBundle {
  const parsed = FleetCloneBundleSchema.safeParse(input);
  if (!parsed.success) {
    throw new CloneRefusal(
      'That is not a setup exported by Ferretry, or it was exported by a version this machine cannot read.',
    );
  }
  return parsed.data;
}

/** The bundle as a model of its own, so a damaged one is refused before anything is renamed. */
function bundleModel(bundle: FleetCloneBundle): AccountModel {
  const credentials: Record<string, Credential> = {};
  for (const credential of bundle.credentials) {
    credentials[credential.id] = { harness: credential.harness, store: 'ferretry' };
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
      `The setup from ${bundle.machine} cannot be copied${first === undefined ? '' : `: ${first}`}.`,
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
export function planClone(target: AccountModel, bundle: FleetCloneBundle, options: CloneOptions): ClonePlan {
  const source = bundleModel(bundle);
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
    credentials[id] = {
      harness: credential.harness,
      store: 'ferretry',
      ...(label === undefined ? {} : { label }),
      clonedFrom: bundle.machine,
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
      const copy: Record<string, unknown> = { ...value };
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
  for (const name of Object.keys(source.profiles)) {
    const free = freeName(name, candidate => profiles[candidate] !== undefined || profileNames.has(candidate));
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
  const slotRuntimes = new Map<string, string[]>();
  const missingHarnesses = new Set<HarnessKind>();
  const commandNames = new Set(base.advanced.commands.map(command => command.wrapper));
  for (const [name, runtime] of Object.entries(source.runtimes)) {
    const free = freeName(name, candidate => runtimes[candidate] !== undefined || commandNames.has(candidate));
    if (free !== name) renamed.push({ what: 'runtime', from: name, to: free });
    const credential = credentialIds.get(runtime.credential) as string;
    runtimes[free] = { credential, profile: profileNames.get(runtime.profile) as string, agent: runtime.agent };
    slotRuntimes.set(credential, [...(slotRuntimes.get(credential) ?? []), free]);
    const harness = source.credentials[runtime.credential]?.harness as HarnessKind;
    if (!options.installed.includes(harness)) missingHarnesses.add(harness);
  }

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
    model = parseAccountModel({ ...base, credentials, components, profiles, runtimes });
  } catch (error) {
    const first = (error as { issues?: readonly { message: string }[] }).issues?.[0]?.message;
    throw new CloneRefusal(
      `Copying the setup from ${bundle.machine} would leave ${options.machine} with a setup it cannot read${first === undefined ? '' : `: ${first}`}.`,
    );
  }

  const held = new Set(options.existingSecrets);
  const missingSecrets = secretReferencesIn(JSON.stringify(source.components)).filter(name => !held.has(name));
  const descriptors = new Map(bundle.credentials.map(credential => [credentialIds.get(credential.id), credential]));
  const slots: CloneSlot[] = [...credentialIds.values()].map(id => {
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
    missingSecrets: [...missingSecrets],
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
  };
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** What applying the copy would do, as the confirm card says it (§4.7 Preview and Done). */
export function describeClone(plan: ClonePlan, bundle: FleetCloneBundle, machine: string): readonly string[] {
  const lines: string[] = [];
  if (plan.removed.runtimes + plan.removed.profiles + plan.removed.components > 0) {
    lines.push(
      `Replaces what ${machine} has: ${plural(plan.removed.components, 'component')}, ${plural(plan.removed.profiles, 'profile')} and ${plural(plan.removed.runtimes, 'runtime')} go first. Its logins stay.`,
    );
  }
  lines.push(
    `Copies ${plural(plan.copied.components, 'component')}, ${plural(plan.copied.modelSets, 'model set')}, ${plural(plan.copied.profiles, 'profile')} and ${plural(plan.copied.runtimes, 'runtime')} from ${bundle.machine}.`,
  );
  if (plan.slots.length > 0) {
    const slots = plan.slots
      .map(slot => `${slot.email ?? slot.label ?? slot.id} (used by ${plural(slot.runtimes.length, 'runtime')})`)
      .join(', ');
    lines.push(
      `Doesn't copy ${plural(plan.slots.length, 'login')}: each becomes an empty slot on ${machine} that needs sign-in, and its runtimes keep pointing at it — ${slots}.`,
    );
  }
  lines.push(`Doesn't copy history: past sessions stay on ${bundle.machine}.`);
  const runtimeRenames = plan.renamed.filter(rename => rename.what !== 'login');
  if (runtimeRenames.length > 0) {
    lines.push(
      `${plural(runtimeRenames.length, 'name')} already used here got a new one: ${runtimeRenames.map(rename => `${rename.from} → ${rename.to}`).join(', ')}.`,
    );
  }
  for (const check of plan.checkPaths) lines.push(`Check after copying: ${check.reference} names ${check.path}.`);
  for (const harness of plan.missingHarnesses) {
    lines.push(`${HARNESS_DISPLAY_NAMES[harness]} isn't installed on ${machine}: its runtimes are copied and wait for it.`);
  }
  if (plan.missingSecrets.length > 0) {
    lines.push(
      `${machine}'s secret store has no ${plan.missingSecrets.join(', ')}: add ${plan.missingSecrets.length === 1 ? 'it' : 'them'} before those runtimes launch.`,
    );
  }
  for (const item of plan.keptSkillItems) lines.push(`Skill ${item} is already on ${machine}, so its copy there was kept.`);
  for (const entry of plan.notCopied) lines.push(`Not copied: ${entry.path} (${entry.reason}).`);
  return lines;
}
