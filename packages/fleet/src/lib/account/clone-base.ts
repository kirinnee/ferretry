/**
 * The "last copied" record — `<FY_HOME>/fleet/setup/clone-base.json` (docs/design/account-model.md §3.8,
 * docs/cross-daemon.md §3c).
 *
 * A repeat copy from a machine this one already copied from has to know what the source looked like
 * LAST time, or it cannot tell "they changed it" from "I changed it". This record is that memory: per
 * source machine and per copied item, the digest, size and paths of what the source held at the last copy.
 *
 * - **No content, no secret value, no digest of a secret.** Digests of configuration and documents,
 *   sizes, paths and timestamps — nothing a person could read a setup back out of.
 * - **Computed here, never taken from the bundle.** A digest is {@link cloneItemDigest} over the bundle's
 *   own documents, so a lying source cannot plant a base.
 * - **State, not configuration.** Unreadable or invalid text is treated as absent ({@link parseCloneBase});
 *   it never blocks a copy, and the next apply writes a fresh one.
 * - **Written with the copy, never alone.** The setup service puts it in the same document batch as the
 *   copy, so it can never claim a copy that did not land. {@link applyCloneToBase} is the pure half: what
 *   the record becomes once a copy of one source lands.
 *
 * Garbage collection runs on every copy from that source: an entry whose item is gone on both sides is
 * dropped; a source nothing here links to any more is dropped whole; past {@link CLONE_BASE_SOURCES_LIMIT}
 * sources the one copied longest ago goes. A Replace rewrites the source's record from this copy alone.
 */
import {
  type CloneDigestKind,
  CloneableSecretNameSchema,
  cloneFileOwned,
  cloneItemDigest,
  type FleetCloneBundle,
  type FleetCloneFile,
  InstantSchema,
  isCanonicalAssetPath,
  NonEmptyStringSchema,
  type OriginKey,
  OriginKeySchema,
  sha256Hex,
} from '@ferretry/protocol';
import { z } from 'zod';
import { type AccountModel, COMPONENT_KINDS } from './schema.ts';

/** Directly under the fleet directory, beside `setup/import.json`. */
export const CLONE_BASE_FILE = 'setup/clone-base.json';

export const CLONE_BASE_VERSION = 1 as const;
/** Machines this one remembers. */
export const CLONE_BASE_SOURCES_LIMIT = 32;
/** Items remembered per source. */
export const CLONE_BASE_ITEMS_LIMIT = 4096;
/** Documents remembered per item: a bundle cannot carry more than it has room for anyway. */
export const CLONE_BASE_FILES_LIMIT = 4096;

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u, 'a sha256 digest');

/** The daemon id a source is filed under: as the browser verified it, else as the source reported itself. */
export const CloneSourceIdSchema = NonEmptyStringSchema.max(200);

/** What a settings document's per-key digests are filed under (filled by the per-key merge). */
export const CloneSettingsDocSchema = z.enum(['warden.yaml', 'learning.yaml', 'voice.yaml', 'controls']);

const CloneBaseKindSchema = z.enum([...COMPONENT_KINDS, 'profile', 'runtime', 'login']);
export type CloneBaseKind = z.infer<typeof CloneBaseKindSchema>;

const CloneBaseFileSchema = z.strictObject({
  digest: Sha256HexSchema,
  bytes: z.number().int().nonnegative(),
});

export const CloneBaseItemSchema = z.strictObject({
  kind: CloneBaseKindSchema,
  /** What the source called it. A hint for the screen; nothing is matched against it. */
  sourceName: NonEmptyStringSchema.max(200),
  /** The source's item as it ran at the last copy ({@link cloneItemDigest}). */
  digest: Sha256HexSchema,
  /** How big: the item's own configuration plus every document it carried. */
  bytes: z.number().int().nonnegative(),
  /** Each carried document, so a later review can say which one changed. Paths and digests only. */
  files: z
    .record(z.string().refine(isCanonicalAssetPath, 'a document path inside the setup folder'), CloneBaseFileSchema)
    .refine(files => Object.keys(files).length <= CLONE_BASE_FILES_LIMIT, 'too many documents for one item')
    .optional(),
  /** The login here this source login was matched to, when it was reused rather than given a new slot. */
  login: NonEmptyStringSchema.optional(),
  /** "Gone from the source", and the person chose to keep it: not asked again until the source brings it back. */
  settled: z.boolean().optional(),
});
export type CloneBaseItem = z.infer<typeof CloneBaseItemSchema>;

