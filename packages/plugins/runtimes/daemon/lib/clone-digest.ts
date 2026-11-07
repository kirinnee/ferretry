/**
 * The content digest of one copied item (docs/design/account-model.md §3.8 "Origin keys").
 *
 * Two ends of a copy must agree on whether an item is "the same thing": the source, to let a renamed
 * item keep its origin key, and the target (and the app) to hide what has not changed. So the function
 * is ONE pure function here, in the package every end already imports, built on the hash the protocol
 * already owns ({@link sha256Hex}, synchronous and dependency-free, so it runs in a browser too) and on
 * the one canonical JSON ({@link canonicalJson}).
 *
 * What goes in — every field that can make the target run something:
 *
 * - the item WITHOUT provenance (`clonedFrom`, `clonedFromDaemon`, `clonedFromKey`, `installedFrom`):
 *   where it came from changes nothing it does;
 * - `file` and `directory` REPLACED BY THEIR CONTENTS, as sorted `[relativePath, sha256(content)]`
 *   pairs, so a folder that was renamed to `guard-2` here still compares equal, and one changed byte
 *   in one script does not. A document the bundle did not carry (outside the asset tree, or dropped by
 *   the size budget) has no contents to stand for it, so its literal path stays in the digest instead:
 *   re-pointing a hook at another script is a change;
 * - a skills component's items, each with its files the same way;
 * - a profile's layers as IDENTITIES, in order (order is what the harness reads), with its `compactAt`;
 * - a runtime as `{ login identity, profile identity, agent, harness, compactAt }`. Whether it is switched
 *   off (`disabled`) is the machine's own say, so it is not a difference between two machines.
 *
 * What a name is not: an item's own name is not inside its digest, so renaming it is not a change.
 */
import { canonicalJson } from '@ferretry/std';
import { CLONE_PROVENANCE_FIELDS, CLONE_SKILLS_DIRECTORY, type CloneFile } from '../../contract/index.ts';
import { sha256Hex } from './foreign.ts';


/** What a digest is taken of: a component of one kind, a profile, a runtime or a login descriptor. */
export type CloneDigestKind =
  | 'instructions'
  | 'mcp'
  | 'skills'
  | 'settings'
  | 'hooks'
  | 'modelSets'
  | 'profile'
  | 'runtime'
  | 'login';

export interface CloneDigestItem {
  readonly kind: CloneDigestKind;
  /** The item as the configuration (or the bundle) holds it. */
  readonly value: Readonly<Record<string, unknown>>;
}

/**
 * Names a layer, a profile or a login by the identity a digest should hold: its origin key when it has
 * one, else the reference itself. References are `<kind>/<name>`, `profile/<name>` and `login/<id>`.
 */
export type CloneIdentityOf = (reference: string) => string;

const referenceItself: CloneIdentityOf = reference => reference;

/** One asset path in its plain spelling (`./a//b/` → `a/b`), the spelling a bundle carries paths in. */
const plain = (path: string): string =>
  path
    .split('/')
    .filter(part => part !== '' && part !== '.')
    .join('/');

type ContentPairs = readonly (readonly [string, string | null])[];

interface DocumentIndex {
  readonly byPath: ReadonlyMap<string, string>;
  /** Sorted, so a directory read is a prefix scan in one order. */
  readonly sorted: readonly (readonly [string, string])[];
}

const indexes = new WeakMap<readonly CloneFile[], DocumentIndex>();

const indexOf = (documents: readonly CloneFile[]): DocumentIndex => {
  const known = indexes.get(documents);
  if (known !== undefined) return known;
  const byPath = new Map<string, string>();
  for (const file of documents) {
    const path = plain(file.path);
    if (!byPath.has(path)) byPath.set(path, file.content);
  }
  const index = { byPath, sorted: [...byPath].toSorted((left, right) => (left[0] < right[0] ? -1 : 1)) };
  indexes.set(documents, index);
  return index;
};

