/**
 * The parts of a copy the first copy ({@link ./clone.ts}) and a repeat copy ({@link ./clone-update.ts})
 * share: reading a bundle as a model, where a renamed document lands, and what a path is.
 */
import { isAbsolute, normalize, relative } from 'node:path';
import type { CloneBundle, CloneCredential } from '../../../contract/index.ts';
import { canonicalAssetReference, expandAssetPath } from '../paths.ts';
import { harnessKindOfKey } from '../manifest.ts';
import { freeName } from './import.ts';
import { type AccountModel, type ComponentKind, type Credential, parseAccountModel } from './schema.ts';

/** Why a bundle cannot be copied. The message is the sentence a person reads. */
export class CloneRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloneRefusal';
  }
}

/** Whether a configured path is inside the asset tree, and so can travel as a document. */
export const isAssetRelative = (file: string): boolean =>
  !file.startsWith('/') && !file.startsWith('~') && !file.startsWith('$') && !file.split('/').includes('..');

/** Where this machine's asset tree and the person's home are, so an alias can be read as the asset path it is. */
export interface AssetRoots {
  readonly userHome: string;
  readonly assetsDirectory: string;
}

/**
 * The asset tree itself, as {@link assetReference} spells it. An item that names it owns every path in the
 * tree, so nothing written anywhere in it can leave that item as it was.
 */
export const ASSET_ROOT = '.';

/** A leading `~` or `$` that is not the person's home: a root nothing here can resolve. */
const UNKNOWN_ROOT = /^(?:~(?!\/|$)|\$(?!HOME(?:\/|$)))/u;

/**
 * One canonical asset-relative spelling of a configured path, {@link ASSET_ROOT} for the asset tree itself,
 * or `undefined` when it is not inside the asset tree. `components/x`, `../assets/components/x` (from the
 * assets directory), `/state/fleet/assets/components/x` and `~/…/components/x` (when the home is the assets
 * directory's ancestor) are one folder, read exactly as {@link expandAssetPath} reads them, and ownership,
 * the review and the write all go by that one spelling.
 */
export function assetReference(path: string, roots: AssetRoots): string | undefined {
  if (UNKNOWN_ROOT.test(path)) return undefined;
  const absolute = expandAssetPath(path, roots.userHome, roots.assetsDirectory);
  const inside = relative(normalize(roots.assetsDirectory), absolute);
  if (inside === '') return ASSET_ROOT;
  if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) return undefined;
  return canonicalAssetReference(inside).replace(/\/+$/u, '');
}