export const CloneBaseSourceSchema = z.strictObject({
  /** Display only. */
  name: z.string().max(120),
  /** Whether the id was verified by the browser that did the copy, or is only what the source said of itself. */
  verified: z.enum(['browser', 'self']),
  lastCopiedAt: InstantSchema,
  items: z
    .record(OriginKeySchema, CloneBaseItemSchema)
    .refine(items => Object.keys(items).length <= CLONE_BASE_ITEMS_LIMIT, 'too many items for one source'),
  /** Per-key digests of each settings document at the last copy. Filled by the per-key merge. */
  settings: z.partialRecord(CloneSettingsDocSchema, z.record(z.string().min(1), Sha256HexSchema)).optional(),
  /** `updatedAt` of each API key at the last copy, both sides. Timestamps only: never a value, never a digest of one. */
  keys: z
    .record(
      CloneableSecretNameSchema,
      z.strictObject({ sourceUpdatedAt: InstantSchema, targetUpdatedAt: InstantSchema }),
    )
    .optional(),
});
export type CloneBaseSource = z.infer<typeof CloneBaseSourceSchema>;

export const CloneBaseSchema = z.strictObject({
  version: z.literal(CLONE_BASE_VERSION),
  sources: z
    .record(CloneSourceIdSchema, CloneBaseSourceSchema)
    .refine(sources => Object.keys(sources).length <= CLONE_BASE_SOURCES_LIMIT, 'too many sources'),
});
export type CloneBase = z.infer<typeof CloneBaseSchema>;

export const EMPTY_CLONE_BASE: CloneBase = { version: CLONE_BASE_VERSION, sources: {} };

/** The stored record, or an empty one when the text is absent or cannot be read: nothing is then known to be copied. */
export function parseCloneBase(text: string | undefined): CloneBase {
  if (text === undefined) return EMPTY_CLONE_BASE;
  try {
    const parsed = CloneBaseSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : EMPTY_CLONE_BASE;
  } catch {
    return EMPTY_CLONE_BASE;
  }
}

/** The file's text, sources and items in order, so writing an unchanged record is byte-identical. */
export function serializeCloneBase(base: CloneBase): string {
  const sorted = <T>(record: Readonly<Record<string, T>>, each: (value: T) => unknown = value => value) =>
    Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map(key => [key, each(record[key] as T)]),
    );
  const sources = sorted(base.sources, source => ({
    ...source,
    items: sorted(source.items, item => ({
      ...item,
      ...(item.files === undefined ? {} : { files: sorted(item.files) }),
    })),
    ...(source.settings === undefined ? {} : { settings: sorted(source.settings, doc => sorted(doc)) }),
    ...(source.keys === undefined ? {} : { keys: sorted(source.keys) }),
  }));
  return `${JSON.stringify({ version: base.version, sources }, null, 2)}\n`;
}

// ── What a copy leaves behind ────────────────────────────────────────────────────────────────────

/** One item a copy wrote, as the source held it: the base for the next copy. */
export interface CloneBaseEntry extends CloneBaseItem {
  readonly key: OriginKey;
}

/** The source's id and how much to trust it. */
export interface CloneSourceIdentity {
  readonly id: string;
  readonly name: string;
  readonly verified: 'browser' | 'self';
}

/** Why a copy cannot be filed under one source, as the sentence a person reads. */
export class CloneSourceMismatch extends Error {
  constructor() {
    super('That export says it is from another machine than the one you picked.');
    this.name = 'CloneSourceMismatch';
  }
}

/**
 * Who the bundle is from. The browser's verified id wins when there is one; a v2 bundle also says who it
 * is from, and when both exist and disagree the copy is refused. A v1 bundle with no verified id has no
 * identity at all: nothing is recorded for it.
 */