/** Spelled outside the asset tree: absolute, or under the home folder. Such a path is never carried. */
const outsideAssets = (path: string): boolean => path.startsWith('/') || path.startsWith('~');

/** A document's contents as one pair, or its literal path when the bundle did not carry it. */
const fileContents = (index: DocumentIndex, path: string): ContentPairs | { readonly uncarried: string } => {
  const content = outsideAssets(path) ? undefined : index.byPath.get(plain(path));
  return content === undefined ? { uncarried: path } : [['', sha256Hex(content)]];
};

/** Every carried file under a folder, relative to it, with its hash; sorted by path. */
const directoryContents = (index: DocumentIndex, path: string): ContentPairs => {
  if (outsideAssets(path)) return [];
  const prefix = `${plain(path)}/`;
  return index.sorted
    .filter(([file]) => file.startsWith(prefix))
    .map(([file, content]) => [file.slice(prefix.length), sha256Hex(content)] as const);
};

/** A folder's carried contents, or its literal path when none of it was carried. */
const folderContents = (index: DocumentIndex, path: string): ContentPairs | { readonly uncarried: string } => {
  const carried = directoryContents(index, path);
  return carried.length === 0 ? { uncarried: path } : carried;
};

const withoutProvenance = (value: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const own: Record<string, unknown> = { ...value };
  for (const field of CLONE_PROVENANCE_FIELDS) delete own[field];
  return own;
};

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** A component with its documents replaced by what they hold. */
const componentContent = (
  kind: CloneDigestKind,
  value: Record<string, unknown>,
  index: DocumentIndex,
): Record<string, unknown> => {
  const content: Record<string, unknown> = { ...value };
  if (typeof value.file === 'string') content.file = fileContents(index, value.file);
  if (typeof value.directory === 'string') content.directory = folderContents(index, value.directory);
  if (kind === 'skills' && Array.isArray(value.items)) {
    content.items = strings(value.items).map(item => ({
      item,
      files: directoryContents(index, `${CLONE_SKILLS_DIRECTORY}/${item}`),
    }));
  }
  return content;
};

const normalised = (
  item: CloneDigestItem,
  index: DocumentIndex,
  identityOf: CloneIdentityOf,
): Record<string, unknown> => {
  const value = withoutProvenance(item.value);
  switch (item.kind) {
    case 'profile':
      return { ...value, layers: strings(value.layers).map(layer => identityOf(layer)) };
    case 'runtime':
      return {
        login: identityOf(`login/${String(value.credential)}`),
        profile: identityOf(`profile/${String(value.profile)}`),
        agent: value.agent === true,
        harness: value.harness,
        compactAt: value.compactAt,
      };
    case 'login': {
      // A login's id is only how this machine files it; what it signs in with is everything else.
      const { id: _id, ...descriptor } = value;
      return descriptor;
    }
    default:
      return componentContent(item.kind, value, index);
  }
};

/** Keys sorted, `undefined` dropped: the same document {@link canonicalJson} writes, for the input it refuses. */
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(record)
      .filter(key => record[key] !== undefined)
      .toSorted()
      .map(key => [key, stable(record[key])]),
  );
};

/**
 * `sha256` (64 lower-case hex digits) of the item as it would run, whatever it is called and wherever
 * it came from. Pure and total: an item the canonical writer refuses (a lone surrogate) is still
 * digested, over a spelling that keeps it apart from every other.
 */
export function cloneItemDigest(
  item: CloneDigestItem,
  documents: readonly CloneFile[],
  identityOf: CloneIdentityOf = referenceItself,
): string {
  const document = {
    format: 'ferretry-clone-item',
    version: 1,
    kind: item.kind,
    item: normalised(item, indexOf(documents), identityOf),
  };
  const written = canonicalJson(document);
  return sha256Hex(written.ok ? written.text : `uncanonical\0${JSON.stringify(stable(document))}`);
}
