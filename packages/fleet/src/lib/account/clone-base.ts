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
  CLONE_SETTINGS_KEYS_LIMIT,
  type CloneDigestKind,
  type CloneSettingsDoc,
  CloneSettingsDocSchema,
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

/**
 * The daemon id a source is filed under: as the browser verified it, else as the source reported itself
 * (under {@link SELF_REPORTED_PREFIX}). `__proto__` is no id: a record keyed by it reads back as nothing.
 */
export const CloneSourceIdSchema = NonEmptyStringSchema.max(200).refine(id => id !== '__proto__', 'not an id');

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
  /** The login here this source login was copied to (reused, or given a new slot): set for every copied login. */
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
  /**
   * A source filed from its own word: the machine its bundle names, which every component and login copied
   * from it is stamped with (`clonedFrom`). Two such sources are told apart by it, since neither stamps an id.
   */
  machine: z.string().min(1).max(120).optional(),
  lastCopiedAt: InstantSchema,
  items: z
    .record(OriginKeySchema, CloneBaseItemSchema)
    .refine(items => Object.keys(items).length <= CLONE_BASE_ITEMS_LIMIT, 'too many items for one source'),
  /**
   * Per-key digests of each settings document at the last copy (design §5): a dotted key path to the sha256 of
   * its value in the SOURCE's document. Digests only: a value, even a `${secret:NAME}` reference, is never kept.
   */
  settings: z
    .partialRecord(
      CloneSettingsDocSchema,
      z
        .record(z.string().min(1), Sha256HexSchema)
        .refine(keys => Object.keys(keys).length <= CLONE_SETTINGS_KEYS_LIMIT, 'too many settings keys'),
    )
    .optional(),
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

/** A map that has no prototype, so a key such as `__proto__` is an ordinary entry and nothing is inherited. */
const plain = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * The part of a source the record can hold: an item that fails its own schema (more documents than one item
 * may list) loses its document list, and goes when it still fails; a source that still fails loses its
 * settings and key timestamps, and goes when it still fails. The rest of the record is left as it is.
 */
function fitSource(source: CloneBaseSource): CloneBaseSource | undefined {
  const items = plain<CloneBaseItem>();
  for (const [key, item] of Object.entries(source.items)) {
    if (!OriginKeySchema.safeParse(key).success) continue;
    if (CloneBaseItemSchema.safeParse(item).success) {
      items[key] = item;
      continue;
    }
    const { files: _dropped, ...bare } = item;
    if (CloneBaseItemSchema.safeParse(bare).success) items[key] = bare;
  }
  const { settings: _settings, keys: _keys, ...bare } = source;
  return [
    { ...source, items: { ...items } },
    { ...bare, items: { ...items } },
  ].find(candidate => CloneBaseSourceSchema.safeParse(candidate).success);
}

/**
 * The record as it can be written: every part of it that reads back, so one oversize item can never make the
 * whole record read as empty. What cannot be kept is left out; nothing else is changed.
 */
function fitCloneBase(base: CloneBase): CloneBase {
  const sources = plain<CloneBaseSource>();
  for (const [id, source] of Object.entries(base.sources)) {
    const fitted = CloneSourceIdSchema.safeParse(id).success ? fitSource(source) : undefined;
    if (fitted !== undefined) sources[id] = fitted;
  }
  const oldestFirst = Object.entries(sources).toSorted(
    ([, left], [, right]) => Date.parse(left.lastCopiedAt) - Date.parse(right.lastCopiedAt),
  );
  for (const [id] of oldestFirst) {
    if (Object.keys(sources).length <= CLONE_BASE_SOURCES_LIMIT) break;
    delete sources[id];
  }
  const fitted: CloneBase = { version: CLONE_BASE_VERSION, sources: { ...sources } };
  return CloneBaseSchema.safeParse(fitted).success ? fitted : EMPTY_CLONE_BASE;
}

/**
 * The file's text, sources and items in order, so writing an unchanged record is byte-identical. What the
 * record cannot hold ({@link fitCloneBase}) is left out, so the text always reads back as written.
 */
export function serializeCloneBase(written: CloneBase): string {
  const base = fitCloneBase(written);
  const sorted = <T>(record: Readonly<Record<string, T>>, each: (value: T) => unknown = value => value) =>
    Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map(key => [key, each(own(record, key) as T)]),
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
  /** Only for a source filed from its own word: the machine its bundle names, as copies stamp it (`clonedFrom`). */
  readonly machine?: string;
}