export function cloneSourceIdentity(
  bundle: FleetCloneBundle,
  verifiedDaemon: string | undefined,
  displayName: string | undefined,
): CloneSourceIdentity | undefined {
  const claimed = bundle.version === 2 ? bundle.daemon : undefined;
  // The id is the key of a record entry, so one the record cannot hold is not an identity at all.
  const reported = claimed !== undefined && CloneSourceIdSchema.safeParse(claimed).success ? claimed : undefined;
  if (verifiedDaemon !== undefined && claimed !== undefined && reported === undefined) throw new CloneSourceMismatch();
  if (verifiedDaemon !== undefined && reported !== undefined && verifiedDaemon !== reported) {
    throw new CloneSourceMismatch();
  }
  const id = verifiedDaemon ?? reported;
  if (id === undefined) return undefined;
  return {
    id,
    name: (displayName ?? bundle.machine).slice(0, 120),
    verified: verifiedDaemon === undefined ? 'self' : 'browser',
  };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;

const PROVENANCE = ['clonedFrom', 'clonedFromDaemon', 'clonedFromKey', 'installedFrom'] as const;

/** An item's own configuration without where it came from: what its size is measured over. */
const withoutProvenance = (value: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const own: Record<string, unknown> = { ...value };
  for (const field of PROVENANCE) delete own[field];
  return own;
};

/** One bundle item, as the digest sees it. */
interface BundleItem {
  readonly reference: string;
  readonly kind: CloneDigestKind;
  readonly name: string;
  readonly value: Readonly<Record<string, unknown>>;
  /** The id this item lands under here, for a login. */
  readonly login?: string;
}

/** Every item of a bundle that can be linked to: components, profiles, runtimes and logins. */
function bundleItems(bundle: FleetCloneBundle): BundleItem[] {
  return [
    ...Object.entries(bundle.components).flatMap(([kind, entries]) =>
      Object.entries(entries).flatMap(([name, value]) =>
        isRecord(value) ? [{ reference: `${kind}/${name}`, kind: kind as CloneDigestKind, name, value }] : [],
      ),
    ),
    ...Object.entries(bundle.profiles).flatMap(([name, value]) =>
      isRecord(value) ? [{ reference: `profile/${name}`, kind: 'profile' as const, name, value }] : [],
    ),
    ...bundle.credentials.map(credential => ({
      reference: `login/${credential.id}`,
      kind: 'login' as const,
      name: credential.id,
      value: credential as unknown as Readonly<Record<string, unknown>>,
    })),
    ...Object.entries(bundle.runtimes).flatMap(([name, value]) =>
      isRecord(value) ? [{ reference: `runtime/${name}`, kind: 'runtime' as const, name, value }] : [],
    ),
  ];
}

/**
 * The origin key of each bundle item, for the items whose key can be trusted: a v2 bundle's `keys`, less
 * any key two items claim (a damaged or hostile bundle) — those are left without one, so they are copied
 * but never linked.
 */
export function cloneOriginKeys(bundle: FleetCloneBundle): ReadonlyMap<string, OriginKey> {
  if (bundle.version !== 2) return new Map();
  const present = new Set(bundleItems(bundle).map(item => item.reference));
  const claims = new Map<OriginKey, number>();
  for (const [reference, key] of Object.entries(bundle.keys)) {
    if (present.has(reference)) claims.set(key, (claims.get(key) ?? 0) + 1);
  }
  return new Map(
    Object.entries(bundle.keys).filter(([reference, key]) => present.has(reference) && claims.get(key) === 1),
  );
}

/**
 * What a copy of these items leaves as the source's side of each: digests computed here from the
 * bundle's own documents. `copied` is what was written (a left-out component is not in it), `offered` is
 * everything the source sent, so a profile that lost a layer the person left out still records the
 * profile as the source has it — the next copy then sees it as changed HERE, which is the truth.
 */
export function cloneBaseEntries(
  offered: FleetCloneBundle,
  copied: FleetCloneBundle,
  logins: ReadonlyMap<string, string>,
): CloneBaseEntry[] {
  const keys = cloneOriginKeys(offered);
  const identityOf = (reference: string): string => keys.get(reference) ?? reference;
  const asOffered = new Map(bundleItems(offered).map(item => [item.reference, item]));
  const entries: CloneBaseEntry[] = [];
  for (const { reference, kind, name } of bundleItems(copied)) {
    const key = keys.get(reference);
    const item = asOffered.get(reference);
    if (key === undefined || item === undefined) continue;
    const documents =
      item.kind === 'login' || item.kind === 'runtime' || item.kind === 'profile'
        ? []
        : ownedFiles(item, offered.files);
    const files = Object.fromEntries(
      documents.map(file => [file.path, { digest: sha256Hex(file.content), bytes: bytesOf(file.content) }]),
    );
    const linked = kind === 'login' ? logins.get(name) : undefined;
    entries.push({
      key,
      kind,
      sourceName: name,
      digest: cloneItemDigest({ kind, value: item.value }, offered.files, identityOf),
      bytes:
        bytesOf(JSON.stringify(withoutProvenance(item.value))) +
        documents.reduce((sum, file) => sum + bytesOf(file.content), 0),
      ...(documents.length === 0 ? {} : { files }),
      ...(linked === undefined ? {} : { login: linked }),
    });
  }
  return entries;
}

const ownedFiles = (item: BundleItem, files: readonly FleetCloneFile[]): FleetCloneFile[] =>
  files.filter(file => cloneFileOwned(item.value, file.path));

// ── The record after a copy ──────────────────────────────────────────────────────────────────────

export interface CloneBaseUpdate {
  readonly source: CloneSourceIdentity;
  /** The instant the copy was applied. */
  readonly at: string;
  /** Start over: the source's record is rewritten from this copy alone. */
  readonly replace: boolean;
  /** What this copy wrote. */
  readonly copied: readonly CloneBaseEntry[];
  /** The origin key of every item the source holds now, including the ones left out of this copy. */
  readonly sourceKeys: ReadonlySet<OriginKey>;
  /** The setup this machine is left with: what still links to the source is read from it. */
  readonly model: AccountModel;
}

/** Every origin key the model's items carry. */
export function linkedKeys(model: AccountModel): ReadonlySet<OriginKey> {
  const keys = new Set<OriginKey>();
  const take = (item: { readonly clonedFromKey?: string }): void => {
    if (item.clonedFromKey !== undefined) keys.add(item.clonedFromKey);
  };
  for (const entries of Object.values(model.components)) {
    for (const item of Object.values(entries as Readonly<Record<string, { clonedFromKey?: string }>>)) take(item);
  }
  for (const item of Object.values(model.profiles)) take(item);
  for (const item of Object.values(model.runtimes)) take(item);
  for (const item of Object.values(model.credentials)) take(item);
  return keys;
}

/**
 * The record once a copy of one source has landed.
 *
 * 1. Every item the copy wrote: B := theirs (a "gone, kept" mark is lifted — it came back).
 * 2. Drop an entry whose item is gone on BOTH sides (the source no longer has it and nothing here links to it).
 * 3. Drop the whole source when nothing here links to it any more — this one, and any other a Replace left
 *    with nothing to link to.
 * 4. Past {@link CLONE_BASE_SOURCES_LIMIT} sources the one copied longest ago goes; this copy's never does.
 *
 * A source with more items than one source may record is not recorded at all: a partial base would read
 * as "new" and "changed" where nothing was, which is worse than starting from a clean slate.
 */
export function applyCloneToBase(previous: CloneBase, update: CloneBaseUpdate): CloneBase {
  const before = update.replace ? undefined : previous.sources[update.source.id];
  const items: Record<string, CloneBaseItem> = { ...before?.items };
  for (const { key, ...entry } of update.copied) items[key] = entry;

  const here = linkedKeys(update.model);
  const loginsHere = new Set(Object.keys(update.model.credentials));
  const linked = (key: string, item: CloneBaseItem): boolean =>
    here.has(key) || (item.login !== undefined && loginsHere.has(item.login));
  const kept: Record<string, CloneBaseItem> = {};
  for (const [key, item] of Object.entries(items)) {
    if (update.sourceKeys.has(key) || linked(key, item)) kept[key] = item;
  }

  // A Replace can leave another source with nothing here to link to; that source goes too.
  const { [update.source.id]: _replaced, ...others } = previous.sources;
  const sources: Record<string, CloneBaseSource> = Object.fromEntries(
    Object.entries(others).filter(([, source]) =>
      Object.entries(source.items).some(([key, item]) => linked(key, item)),
    ),
  );
  if (
    Object.entries(kept).some(([key, item]) => linked(key, item)) &&
    Object.keys(kept).length <= CLONE_BASE_ITEMS_LIMIT
  ) {
    sources[update.source.id] = {
      name: update.source.name,
      verified: update.source.verified,
      lastCopiedAt: update.at,
      items: kept,
      ...(before?.settings === undefined ? {} : { settings: before.settings }),
      ...(before?.keys === undefined ? {} : { keys: before.keys }),
    };
  }
  const oldestFirst = Object.entries(sources)
    .filter(([id]) => id !== update.source.id)
    .toSorted(([, left], [, right]) => Date.parse(left.lastCopiedAt) - Date.parse(right.lastCopiedAt));
  for (const [id] of oldestFirst) {
    if (Object.keys(sources).length <= CLONE_BASE_SOURCES_LIMIT) break;
    delete sources[id];
  }
  return { version: CLONE_BASE_VERSION, sources };
}

/** The record without one source: the next copy from it starts as if there was never one. Nothing else changes. */
export function forgetCloneSource(base: CloneBase, sourceId: string): CloneBase {
  const { [sourceId]: _gone, ...sources } = base.sources;
  return { version: CLONE_BASE_VERSION, sources };
}
