/**
 * The components of an import that another plugin OWNS, and how the setup hands them over.
 *
 * Runtimes may not write another plugin's files (`foreignComponentChanges`), so an import that finds MCP servers, skills or
 * settings gives each to the plugin that owns that kind (`ProfileComponentSource.put`), which writes its own file through
 * the kernel's config service. This module is the pure part: which components those are, the document each is handed as,
 * and the model with them taken out (so Runtimes' own files are composed without them) or with a refused one dropped.
 *
 * Hooks are never handed over and never kept: the import brings none ({@link withoutHookChanges}).
 *
 * Nothing here holds a value: a document is the component in the model's shape, whose `env` entries are plain values or
 * `${secret:NAME}` references exactly as the import made them.
 */
import type { HarnessKind } from '../manifest.ts';
import { parseSettings } from '../settings.ts';
import { foreignComponentRefs } from './runtimes-edits.ts';
import type { AccountModel, LayerReferenceText } from './schema.ts';

/** The kinds an owner writes for an import. `hooks` is deliberately absent. */
const OWNER_KINDS: ReadonlySet<string> = new Set(['mcp', 'skills', 'settings']);

type OwnerKind = 'mcp' | 'skills' | 'settings';

/** One component to hand to its owner: what it is, where the owner's file is, and the document (or why there is none). */
export interface OwnerComponentWrite {
  readonly kind: OwnerKind;
  readonly name: string;
  /** `kind/name`: the layer reference a profile names it by. */
  readonly reference: LayerReferenceText;
  /** The harness a `settings` component is for. */
  readonly harness?: HarnessKind;
  /** The owner's own file, for a sentence: `mcp/github.yaml`. */
  readonly file: string;
  /** The document the owner is given, or `undefined` when it could not be made (`problem` says why). */
  readonly text?: string;
  readonly problem?: string;
  /** A skills component's files (`<item>/<rel>`), which its owner installs: Runtimes writes none of them itself. */
  readonly files?: readonly { readonly path: string; readonly content: string }[];
  /** An update the person accepted: the owner replaces its existing item (never set for a first import). */
  readonly replace?: true;
  /** With `replace`: the owner's own items an earlier import created through this component. */
  readonly owned?: readonly string[];
  /** Hidden files (a path segment starting with a dot) the import carried but does NOT hand over: the answer names them. */
  readonly skipped?: readonly string[];
}

/** What a write is, as one string, for the fingerprint of an import: the document, or why there is none, and the files. */
export const handedText = (write: OwnerComponentWrite): string =>
  `${write.file}\n${write.text ?? write.problem ?? ''}\n${JSON.stringify(write.files ?? [])}`;

/**
 * The components a change adds or changes that an owner writes, plus every one in `touched` (`kind/name`): an accepted
 * update whose SOURCE changed (a skill's files) while its selection is the same value still has to reach its owner.
 */
function changedRefs(
  before: AccountModel,
  next: AccountModel,
  touched: readonly string[],
): readonly { readonly kind: string; readonly name: string }[] {
  const changed: { kind: string; name: string }[] = [...foreignComponentRefs(before, next)];
  for (const reference of touched) {
    const [kind = '', name = ''] = reference.split('/');
    if (changed.some(ref => ref.kind === kind && ref.name === name)) continue;
    if (OWNER_KINDS.has(kind) && next.components[kind as OwnerKind][name] !== undefined) changed.push({ kind, name });
  }
  return changed;
}

const SETTINGS_FORMAT = { claude: 'json', codex: 'toml' } as const satisfies Record<HarnessKind, 'json' | 'toml'>;
const SETTINGS_DIRECTORY = { claude: 'claude-code', codex: 'codex' } as const satisfies Record<HarnessKind, string>;

/** Whether any segment of a path starts with a dot: a hidden file or folder never crosses to an owner. */
const isHidden = (path: string): boolean => path.split('/').some(segment => segment.startsWith('.'));

/** Where an item's files sit among the assets an import carries. */
export const skillAssetPrefix = (item: string): string => `skills/${item}/`;