/**
 * What a source reports of itself is filed under this prefix: a bundle can say anything, so it never shares
 * an entry with an id the browser verified, whatever it claims to be.
 */
export const SELF_REPORTED_PREFIX = 'self:';

/** Why a copy cannot be filed under one source, as the sentence a person reads. */
export class CloneSourceMismatch extends Error {
  constructor(reason: 'another-machine' | 'id-too-long' = 'another-machine') {
    super(
      reason === 'id-too-long'
        ? 'That export names its machine with an id too long to remember. Export it again from the other machine.'
        : 'That export says it is from another machine than the one you picked.',
    );
    this.name = 'CloneSourceMismatch';
  }
}

/**
 * Who the bundle is from. The browser's verified id wins when there is one; a v2 bundle also says who it
 * is from, and when both exist and disagree the copy is refused. An id the bundle gave for itself alone is
 * filed under {@link SELF_REPORTED_PREFIX}, apart from every verified id. A v1 bundle with no verified id has no
 * identity at all: nothing is recorded for it.
 */
export function cloneSourceIdentity(
  bundle: FleetCloneBundle,
  verifiedDaemon: string | undefined,
  displayName: string | undefined,
): CloneSourceIdentity | undefined {
  const claimed = bundle.version === 2 ? bundle.daemon : undefined;
  // The id is the key of a record entry, so one the record cannot hold is not an identity at all. Only an
  // id filed under the self-reported prefix pays for it; a browser-verified id keeps the full length.
  const filedAs = verifiedDaemon === undefined ? `${SELF_REPORTED_PREFIX}${claimed ?? ''}` : claimed;
  const reported = claimed !== undefined && CloneSourceIdSchema.safeParse(filedAs).success ? claimed : undefined;
  if (verifiedDaemon !== undefined && claimed !== undefined && reported === undefined) {
    throw new CloneSourceMismatch(claimed === verifiedDaemon ? 'id-too-long' : 'another-machine');
  }
  if (verifiedDaemon !== undefined && reported !== undefined && verifiedDaemon !== reported) {
    throw new CloneSourceMismatch();
  }
  const id = verifiedDaemon ?? (reported === undefined ? undefined : `${SELF_REPORTED_PREFIX}${reported}`);
  if (id === undefined || !CloneSourceIdSchema.safeParse(id).success) return undefined;
  return {
    id,
    name: (displayName ?? bundle.machine).slice(0, 120),
    verified: verifiedDaemon === undefined ? 'self' : 'browser',
    ...(verifiedDaemon === undefined && bundle.machine.length <= 120 ? { machine: bundle.machine } : {}),
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
  /** Items the source dropped that the person chose to keep: not offered for removal again. */
  readonly settled?: ReadonlySet<OriginKey>;
  /**
   * The source's settings documents as they stand after this copy (B := theirs): each document named here
   * replaces the record's digests for it; one not named is left as it was.
   */
  readonly settings?: Readonly<Partial<Record<CloneSettingsDoc, Readonly<Record<string, string>>>>>;
}

/** What an item says of where it was copied from. */
interface Stamped {
  readonly clonedFromKey?: string;
  readonly clonedFromDaemon?: string;
  readonly clonedFrom?: string;
}

/**
 * Every origin key the model's items carry; with `from`, only those on items copied from that source. A
 * browser-verified source owns the items stamped with its id; a source filed under {@link SELF_REPORTED_PREFIX}
 * owns the items no browser stamped (a copy made from a file) — and, when it knows the machine it came from,
 * only those of them that name that machine, so one source never keeps another's entry alive. A profile or
 * runtime names no machine, so it still counts for every source filed from its own word.
 */
export function linkedKeys(
  model: AccountModel,
  from?: Pick<CloneSourceIdentity, 'id' | 'verified' | 'machine'>,
): ReadonlySet<OriginKey> {
  const keys = new Set<OriginKey>();
  const take = (item: Stamped): void => {
    if (item.clonedFromKey === undefined) return;
    if (from !== undefined && item.clonedFromDaemon !== (from.verified === 'browser' ? from.id : undefined)) return;
    if (from?.machine !== undefined && item.clonedFrom !== undefined && item.clonedFrom !== from.machine) return;
    keys.add(item.clonedFromKey);
  };
  for (const entries of Object.values(model.components)) {
    for (const item of Object.values(entries as Readonly<Record<string, Stamped>>)) take(item);
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
  const existing = own(previous.sources, update.source.id);
  // What a machine says of itself never touches an entry the browser verified. A verified copy over an
  // entry that was only reported starts it afresh: nothing a bundle planted is trusted as a base.
  if (existing?.verified === 'browser' && update.source.verified === 'self') return previous;
  const before =
    update.replace || existing === undefined || existing.verified !== update.source.verified ? undefined : existing;
  const items = plain<CloneBaseItem>();
  for (const [key, item] of Object.entries(before?.items ?? {})) items[key] = item;
  for (const { key, ...entry } of update.copied) items[key] = entry;

  // Only items copied from THIS source keep its entries: another source's copy of the same key is not a link
  // to it. What this copy just stamped belongs to it, however the entry was filed before.
  const here = new Set([...linkedKeys(update.model, update.source), ...update.copied.map(copied => copied.key)]);
  const loginsHere = new Set(Object.keys(update.model.credentials));
  const viaLogin = (item: CloneBaseItem): boolean => item.login !== undefined && loginsHere.has(item.login);
  const linked = (key: string, item: CloneBaseItem): boolean => here.has(key) || viaLogin(item);
  const kept = plain<CloneBaseItem>();
  for (const [key, item] of Object.entries(items)) {
    if (update.sourceKeys.has(key) || linked(key, item)) kept[key] = item;
  }
  for (const key of update.settled ?? []) {
    const item = kept[key];
    if (item !== undefined && !update.sourceKeys.has(key)) kept[key] = { ...item, settled: true };
  }

  // The source's settings, as it holds them now: the documents this copy decided replace the record's, the rest stay.
  const settings = { ...before?.settings, ...update.settings };
  const hasSettings = Object.values(settings).some(keys => Object.keys(keys).length > 0);

  // A Replace can leave another source with nothing here to link to; that source goes too.
  const sources = plain<CloneBaseSource>();
  for (const [id, source] of Object.entries(previous.sources)) {
    if (id === update.source.id) continue;
    const its = linkedKeys(update.model, {
      id,
      verified: source.verified,
      ...(source.machine === undefined ? {} : { machine: source.machine }),
    });
    if (
      Object.entries(source.items).some(([key, item]) => its.has(key) || viaLogin(item)) ||
      Object.values(source.settings ?? {}).some(keys => Object.keys(keys).length > 0)
    )
      sources[id] = source;
  }
  if (
    (Object.entries(kept).some(([key, item]) => linked(key, item)) || hasSettings) &&
    Object.keys(kept).length <= CLONE_BASE_ITEMS_LIMIT
  ) {
    sources[update.source.id] = {
      name: update.source.name,
      verified: update.source.verified,
      ...(update.source.machine === undefined ? {} : { machine: update.source.machine }),
      lastCopiedAt: update.at,
      items: { ...kept },
      ...(hasSettings ? { settings } : {}),
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
  return { version: CLONE_BASE_VERSION, sources: { ...sources } };
}

/**
 * The ids of the sources a person's word names: an id as filed, the bare id an export carries (filed under
 * {@link SELF_REPORTED_PREFIX}), or the name the source was copied under (its display name, or the machine
 * name its export gave). An exact id wins outright; a name can name several, and the caller says so.
 */
export function findCloneSources(base: CloneBase, word: string): readonly string[] {
  if (Object.hasOwn(base.sources, word)) return [word];
  const bare = `${SELF_REPORTED_PREFIX}${word}`;
  if (Object.hasOwn(base.sources, bare)) return [bare];
  return Object.entries(base.sources)
    .filter(([, source]) => source.name === word || source.machine === word)
    .map(([id]) => id);
}

/** The record without one source: the next copy from it starts as if there was never one. Nothing else changes. */
export function forgetCloneSource(base: CloneBase, sourceId: string): CloneBase {
  const sources = plain<CloneBaseSource>();
  for (const [id, source] of Object.entries(base.sources)) if (id !== sourceId) sources[id] = source;
  return { version: CLONE_BASE_VERSION, sources: { ...sources } };
}