/** A path under a person's home on macOS or Linux, as it appears in text. */
export const HOME_PATH = /\/(?:Users|home)\/[^\s"'`,;)}\]]+/u;

export type MutableComponents = Record<ComponentKind, Record<string, Record<string, unknown>>>;

export const countComponents = (components: AccountModel['components'], kinds: readonly ComponentKind[]): number =>
  kinds.reduce((total, kind) => total + Object.keys(components[kind]).length, 0);

/** The bundle as a model of its own, so a damaged one is refused before anything is renamed. */
export function bundleModel(bundle: CloneBundle, sourceName: string): AccountModel {
  const credentials: Record<string, Credential> = {};
  for (const credential of bundle.credentials) {
    // An environment login keeps its halves, so a runtime on its Codex half still reads as one.
    credentials[credential.id] =
      credential.store === 'environment'
        ? (environmentCredential(credential) as Credential)
        : { harness: harnessKindOfKey(credential.harness), store: 'ferretry' };
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

/** Whether two asset paths are the same or one sits inside the other, by whole path segments. The tree holds all. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a === ASSET_ROOT || b === ASSET_ROOT || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * The sentence for a write that has nowhere to go: an item here owns the whole asset tree, so every path in
 * it is that item's and no destination leaves it as it was.
 */
export const wholeTreeRefusal = (path: string, owners: readonly string[]): string =>
  `${owners.join(', ')} here ${owners.length === 1 ? 'uses' : 'use'} the whole setup folder, so writing ${path} would change ${owners.length === 1 ? 'it' : 'them'} too. Point ${owners.length === 1 ? 'it' : 'them'} at a folder of ${owners.length === 1 ? 'its' : 'their'} own first, or leave this out.`;

/** No destination is free while an owned path is the whole tree: refuse rather than search for one forever. */
const refuseWholeTree = (path: string, used: ReadonlySet<string>): void => {
  if (used.has(ASSET_ROOT)) throw new CloneRefusal(wholeTreeRefusal(path, ['An item']));
};

/**
 * Whether a destination is free: it is not a path another item here owns, does not sit inside a folder one
 * owns, and does not cover one. `used` holds both documents and folders, so one rule serves both.
 */
const isFree = (used: ReadonlySet<string>, candidate: string): boolean =>
  ![...used].some(path => pathsOverlap(candidate, path));

/**
 * Beside the outermost owned folder that holds `path`, or undefined when none does. Inside an owned folder no
 * sibling name escapes it, so the destination steps out next to that folder and keeps the rest of the path.
 */
function outsideOwner(path: string, used: ReadonlySet<string>): string | undefined {
  const outer = [...used].filter(owned => path.startsWith(`${owned}/`)).toSorted((a, b) => a.length - b.length)[0];
  if (outer === undefined) return undefined;
  const rest = path.slice(outer.length);
  return `${freeName(outer, candidate => !isFree(used, `${candidate}${rest}`))}${rest}`;
}

/**
 * The file a renamed component's document moves to, never a path another item here owns: not the same file,
 * not one inside a folder an item owns, and not a folder that would cover a file an item owns.
 */
export function movedFile(file: string, from: string, to: string, used: ReadonlySet<string>): string {
  if (!isAssetRelative(file)) return file;
  refuseWholeTree(file, used);
  const dot = file.lastIndexOf('.');
  const slash = file.lastIndexOf('/');
  const stem = dot > slash ? file.slice(0, dot) : file;
  const extension = dot > slash ? file.slice(dot) : '';
  const renamedStem = from !== to && stem.endsWith(`/${from}`) ? `${stem.slice(0, -from.length)}${to}` : stem;
  const renamed = `${renamedStem}${extension}`;
  if (isFree(used, renamed)) return renamed;
  const outside = outsideOwner(renamed, used);
  if (outside !== undefined) return outside;
  return `${freeName(renamedStem, candidate => !isFree(used, `${candidate}${extension}`))}${extension}`;
}

/** The folder a renamed component's scripts move to, never one that overlaps a path the target already uses. */
export function movedFolder(folder: string, from: string, to: string, used: ReadonlySet<string>): string {
  refuseWholeTree(folder, used);
  if (isFree(used, folder)) return folder;
  const outside = outsideOwner(folder, used);
  if (outside !== undefined) return outside;
  const renamed = from !== to && folder.endsWith(`/${from}`) ? `${folder.slice(0, -from.length)}${to}` : folder;
  return freeName(renamed, candidate => !isFree(used, candidate));
}

/** Where a carried file lands when a folder above it moved, or undefined when none did. */
export function movedUnderFolder(path: string, folderMoves: ReadonlyMap<string, string>): string | undefined {
  let best: string | undefined;
  for (const [folder, moved] of folderMoves) {
    if (moved === folder || !path.startsWith(`${folder}/`)) continue;
    if (best === undefined || folder.length > best.length) best = folder;
  }
  return best === undefined ? undefined : `${folderMoves.get(best) as string}${path.slice(best.length)}`;
}

/** Every asset-tree document the model's components name. */
export function referencedFiles(model: AccountModel): Set<string> {
  const files = new Set<string>();
  for (const kind of ['instructions', 'settings', 'hooks'] as const) {
    for (const component of Object.values(model.components[kind]) as { file?: string; directory?: string }[]) {
      if (component.file !== undefined) files.add(component.file);
      if (component.directory !== undefined) files.add(component.directory);
    }
  }
  return files;
}

/** An environment login on the target, from its descriptor. The model's own parse checks every field. */
export function environmentCredential(descriptor: CloneCredential): Record<string, unknown> {
  return {
    harness: harnessKindOfKey(descriptor.harness),
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