const documentText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The components `next` adds or changes against `before` that an owner writes, each with the document it is handed.
 * `assetText` reads a text file the import carries (a settings component's `file`), which becomes the owner's document
 * itself: the owner's file stands alone, with no asset path behind it. `assetFiles` lists the files the import carries under
 * a path prefix: a skills component is handed the files of each of its items.
 */
export function ownerWrites(
  before: AccountModel,
  next: AccountModel,
  assetText: (file: string) => string | undefined,
  assetFiles: (prefix: string) => readonly { readonly path: string; readonly content: string }[] = () => [],
  touched: readonly string[] = [],
  ownedOf: (reference: string) => readonly string[] = () => [],
): readonly OwnerComponentWrite[] {
  const writes: OwnerComponentWrite[] = [];
  for (const { kind, name } of changedRefs(before, next, touched)) {
    const replaces = (reference: string) =>
      touched.includes(reference) ? { replace: true as const, owned: ownedOf(reference) } : {};
    if (!OWNER_KINDS.has(kind)) continue;
    const ownerKind = kind as OwnerKind;
    const value: unknown = next.components[ownerKind][name];
    // A component the change drops is not an import's act: nothing is handed over, and the owner keeps its file.
    if (value === undefined) continue;
    const reference = `${ownerKind}/${name}` as LayerReferenceText;
    if (ownerKind !== 'settings') {
      const items = ownerKind === 'skills' ? (next.components.skills[name]?.items ?? []) : [];
      const carried = items.flatMap(item =>
        assetFiles(skillAssetPrefix(item)).map(asset => ({
          path: `${item}/${asset.path.slice(skillAssetPrefix(item).length)}`,
          content: asset.content,
        })),
      );
      const files = carried.filter(file => !isHidden(file.path));
      const skipped = carried.filter(file => isHidden(file.path)).map(file => file.path);
      writes.push({
        kind: ownerKind,
        name,
        reference,
        file: `${ownerKind}/${name}.yaml`,
        ...replaces(reference),
        text: documentText(value),
        ...(ownerKind === 'skills' ? { files, ...(skipped.length === 0 ? {} : { skipped }) } : {}),
      });
      continue;
    }
    const settings = value as { readonly harness: HarnessKind; readonly file?: string } & Record<string, unknown>;
    const file = `${SETTINGS_DIRECTORY[settings.harness]}/settings/${name}.yaml`;
    const base = { kind: ownerKind, name, reference, harness: settings.harness, file, ...replaces(reference) } as const;
    if (settings.file === undefined) {
      writes.push({ ...base, text: documentText(value) });
      continue;
    }
    const body = assetText(settings.file);
    if (body === undefined) {
      writes.push({ ...base, problem: 'the settings this was made from could not be read' });
      continue;
    }
    try {
      const { file: _file, ...rest } = settings;
      writes.push({
        ...base,
        text: documentText({ ...rest, document: parseSettings(body, SETTINGS_FORMAT[settings.harness]) }),
      });
    } catch {
      writes.push({ ...base, problem: 'the settings this was made from are not valid' });
    }
  }
  return writes;
}

/** A copy of `model` with the named components holding what `before` had (or absent, when it had none). */
export function withComponentsOf(
  model: AccountModel,
  before: AccountModel,
  references: readonly { readonly kind: OwnerKind; readonly name: string }[],
): AccountModel {
  const components: Record<string, Record<string, unknown>> = Object.fromEntries(
    Object.entries(model.components).map(([kind, entries]) => [kind, { ...(entries as Record<string, unknown>) }]),
  );
  for (const { kind, name } of references) {
    const was: unknown = before.components[kind][name];
    const entries = components[kind] ?? {};
    components[kind] = entries;
    if (was === undefined) delete entries[name];
    else entries[name] = was;
  }
  return { ...model, components: components as unknown as AccountModel['components'] };
}

/**
 * A copy of `model` with the named components reverted to `before` (an owner refused them), and without any profile layer
 * that names one `before` did not have: a profile never names a component that does not exist.
 */
export function revertComponents(
  model: AccountModel,
  before: AccountModel,
  references: readonly { readonly kind: OwnerKind; readonly name: string }[],
): AccountModel {
  const reverted = withComponentsOf(model, before, references);
  const gone = new Set<string>(
    references
      .filter(({ kind, name }) => before.components[kind][name] === undefined)
      .map(({ kind, name }) => `${kind}/${name}`),
  );
  if (gone.size === 0) return reverted;
  return {
    ...reverted,
    profiles: Object.fromEntries(
      Object.entries(reverted.profiles).map(([name, profile]) => [
        name,
        { ...profile, layers: profile.layers.filter(layer => !gone.has(layer)) },
      ]),
    ),
  };
}

/**
 * `next` with every hooks component as `before` had it, and no profile layer naming a hooks component `before` lacked.
 * A second guard behind the import planner: whatever it hands over, no hook is added or changed here.
 */
export function withoutHookChanges(before: AccountModel, next: AccountModel): AccountModel {
  const known = new Set(Object.keys(before.components.hooks));
  const unknownHook = (layer: string): boolean =>
    layer.startsWith('hooks/') && !known.has(layer.slice('hooks/'.length));
  const changed = foreignComponentRefs(before, next).some(({ kind }) => kind === 'hooks');
  const layered = Object.values(next.profiles).some(profile => profile.layers.some(unknownHook));
  if (!changed && !layered) return next;
  return {
    ...next,
    components: { ...next.components, hooks: before.components.hooks },
    profiles: Object.fromEntries(
      Object.entries(next.profiles).map(([name, profile]) => [
        name,
        { ...profile, layers: profile.layers.filter(layer => !unknownHook(layer)) },
      ]),
    ),
  };
}

/** The references of the components an owner writes (the same set {@link ownerWrites} answers, without their documents). */
export function ownerReferences(
  before: AccountModel,
  next: AccountModel,
  touched: readonly string[] = [],
): readonly { readonly kind: OwnerKind; readonly name: string }[] {
  return changedRefs(before, next, touched).filter(
    (ref): ref is { kind: OwnerKind; name: string } =>
      OWNER_KINDS.has(ref.kind) && next.components[ref.kind as OwnerKind][ref.name] !== undefined,
  );
}

/** What the owner of a kind answered to one write: written, held for confirmation, or refused in a sentence. */
export type OwnerWriteOutcome =
  | { readonly outcome: 'written'; readonly warnings?: readonly string[]; readonly created?: readonly string[] }
  | { readonly outcome: 'held'; readonly warnings?: readonly string[]; readonly created?: readonly string[] }
  | { readonly outcome: 'refused'; readonly reason: string };

/** The door the setup hands an imported component to its owner through (`daemon/adapters/component-writers.ts`). */
export interface ComponentWriter {
  /** Never throws: an owner that is off, slow, offers no write or refuses is a `refused` outcome. */
  put(write: OwnerComponentWrite & { readonly text: string }): Promise<OwnerWriteOutcome>;
}

/**
 * A copy of `model` whose named components are what the owners REPORT as in effect (`effective`, read after they wrote),
 * not what the import asked for: an owner may have narrowed a document, held it, or taken it as it already stood. A
 * component the owners do not have in effect is left out, and so is every profile layer that names it, in this model only
 * (the profile FILES keep a held one's layer, so confirming it completes them).
 */
export function withEffective(
  model: AccountModel,
  effective: AccountModel,
  references: readonly { readonly kind: OwnerKind; readonly name: string }[],
): AccountModel {
  const components: Record<string, Record<string, unknown>> = Object.fromEntries(
    Object.entries(model.components).map(([kind, entries]) => [kind, { ...(entries as Record<string, unknown>) }]),
  );
  const absent = new Set<string>();
  for (const { kind, name } of references) {
    const reported: unknown = effective.components[kind][name];
    const entries = components[kind] ?? {};
    components[kind] = entries;
    if (reported === undefined) {
      delete entries[name];
      absent.add(`${kind}/${name}`);
    } else entries[name] = reported;
  }
  const next = { ...model, components: components as unknown as AccountModel['components'] };
  if (absent.size === 0) return next;
  return {
    ...next,
    profiles: Object.fromEntries(
      Object.entries(next.profiles).map(([name, profile]) => [
        name,
        { ...profile, layers: profile.layers.filter(layer => !absent.has(layer)) },
      ]),
    ),
  };
}
