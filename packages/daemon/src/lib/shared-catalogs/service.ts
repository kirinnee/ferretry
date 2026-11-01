/**
 * The publisher side of catalogs (docs/catalogs.md § The publisher side): make a catalog, freeze skills
 * and MCP setups into it, publish new versions, withdraw, and export a signed file.
 *
 * ## What the person read is what gets frozen
 *
 * A preview answers a content digest. Adding an item or publishing a version sends it back; the service
 * reads the source AGAIN and refuses unless it hashes the same. The source is read twice because the
 * source is not ours: a skill is a folder somebody can edit between the review and the click.
 *
 * ## Writes are one at a time
 *
 * The document is read, changed and written whole, so two writes at once would lose one. They queue.
 *
 * ## The upgrade from version 1
 *
 * The first call that finds a version 1 document upgrades it (`migrate.ts`) INSIDE that queue, so two first
 * calls upgrade once, and every write starts from a version 2 document. The upgrade is repeatable step by step:
 * the shared copies, then the backup of the old file, then the new file. A failure leaves the old file as it
 * was, and the next call tries again.
 */

import { basename, dirname } from 'node:path';
import {
  type AddCatalogItemRequest,
  CATALOG_PUBLIC_UNAVAILABLE,
  type CatalogChanges,
  CatalogItemNameSchema,
  type CatalogItemPreview,
  type CatalogItemPreviewRequest,
  type CatalogItemSource,
  CatalogLabelSchema,
  type CatalogSourceProblem,
  type CatalogSourceReference,
  type CatalogSourceState,
  type CreateCatalogRequest,
  catalogItemChanges,
  type DeletedCatalog,
  type ExportCatalogRequest,
  type OwnedCatalog,
  type OwnedCatalogItem,
  type OwnedCatalogList,
  type OwnedSharedItem,
  type OwnedSharedItemList,
  type PublishedCatalogItem,
  type PublishedSharedItem,
  type QuickAddAnswer,
  type QuickAddRequest,
  type QuickAddUndone,
  SHARED_CATALOG_FILE_FORMAT,
  SHARED_CATALOG_FILE_MAX_BYTES,
  SHARED_CATALOG_MANIFEST_FORMAT,
  type SharedCatalogFile,
  SharedCatalogFileSchema,
  type SharedCatalogItem,
  SharedCatalogItemSchema,
  type SharedCatalogManifestEntry,
  type SharedItemPreview,
  type SharedItemVersionDetail,
  type SignedCatalogManifest,
  type UpdateCatalogRequest,
  type WithdrawnCatalogItem,
} from '@ferretry/protocol';
import { type DaemonIdentity, type RelayCrypto, signCatalogManifest, verifySharedCatalogFile } from '@ferretry/relay';
import {
  bindingOf,
  type CatalogBinding,
  type CatalogEntry,
  type CatalogsDocument,
  CatalogsDocumentSchema,
  catalogsListing,
  currentVersion,
  EMPTY_CATALOGS_DOCUMENT,
  findCatalog,
  findEntry,
  findItem,
  itemOf,
  latestVersion,
  liveEntries,
  roleOf,
  type StoredCatalog,
  type StoredSharedItem,
  type StoredVersion,
  withCatalog,
  withCatalogPatch,
  withDefault,
  withListedItem,
  withNewItem,
  withoutCatalog,
  withoutEntry,
  withPublishedVersion,
  withWithdrawn,
} from './document.ts';
import {
  canonicalCopy,
  canonicalOrRefuse,
  defaultMcpSummary,
  type FrozenBody,
  fileCountOf,
  fingerprint,
  freezeItem,
  itemForCatalog,
  NORMALISED_CATALOG_ID,
  NORMALISED_ITEM_ID,
  readItem,
  sharedCopy,
  skillOf,
  skillSummary,
} from './freeze.ts';
import { describeMcpServer, lookupMcpServer, mcpSetupOf } from './mcp-source.ts';
import { migrateCatalogs } from './migrate.ts';
import type {
  CatalogBlobStore,
  CatalogDocumentStore,
  CatalogIdentitySource,
  McpDirectory,
  SkillDirectory,
} from './ports.ts';
import { CatalogRefusal } from './refusal.ts';
import { readSkillFolder, type SkillTreePort } from './skill-source.ts';
import { UndoLedger } from './undo-ledger.ts';

export interface SharedCatalogDeps {
  readonly documents: CatalogDocumentStore;
  readonly blobs: CatalogBlobStore;
  readonly skillTree: SkillTreePort;
  readonly skills: SkillDirectory;
  readonly mcp: McpDirectory;
  readonly identity: CatalogIdentitySource;
  readonly crypto: RelayCrypto;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  /** The most an exported file may hold. A reader refuses more, so the file is not made. Defaults to the contract's. */
  readonly exportMaxBytes?: number;
  /** The people a catalog is shared with: told when a catalog is deleted so none keeps a name for it. */
  readonly membership?: CatalogMembership;
}

/** What the member side does when a catalog goes (`CatalogMemberService.forgetCatalog`). */
export interface CatalogMembership {
  forgetCatalog(catalogId: string): Promise<void>;
}

/** A source read and frozen as far as a preview goes. */
interface Prepared {
  readonly existing: StoredSharedItem | undefined;
  readonly reference: CatalogSourceReference;
  readonly body: FrozenBody;
  readonly name: string;
  readonly harness: StoredSharedItem['harness'];
  readonly summary: string;
  readonly ownSummary: boolean;
  readonly version: number;
  readonly location: string;
  readonly problems: readonly CatalogSourceProblem[];
}

/** An id of 128 random bits in the characters base64url writes — never the placeholder a shared copy is stored under. */
function randomId(crypto: RelayCrypto, prefix: 'cat_' | 'itm_'): string {
  const placeholder = prefix === 'cat_' ? NORMALISED_CATALOG_ID : NORMALISED_ITEM_ID;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const bytes = crypto.randomBytes(16);
    const text = btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    if (`${prefix}${text}` !== placeholder) return `${prefix}${text}`;
  }
  throw new Error('The random source gave the placeholder id three times, so no id could be made.');
}

const instant = (ms: number): string => new Date(ms).toISOString();

/** A source with nothing to say about itself and no summary given: one-tap Add answers `review` instead of failing. */
class NeedsSummary extends CatalogRefusal {}

const sameSource = (left: CatalogSourceReference, right: CatalogSourceReference): boolean =>
  left.kind === 'skill'
    ? right.kind === 'skill' && left.path === right.path
    : right.kind === 'mcp' && left.id === right.id;

/** The label cut by whole characters until `around(cut)` is a label the contract accepts (it counts UTF-16 units, not characters). */
function cutToFit(label: string, around: (cut: string) => string): string {
  const characters = Array.from(label);
  while (characters.length > 0 && !CatalogLabelSchema.safeParse(around(characters.join('').trimEnd())).success)
    characters.pop();
  return characters.join('').trimEnd();
}

/** The names the default catalog may take, in order: "<label>'s skills", then the same with 2 to 9, each a valid label. */
export function defaultCatalogNames(label: string): readonly string[] {
  return [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(number => {
      const tail = number === 1 ? "'s skills" : `'s skills ${number}`;
      return `${cutToFit(label, cut => `${cut}${tail}`)}${tail}`;
    }),
  ];
}

/** The name this machine gives itself as a publisher: one clean line, at most 80 characters. */
export function publisherLabel(name: string): string {
  const cleaned = Array.from(name.trim())
    .filter(character => CatalogLabelSchema.safeParse(character).success)
    .join('')
    .trim();
  const bounded = cutToFit(cleaned, cut => cut);
  return bounded === '' ? 'This machine' : bounded;
}

export class SharedCatalogService {
  #queue: Promise<unknown> = Promise.resolve();
  readonly #ledger: UndoLedger;

  constructor(private readonly deps: SharedCatalogDeps) {
    this.#ledger = new UndoLedger(deps.crypto);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Every catalog. Whether each source has changed is worked out only when asked: it re-reads every live
   * item's skill folder or MCP declaration, and the list is open to a ferret, which could ask in a loop.
   */
  async list(options: { readonly sourceState: boolean } = { sourceState: false }): Promise<OwnedCatalogList> {
    const identity = await this.#identity();
    const document = await this.#document();
    const catalogs: OwnedCatalog[] = [];
    for (const catalog of document.catalogs)
      catalogs.push(await this.#owned(document, catalog, identity, options.sourceState));
    return {
      publisher: identity.daemonId,
      ...(document.defaultCatalogId === undefined ? {} : { defaultCatalogId: document.defaultCatalogId }),
      catalogs,
    };
  }

  /** Every item this machine keeps, once, with the catalogs that list it. */
  async listItems(options: { readonly sourceState: boolean } = { sourceState: false }): Promise<OwnedSharedItemList> {
    const identity = await this.#identity();
    const document = await this.#document();
    const items: OwnedSharedItem[] = [];
    for (const item of document.items)
      items.push(await this.#sharedItem(document, identity, item, options.sourceState));
    return {
      publisher: identity.daemonId,
      ...(document.defaultCatalogId === undefined ? {} : { defaultCatalogId: document.defaultCatalogId }),
      items,
    };
  }

  async previewItem(catalogId: string, request: CatalogItemPreviewRequest): Promise<CatalogItemPreview> {
    const identity = await this.#identity();
    const document = await this.#document();
    const catalog = findCatalog(document, catalogId);
    if ('itemId' in request) {
      const listed = catalog.entries.find(entry => entry.itemId === request.itemId);
      if (listed === undefined || listed.withdrawnAt !== undefined)
        return await this.#reviewCurrent(catalog, findItem(document, request.itemId));
    }
    const prepared =
      'itemId' in request
        ? await this.#prepare({ ...this.#listed(document, catalog, request.itemId) })
        : await this.#prepare({ source: request.source, summary: request.summary });
    return { catalogId: catalog.id, ...(await this.#preview(identity, prepared)) };
  }

  /** One shared item, as the list shows it. */
  async getItem(itemId: string, options: { readonly sourceState: boolean }): Promise<OwnedSharedItem> {
    const identity = await this.#identity();
    const document = await this.#document();
    return await this.#sharedItem(document, identity, findItem(document, itemId), options.sourceState);
  }

  /** One frozen version in full: what an installer of exactly that version is shown, read from the kept copy. */
  async itemVersion(itemId: string, version: number): Promise<SharedItemVersionDetail> {
    const item = findItem(await this.#document(), itemId);
    const stored = this.#versionOfItem(item, version);
    const shared = await this.#sharedCopy(item, stored);
    return {
      itemId,
      version: stored.version,
      kind: item.kind,
      name: item.name,
      summary: stored.summary,
      ...(item.harness === undefined ? {} : { harness: item.harness }),
      size: stored.size,
      publishedAt: stored.publishedAt,
      ...(stored.retiredAt === undefined ? {} : { retiredAt: stored.retiredAt }),
      ...readItem(shared),
    };
  }

  /** What a person would read differently in version `to` than in version `from`. */
  async itemChanges(itemId: string, from: number, to: number): Promise<CatalogChanges> {
    const item = findItem(await this.#document(), itemId);
    const before = await this.#sharedCopy(item, this.#versionOfItem(item, from));
    const after = await this.#sharedCopy(item, this.#versionOfItem(item, to));
    return catalogItemChanges(before, after);
  }

  /** The next version of an item, read from the source it remembers, with what would change from the current one. */
  async previewItemVersion(itemId: string): Promise<SharedItemPreview> {
    const identity = await this.#identity();
    const item = findItem(await this.#document(), itemId);
    return await this.#preview(identity, await this.#prepare({ item }));
  }

  #versionOfItem(item: StoredSharedItem, version: number): StoredVersion {
    const stored = item.versions.find(candidate => candidate.version === version);
    if (stored === undefined)
      throw new CatalogRefusal('version_unknown', `${item.name} has no version ${String(version)}.`);
    return stored;
  }

  /**
   * What the next version of an item (or a new item) would be: the candidate frozen from the source as it reads
   * now, its digest, and — against the CURRENT version, the one every catalog serves — what changed.
   */
  async #preview(identity: DaemonIdentity, prepared: Prepared): Promise<SharedItemPreview> {
    const item = freezeItem(
      this.#input(identity, NORMALISED_CATALOG_ID, prepared, NORMALISED_ITEM_ID, prepared.version),
    );
    const print = await fingerprint(this.deps.crypto, item);
    const existing = prepared.existing;
    const current = existing === undefined ? undefined : currentVersion(existing);
    const same =
      existing === undefined
        ? undefined
        : [currentVersion(existing), ...existing.versions.toReversed()].find(
            version => version.contentDigest === print.contentDigest,
          );
    return {
      ...(existing === undefined ? {} : { itemId: existing.itemId }),
      kind: prepared.body.kind,
      name: prepared.name,
      summary: prepared.summary,
      ...(prepared.harness === undefined ? {} : { harness: prepared.harness }),
      location: prepared.location,
      version: prepared.version,
      ...(same === undefined ? {} : { sameAsVersion: same.version }),
      digest: print.contentDigest,
      size: print.size,
      ...readItem(item),
      problems: prepared.problems,
      ...(existing === undefined || current === undefined
        ? {}
        : { changes: catalogItemChanges(await this.#sharedCopy(existing, current), item) }),
    };
  }

  // ── Catalogs ───────────────────────────────────────────────────────────────────────────────────

  create(request: CreateCatalogRequest): Promise<OwnedCatalog> {
    if (request.visibility === 'public') throw new CatalogRefusal('public_unavailable', CATALOG_PUBLIC_UNAVAILABLE);
    return this.#serially(async () => {
      const identity = await this.#identity();
      const id = randomId(this.deps.crypto, 'cat_');
      const next = withCatalog(await this.#writable(), {
        id,
        name: request.name,
        description: request.description ?? '',
        publisherName: publisherLabel(this.deps.identity.publisherName()),
        now: instant(this.deps.now()),
      });
      await this.#commit(next);
      return await this.#owned(next, findCatalog(next, id), identity);
    });
  }

  update(catalogId: string, request: UpdateCatalogRequest): Promise<OwnedCatalog> {
    if (request.visibility === 'public') throw new CatalogRefusal('public_unavailable', CATALOG_PUBLIC_UNAVAILABLE);
    return this.#serially(async () => {
      const identity = await this.#identity();
      const document = await this.#writable();
      const patched = withCatalogPatch(document, catalogId, request, instant(this.deps.now()));
      const next = request.role === 'default' ? withDefault(patched, catalogId) : patched;
      if (next !== document) await this.#commit(next);
      return await this.#owned(next, findCatalog(next, catalogId), identity);
    });
  }

  remove(catalogId: string): Promise<DeletedCatalog> {
    return this.#serially(async () => {
      const next = withoutCatalog(await this.#writable(), catalogId);
      // BEFORE the catalog's own file changes: a failure in between leaves people without a catalog that still
      // exists, never holding a name for one that is gone.
      await this.deps.membership?.forgetCatalog(catalogId);
      await this.#commit(next);
      return { catalogId };
    });
  }

  // ── Items ──────────────────────────────────────────────────────────────────────────────────────

  addItem(catalogId: string, request: AddCatalogItemRequest): Promise<PublishedCatalogItem> {
    if ('itemId' in request) return this.#addExisting(catalogId, request.itemId, request.version);
    return this.#serially(async () => {
      const identity = await this.#identity();
      const document = await this.#writable();
      const catalog = findCatalog(document, catalogId);
      const prepared = await this.#prepare({ source: request.source, summary: request.summary });
      await this.#bind(identity, prepared, request.digest);
      const itemId = randomId(this.deps.crypto, 'itm_');
      const version = await this.#version(identity, catalog.id, prepared, itemId, 1, [catalog.id]);
      const now = instant(this.deps.now());
      const item: StoredSharedItem = {
        itemId,
        kind: prepared.body.kind,
        name: prepared.name,
        ...(prepared.harness === undefined ? {} : { harness: prepared.harness }),
        ownSummary: prepared.ownSummary,
        createdAt: now,
        current: 1,
        versions: [version.stored(now)],
      };
      const next = withNewItem(document, catalogId, item, now);
      await this.deps.blobs.put(version.contentDigest, version.text);
      await this.#commit(next);
      return await this.#published(next, identity, findCatalog(next, catalogId), itemId);
    });
  }

  #addExisting(catalogId: string, itemId: string, version: number): Promise<PublishedCatalogItem> {
    return this.#serially(async () => {
      const identity = await this.#identity();
      const document = await this.#writable();
      const catalog = findCatalog(document, catalogId);
      const next = await this.#listExisting(document, catalog.id, findItem(document, itemId), version);
      await this.#commit(next);
      return await this.#published(next, identity, findCatalog(next, catalogId), itemId);
    });
  }

  /** An item this machine keeps, listed by one more catalog (or again): every version bound for it, current as the floor. */
  async #listExisting(
    document: CatalogsDocument,
    catalogId: string,
    item: StoredSharedItem,
    version: number,
  ): Promise<CatalogsDocument> {
    const catalog = findCatalog(document, catalogId);
    const bindings: Record<number, CatalogBinding> = {};
    if (!catalog.entries.some(candidate => candidate.itemId === item.itemId))
      for (const stored of item.versions) {
        const shared = await this.#sharedCopy(item, stored);
        const own = await canonicalOrRefuse(
          this.deps.crypto,
          itemForCatalog(shared, { catalogId, itemId: item.itemId, itemVersion: stored.version }),
        );
        bindings[stored.version] = { digest: own.digest, size: own.size };
      }
    return withListedItem(document, catalogId, item.itemId, version, bindings, instant(this.deps.now()));
  }

  // ── One-tap Add, and Undo ──────────────────────────────────────────────────────────────────────

  /**
   * Lists a source or a kept item in the default catalog, only if it is CLEAN, and says how to take it back.
   * Clean is decided here, from the one frozen object that is stored: any warning, any file left out, a missing
   * summary, or a kept version with warnings answers `review` and writes nothing.
   */
  quickAdd(caller: string, request: QuickAddRequest): Promise<QuickAddAnswer> {
    return this.#serially(async () => {
      const identity = await this.#identity();
      const document = await this.#writable();
      const reference = 'source' in request ? await this.#resolve(request.source) : undefined;
      const matches =
        'itemId' in request
          ? [findItem(document, request.itemId)]
          : document.items.filter(item => sameSource(currentVersion(item).source, reference as CatalogSourceReference));
      if (matches.length > 1)
        throw new CatalogRefusal(
          'source_ambiguous',
          `More than one kept item is this source: ${matches.map(item => item.itemId).join(', ')}. Name one by its itemId.`,
        );
      const kept = matches[0];
      return kept === undefined
        ? await this.#quickAddNew(caller, identity, document, reference as CatalogSourceReference)
        : await this.#quickAddKept(caller, identity, document, kept);
    });
  }

  async #quickAddNew(
    caller: string,
    identity: DaemonIdentity,
    document: CatalogsDocument,
    reference: CatalogSourceReference,
  ): Promise<QuickAddAnswer> {
    let prepared: Prepared;
    try {
      prepared = await this.#prepare({ reference });
    } catch (error) {
      if (error instanceof NeedsSummary) return { outcome: 'review', reasons: ['needs-summary'] };
      throw error;
    }
    const frozen = freezeItem(this.#input(identity, NORMALISED_CATALOG_ID, prepared, NORMALISED_ITEM_ID, 1));
    const reading = readItem(frozen);
    const reasons = [
      ...(reading.warnings.length > 0 ? (['warnings'] as const) : []),
      ...(prepared.problems.length > 0 ? (['problems'] as const) : []),
    ];
    if (reasons.length > 0) {
      const print = await fingerprint(this.deps.crypto, frozen);
      return {
        outcome: 'review',
        reasons,
        preview: {
          kind: prepared.body.kind,
          name: prepared.name,
          summary: prepared.summary,
          ...(prepared.harness === undefined ? {} : { harness: prepared.harness }),
          location: prepared.location,
          version: 1,
          digest: print.contentDigest,
          size: print.size,
          ...reading,
          problems: prepared.problems,
        },
      };
    }
    const target = this.#defaultCatalog(document);
    const itemId = randomId(this.deps.crypto, 'itm_');
    const version = await this.#versionOf(frozen, prepared, itemId, 1, [target.catalogId]);
    const now = instant(this.deps.now());
    const item: StoredSharedItem = {
      itemId,
      kind: prepared.body.kind,
      name: prepared.name,
      ...(prepared.harness === undefined ? {} : { harness: prepared.harness }),
      ownSummary: prepared.ownSummary,
      createdAt: now,
      current: 1,
      versions: [version.stored(now)],
    };
    const next = withNewItem(target.document, target.catalogId, item, now);
    await this.deps.blobs.put(version.contentDigest, version.text);
    await this.#commit(next);
    return this.#added(caller, next, target, item, { newItem: true, sourceChanged: false, relisted: false });
  }

  async #quickAddKept(
    caller: string,
    identity: DaemonIdentity,
    document: CatalogsDocument,
    kept: StoredSharedItem,
  ): Promise<QuickAddAnswer> {
    const own = document.catalogs
      .find(catalog => catalog.id === document.defaultCatalogId)
      ?.entries.find(entry => entry.itemId === kept.itemId);
    if (own !== undefined && own.withdrawnAt === undefined && document.defaultCatalogId !== undefined)
      return {
        outcome: 'already',
        catalogId: document.defaultCatalogId,
        itemId: kept.itemId,
        itemVersion: kept.current,
      };
    const shared = await this.#sharedCopy(kept, currentVersion(kept));
    if (readItem(shared).warnings.length > 0)
      return { outcome: 'review', reasons: ['warnings'], preview: await this.#currentPreview(kept) };
    const target = this.#defaultCatalog(document);
    const next = await this.#listExisting(target.document, target.catalogId, kept, kept.current);
    const { state } = await this.#sourceState(identity, kept, {
      itemId: kept.itemId,
      addedAt: instant(this.deps.now()),
    });
    await this.#commit(next);
    return this.#added(caller, next, target, kept, {
      newItem: false,
      sourceChanged: state === 'changed',
      relisted: own !== undefined,
    });
  }

  #added(
    caller: string,
    next: CatalogsDocument,
    target: { readonly catalogId: string; readonly created: boolean },
    item: StoredSharedItem,
    how: { readonly newItem: boolean; readonly sourceChanged: boolean; readonly relisted: boolean },
  ): QuickAddAnswer {
    const catalog = findCatalog(next, target.catalogId);
    const stored = itemOf(next, item.itemId);
    const current = currentVersion(stored);
    const now = this.deps.now();
    const undo = this.#ledger.issue(
      {
        catalogId: catalog.id,
        itemId: item.itemId,
        revisionAfterAdd: catalog.revision,
        createdItem: how.newItem,
        createdCatalog: target.created,
        relisted: how.relisted,
      },
      caller,
      now,
    );
    return {
      outcome: 'added',
      catalog: { catalogId: catalog.id, name: catalog.name, revision: catalog.revision, created: target.created },
      itemId: item.itemId,
      itemVersion: current.version,
      digest: bindingOf(current, catalog.id).digest,
      newItem: how.newItem,
      sourceChanged: how.sourceChanged,
      undo: { token: undo.token, expiresAt: instant(undo.expiresAt) },
    };
  }

  /** The default catalog, or the document with the one this machine would make: "<label>'s skills", numbered when taken. */
  #defaultCatalog(document: CatalogsDocument): {
    readonly document: CatalogsDocument;
    readonly catalogId: string;
    readonly created: boolean;
  } {
    if (document.defaultCatalogId !== undefined)
      return { document, catalogId: document.defaultCatalogId, created: false };
    const label = publisherLabel(this.deps.identity.publisherName());
    const name = defaultCatalogNames(label).find(
      candidate => !document.catalogs.some(catalog => catalog.name === candidate),
    );
    if (name === undefined)
      throw new CatalogRefusal(
        'name_taken',
        'Every name for the default catalog is taken. Name one of your catalogs the default.',
      );
    const id = randomId(this.deps.crypto, 'cat_');
    const made = withCatalog(document, {
      id,
      name,
      description: '',
      publisherName: label,
      now: instant(this.deps.now()),
    });
    return { document: withDefault(made, id), catalogId: id, created: true };
  }

  /** Takes an add back while its token holds: out with no trace if nobody was shown it, else withdrawn as usual. */
  undoQuickAdd(caller: string, token: string): Promise<QuickAddUndone> {
    return this.#serially(async () => {
      const record = this.#ledger.peek(token, caller, this.deps.now());
      const gone = () =>
        new CatalogRefusal(
          'undo_expired',
          'That Undo has run out, or was already used. Withdraw the item from the catalog instead.',
        );
      if (record === undefined) throw gone();
      const document = await this.#writable();
      const catalog = document.catalogs.find(candidate => candidate.id === record.catalogId);
      const entry = catalog?.entries.find(candidate => candidate.itemId === record.itemId);
      if (catalog === undefined || entry === undefined || entry.withdrawnAt !== undefined) {
        this.#ledger.spend(token);
        throw gone();
      }
      const now = instant(this.deps.now());
      const retract =
        !record.relisted &&
        catalog.revision === record.revisionAfterAdd &&
        !this.#ledger.wasSigned(catalog.id, catalog.revision);
      if (retract) {
        const taken = withoutEntry(document, catalog.id, record.itemId, now, record.createdItem);
        await this.#commit(taken.document);
        this.#ledger.spend(token);
        return {
          catalogId: catalog.id,
          itemId: record.itemId,
          mode: 'retracted',
          revision: findCatalog(taken.document, catalog.id).revision,
          itemRemoved: taken.itemRemoved,
        };
      }
      const next = withWithdrawn(document, catalog.id, record.itemId, now);
      await this.#commit(next);
      this.#ledger.spend(token);
      return {
        catalogId: catalog.id,
        itemId: record.itemId,
        mode: 'withdrawn',
        revision: findCatalog(next, catalog.id).revision,
        itemRemoved: false,
      };
    });
  }

  /** A new version through one catalog: the same publish as {@link publishItemVersion}, for an item this catalog lists live. */
  publishVersion(
    catalogId: string,
    itemId: string,
    request: { readonly digest: string },
  ): Promise<PublishedCatalogItem> {
    return this.#serially(async () => {
      const identity = await this.#identity();
      const document = await this.#writable();
      const catalog = findCatalog(document, catalogId);
      const next = await this.#publish(identity, document, this.#listed(document, catalog, itemId), request.digest);
      return await this.#published(next, identity, findCatalog(next, catalogId), itemId);
    });
  }

  /**
   * A new version of a shared item, which every catalog that lists it live serves from now on, each rising a
   * revision in the one write. Only if the source still hashes to `digest`.
   */
  publishItemVersion(itemId: string, request: { readonly digest: string }): Promise<PublishedSharedItem> {
    return this.#serially(async () => {
      const identity = await this.#identity();
      const document = await this.#writable();
      const next = await this.#publish(identity, document, { item: findItem(document, itemId) }, request.digest);
      const stored = itemOf(next, itemId);
      const current = currentVersion(stored);
      return {
        itemId,
        itemVersion: current.version,
        current: stored.current,
        catalogs: next.catalogs.flatMap(catalog =>
          liveEntries(catalog).some(entry => entry.itemId === itemId)
            ? [{ catalogId: catalog.id, revision: catalog.revision, digest: bindingOf(current, catalog.id).digest }]
            : [],
        ),
        item: await this.#sharedItem(next, identity, stored, true),
      };
    });
  }

  /**
   * Re-reads the source, refuses unless it still hashes to the digest the person previewed, and writes the next
   * version: refused when it is the same as the current one (`nothing_to_publish`) or as an older one
   * (`same_as_version`). The document comes back with every live catalog bumped.
   */
  async #publish(
    identity: DaemonIdentity,
    document: CatalogsDocument,
    listed: { readonly item: StoredSharedItem; readonly entry?: CatalogEntry },
    digest: string,
  ): Promise<CatalogsDocument> {
    const { item } = listed;
    const prepared = await this.#prepare(listed);
    await this.#bind(identity, prepared, digest);
    const version = await this.#version(
      identity,
      NORMALISED_CATALOG_ID,
      prepared,
      item.itemId,
      prepared.version,
      catalogsListing(document, item.itemId).map(other => other.id),
    );
    const current = currentVersion(item);
    if (version.contentDigest === current.contentDigest)
      throw new CatalogRefusal(
        'nothing_to_publish',
        `${item.name} has not changed since version ${current.version}, so there is nothing new to publish.`,
      );
    const same = item.versions.find(other => other.contentDigest === version.contentDigest);
    if (same !== undefined)
      throw new CatalogRefusal(
        'same_as_version',
        `${item.name} is exactly version ${same.version} again. Make that version current instead of publishing it as a new one.`,
      );
    const now = instant(this.deps.now());
    const next = withPublishedVersion(document, item.itemId, version.stored(now), now);
    await this.deps.blobs.put(version.contentDigest, version.text);
    await this.#commit(next);
    return next;
  }

  withdraw(catalogId: string, itemId: string): Promise<WithdrawnCatalogItem> {
    return this.#serially(async () => {
      const next = withWithdrawn(await this.#writable(), catalogId, itemId, instant(this.deps.now()));
      await this.#commit(next);
      const catalog = findCatalog(next, catalogId);
      return {
        catalogId,
        itemId,
        revision: catalog.revision,
        withdrawnAt: findEntry(catalog, itemId).withdrawnAt as string,
      };
    });
  }

  // ── Export ─────────────────────────────────────────────────────────────────────────────────────

  exportCatalog(catalogId: string, request: ExportCatalogRequest): Promise<SharedCatalogFile> {
    return this.#serially(() => this.#export(catalogId, request));
  }

  async #export(catalogId: string, request: ExportCatalogRequest): Promise<SharedCatalogFile> {
    const identity = await this.#identity();
    const document = await this.#writable();
    const catalog = findCatalog(document, catalogId);
    const live = liveEntries(catalog);
    const chosen = new Set(request.itemIds ?? live.map(entry => entry.itemId));
    for (const itemId of chosen) {
      if (findEntry(catalog, itemId).withdrawnAt !== undefined)
        throw new CatalogRefusal(
          'item_withdrawn',
          `${itemOf(document, itemId).name} was withdrawn, so it cannot be exported.`,
        );
    }
    const items: SharedCatalogItem[] = [];
    for (const entry of live)
      if (chosen.has(entry.itemId)) {
        const item = itemOf(document, entry.itemId);
        items.push(await this.#frozen(catalog.id, item, currentVersion(item)));
      }
    const signed = await this.#signedManifest(document, identity, catalog);
    const parsed = SharedCatalogFileSchema.safeParse({
      format: SHARED_CATALOG_FILE_FORMAT,
      version: 1,
      exportedAt: catalog.issuedAt,
      signedManifest: signed,
      items,
    });
    if (!parsed.success)
      throw new CatalogRefusal(
        'export_failed',
        `The catalog file could not be made: ${parsed.error.issues[0]?.message ?? 'it is malformed'}.`,
      );
    const limit = this.deps.exportMaxBytes ?? SHARED_CATALOG_FILE_MAX_BYTES;
    if (new TextEncoder().encode(JSON.stringify(parsed.data)).length > limit)
      throw new CatalogRefusal(
        'export_too_big',
        `This catalog file would be larger than ${Math.round(limit / 1024 / 1024)} MiB, which is more than a reader will open. Export fewer items.`,
      );
    const verified = await verifySharedCatalogFile(this.deps.crypto, parsed.data);
    if (!verified.ok)
      throw new CatalogRefusal(
        'export_failed',
        `The catalog file did not verify before it was handed over: ${verified.reason}`,
      );
    return parsed.data;
  }

  // ── What a member reads ────────────────────────────────────────────────────────────────────────

  /** The catalog's signed manifest as it stands, made exactly as an export makes it. */
  signedManifest(catalogId: string): Promise<SignedCatalogManifest> {
    return this.#serially(async () => {
      const identity = await this.#identity();
      const document = await this.#writable();
      return await this.#signedManifest(document, identity, findCatalog(document, catalogId));
    });
  }

  /** One frozen version of a live item, checked against the digests the document lists for it. */
  async frozenItem(catalogId: string, itemId: string, version: number): Promise<SharedCatalogItem> {
    const document = await this.#document();
    const entry = findEntry(findCatalog(document, catalogId), itemId);
    const item = itemOf(document, itemId);
    if (entry.withdrawnAt !== undefined)
      throw new CatalogRefusal('item_withdrawn', `${item.name} was withdrawn, so it cannot be read.`);
    const stored = item.versions.find(candidate => candidate.version === version);
    if (stored === undefined)
      throw new CatalogRefusal('item_unknown', `${item.name} has no version ${String(version)}.`);
    // A catalog serves the versions from the one it joined (or was relisted) at onward: the person who added the
    // item reviewed that version, and nothing older.
    if (version < (entry.sinceVersion ?? 1))
      throw new CatalogRefusal('item_unknown', `${item.name} has no version ${String(version)} in this catalog.`);
    return await this.#frozen(catalogId, item, stored);
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────────

  async #signedManifest(
    document: CatalogsDocument,
    identity: DaemonIdentity,
    catalog: StoredCatalog,
  ): Promise<SignedCatalogManifest> {
    const entries: SharedCatalogManifestEntry[] = liveEntries(catalog).map(entry => {
      const item = itemOf(document, entry.itemId);
      const version = currentVersion(item);
      const binding = bindingOf(version, catalog.id);
      return {
        itemId: item.itemId,
        kind: item.kind,
        name: item.name,
        summary: version.summary,
        version: version.version,
        digest: binding.digest,
        size: binding.size,
        publishedAt: version.publishedAt,
        ...(item.harness === undefined ? {} : { harness: item.harness }),
      };
    });
    const signed = await signCatalogManifest(this.deps.crypto, identity, {
      format: SHARED_CATALOG_MANIFEST_FORMAT,
      version: 1,
      publisher: identity.daemonId,
      publisherName: catalog.publisherName,
      catalogId: catalog.id,
      name: catalog.name,
      description: catalog.description,
      visibility: catalog.visibility,
      revision: catalog.revision,
      issuedAt: catalog.issuedAt,
      items: entries,
      withdrawn: catalog.entries.flatMap(entry =>
        entry.withdrawnAt === undefined ? [] : [{ itemId: entry.itemId, at: entry.withdrawnAt }],
      ),
    });
    if (!signed.ok) throw new CatalogRefusal('export_failed', signed.reason);
    this.#ledger.noteSigned(catalog.id, catalog.revision);
    return signed.value;
  }

  /** The one door to a write: a document the schema would refuse never reaches the file, and nothing is written. */
  async #commit(next: CatalogsDocument): Promise<void> {
    const checked = CatalogsDocumentSchema.safeParse(next);
    if (!checked.success)
      throw new CatalogRefusal(
        'store_damaged',
        'That change would leave the catalogs file inconsistent, so nothing was saved.',
      );
    await this.deps.documents.write(next);
  }

  #serially<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /**
   * The document for a read. A version 1 file is upgraded first, and only inside the queue: whoever gets
   * there first does it, the rest find version 2.
   */
  async #document(): Promise<CatalogsDocument> {
    const raw = await this.deps.documents.readRaw();
    if (raw.version === 2) return raw.doc;
    if (raw.version === 'none') return EMPTY_CATALOGS_DOCUMENT;
    return await this.#serially(() => this.#writable());
  }

  /** The document for a write, which already runs in the queue: version 1 is upgraded here, once. */
  async #writable(): Promise<CatalogsDocument> {
    const raw = await this.deps.documents.readRaw();
    if (raw.version === 2) return raw.doc;
    if (raw.version === 'none') return EMPTY_CATALOGS_DOCUMENT;
    // Three repeatable steps, in this order: the shared copies, the old file kept as it was, the new file. A crash
    // between any two leaves the old file in place and is repaired by the next call making the same bytes.
    const migration = await migrateCatalogs(this.deps.crypto, raw.doc, digest => this.deps.blobs.get(digest));
    for (const blob of migration.sharedBlobs) await this.deps.blobs.put(blob.digest, blob.text);
    await this.deps.documents.writeBackupV1(raw.text);
    await this.deps.documents.write(migration.document);
    return migration.document;
  }

  async #identity(): Promise<DaemonIdentity> {
    const identity = await this.deps.identity.identity();
    if (identity === undefined)
      throw new CatalogRefusal(
        'signing_unavailable',
        "This machine's identity cannot be read, so it cannot publish a catalog. Restart the daemon, and check its log.",
      );
    return identity;
  }

  /** The catalog's line for an item and the item it points at. */
  #listed(
    document: CatalogsDocument,
    catalog: StoredCatalog,
    itemId: string,
  ): { readonly item: StoredSharedItem; readonly entry: CatalogEntry } {
    const entry = findEntry(catalog, itemId);
    return { item: itemOf(document, itemId), entry };
  }

  /**
   * A frozen version read back for one catalog. The shared copy is checked against the digest of its content, and
   * the item made from it against the digest this catalog's document lists, so a changed file is never handed on.
   */
  async #frozen(catalogId: string, item: StoredSharedItem, version: StoredVersion): Promise<SharedCatalogItem> {
    const shared = await this.#sharedCopy(item, version);
    const made = itemForCatalog(shared, { catalogId, itemId: item.itemId, itemVersion: version.version });
    const own = await canonicalCopy(this.deps.crypto, made);
    if (own?.digest !== bindingOf(version, catalogId).digest)
      throw this.#damaged(item, version, 'no longer matches its digest');
    return made;
  }

  #damaged(item: StoredSharedItem, version: StoredVersion, why: string): CatalogRefusal {
    return new CatalogRefusal(
      'store_damaged',
      `The frozen copy of ${item.name} version ${version.version} ${why}. Nothing was changed.`,
    );
  }

  /** The one copy kept for a version, read back and checked against the digest of its content. */
  async #sharedCopy(item: StoredSharedItem, version: StoredVersion): Promise<SharedCatalogItem> {
    const text = await this.deps.blobs.get(version.contentDigest);
    if (text === undefined) throw this.#damaged(item, version, 'is missing');
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw this.#damaged(item, version, 'is not JSON');
    }
    const parsed = SharedCatalogItemSchema.safeParse(document);
    if (!parsed.success) throw this.#damaged(item, version, 'is not a catalog item');
    const shared = await canonicalCopy(this.deps.crypto, parsed.data);
    if (shared?.digest !== version.contentDigest) throw this.#damaged(item, version, 'no longer matches its digest');
    return parsed.data;
  }

  /** What an installer would see of the version a catalog would list: read from the frozen copy, never the source. */
  async #reviewCurrent(catalog: StoredCatalog, item: StoredSharedItem): Promise<CatalogItemPreview> {
    return { catalogId: catalog.id, ...(await this.#currentPreview(item)) };
  }

  /** The preview of an item's current version, read from its frozen copy. */
  async #currentPreview(item: StoredSharedItem): Promise<SharedItemPreview> {
    const current = currentVersion(item);
    const shared = await this.#sharedCopy(item, current);
    return {
      itemId: item.itemId,
      kind: item.kind,
      name: item.name,
      summary: current.summary,
      ...(item.harness === undefined ? {} : { harness: item.harness }),
      location: current.source.kind === 'skill' ? current.source.path : current.source.name,
      version: current.version,
      digest: current.contentDigest,
      size: current.size,
      ...readItem(shared),
      problems: [],
    };
  }

  async #sharedItem(
    document: CatalogsDocument,
    identity: DaemonIdentity,
    item: StoredSharedItem,
    withState: boolean,
  ): Promise<OwnedSharedItem> {
    const current = currentVersion(item);
    const listing = document.catalogs.flatMap(catalog => {
      const entry = catalog.entries.find(candidate => candidate.itemId === item.itemId);
      return entry === undefined ? [] : [{ catalogId: catalog.id, entry }];
    });
    const live = listing.filter(({ entry }) => entry.withdrawnAt === undefined).map(({ catalogId }) => catalogId);
    const { state, note } = withState
      ? await this.#sourceState(identity, item, { itemId: item.itemId, addedAt: item.createdAt })
      : {};
    return {
      itemId: item.itemId,
      kind: item.kind,
      name: item.name,
      summary: current.summary,
      ...(item.harness === undefined ? {} : { harness: item.harness }),
      source: current.source,
      current: item.current,
      createdAt: item.createdAt,
      ...(state === undefined ? {} : { sourceState: state }),
      ...(note === undefined ? {} : { sourceNote: note }),
      catalogs: listing.map(({ catalogId, entry }) => ({
        catalogId,
        state: entry.withdrawnAt === undefined ? ('live' as const) : ('withdrawn' as const),
        ...(entry.withdrawnAt === undefined ? {} : { withdrawnAt: entry.withdrawnAt }),
      })),
      versions: item.versions.map(version => ({
        version: version.version,
        size: version.size,
        publishedAt: version.publishedAt,
        summary: version.summary,
        ...(version.fileCount === undefined ? {} : { fileCount: version.fileCount }),
        usedBy: { catalogIds: version.version === item.current ? live : [] },
      })),
    };
  }

  #input(identity: DaemonIdentity, catalogId: string, prepared: Prepared, itemId: string, version: number) {
    return {
      publisher: identity.daemonId,
      catalogId,
      itemId,
      itemVersion: version,
      name: prepared.name,
      summary: prepared.summary,
      harness: prepared.harness,
      body: prepared.body,
    };
  }

  /**
   * The item for this version: the shared copy to keep, and its digest for every catalog that lists the item,
   * because each catalog's manifest names the item in its own catalog's terms.
   */
  async #version(
    identity: DaemonIdentity,
    catalogId: string,
    prepared: Prepared,
    itemId: string,
    version: number,
    listedBy: readonly string[],
  ) {
    return await this.#versionOf(
      freezeItem(this.#input(identity, catalogId, prepared, itemId, version)),
      prepared,
      itemId,
      version,
      listedBy,
    );
  }

  /** The stored version of an item already frozen: the SAME object a clean check read is the one stored. */
  async #versionOf(
    item: SharedCatalogItem,
    prepared: Prepared,
    itemId: string,
    version: number,
    listedBy: readonly string[],
  ) {
    const shared = await canonicalOrRefuse(this.deps.crypto, sharedCopy(item));
    const bindings: Record<string, CatalogBinding> = {};
    for (const catalogId of listedBy) {
      const own = await canonicalOrRefuse(
        this.deps.crypto,
        itemForCatalog(item, { catalogId, itemId, itemVersion: version }),
      );
      bindings[catalogId] = { digest: own.digest, size: own.size };
    }
    const fileCount = fileCountOf(item);
    return {
      contentDigest: shared.digest,
      text: shared.text,
      stored: (publishedAt: string): StoredVersion => ({
        version,
        publishedAt,
        summary: prepared.summary,
        source: prepared.reference,
        contentDigest: shared.digest,
        size: shared.size,
        ...(fileCount === undefined ? {} : { fileCount }),
        bindings,
      }),
    };
  }

  /** Refuses unless the source, read now, hashes to the digest the person previewed. */
  async #bind(identity: DaemonIdentity, prepared: Prepared, digest: string): Promise<void> {
    const item = freezeItem(
      this.#input(identity, NORMALISED_CATALOG_ID, prepared, NORMALISED_ITEM_ID, prepared.version),
    );
    const print = await fingerprint(this.deps.crypto, item);
    if (print.contentDigest !== digest)
      throw new CatalogRefusal(
        'changed_since_preview',
        `${prepared.name} changed since you previewed it. Preview it again, read what it holds now, and then confirm.`,
      );
  }

  /**
   * Reads a source and decides what it would be called and say. A new item names its source; a new
   * version of an item reads the source that item's latest version remembers.
   */
  async #prepare(
    from:
      | { readonly source: CatalogItemSource; readonly summary?: string | undefined }
      | { readonly reference: CatalogSourceReference; readonly summary?: undefined }
      | { readonly item: StoredSharedItem; readonly entry?: CatalogEntry },
  ): Promise<Prepared> {
    const existing = 'item' in from ? from.item : undefined;
    if ('item' in from && from.entry?.withdrawnAt !== undefined)
      throw new CatalogRefusal('item_withdrawn', `${from.item.name} was withdrawn, so it takes no new version.`);
    const reference = existing === undefined ? undefined : currentVersion(existing).source;
    const read =
      'item' in from
        ? await this.#read(reference as CatalogSourceReference)
        : await this.#read('reference' in from ? from.reference : await this.#resolve(from.source));
    if (existing !== undefined && existing.name !== read.name)
      throw new CatalogRefusal(
        'source_refused',
        `The source is now called ${read.name}, not ${existing.name}. Add it as a new item instead.`,
      );
    const own = 'item' in from ? undefined : from.summary;
    const summary =
      own ??
      (existing?.ownSummary === true
        ? currentVersion(existing).summary
        : 'summary' in read.derived
          ? read.derived.summary
          : read.body.kind === 'mcp'
            ? defaultMcpSummary(read.name)
            : this.#noSummary(read.derived));
    return {
      existing,
      reference: read.reference,
      body: read.body,
      name: read.name,
      harness: read.harness,
      summary,
      ownSummary: own !== undefined || existing?.ownSummary === true,
      version: existing === undefined ? 1 : latestVersion(existing).version + 1,
      location: read.location,
      problems: read.problems,
    };
  }

  #noSummary(derived: { readonly problem: string } | { readonly summary: string }): never {
    throw new NeedsSummary('source_refused', 'problem' in derived ? derived.problem : 'This needs a summary.');
  }

  /** What a person named, as the exact path or inventory id it is. */
  async #resolve(source: CatalogItemSource): Promise<CatalogSourceReference> {
    if (source.kind === 'skill') {
      const skills = await this.deps.skills.list();
      const exact = skills.find(skill => skill.path === source.skill);
      if (exact !== undefined) return { kind: 'skill', path: exact.path };
      const named = skills.filter(
        skill => skill.name === source.skill || basename(dirname(skill.path)) === source.skill,
      );
      const paths = [...new Set(named.map(skill => skill.path))];
      const only = paths[0];
      if (only === undefined)
        throw new CatalogRefusal(
          'source_unknown',
          `This machine lists no skill ${JSON.stringify(source.skill)}. Name a SKILL.md path from the skills inventory, or the skill's name.`,
        );
      if (paths.length > 1)
        throw new CatalogRefusal(
          'source_ambiguous',
          `More than one skill is called ${JSON.stringify(source.skill)}. Name one by its SKILL.md path: ${paths.join(', ')}`,
        );
      return { kind: 'skill', path: only };
    }
    const lookup = lookupMcpServer(await this.deps.mcp.servers(), source.mcp);
    if (lookup.kind === 'unknown')
      throw new CatalogRefusal(
        'source_unknown',
        `This machine declares no MCP server ${JSON.stringify(source.mcp)}. Name an id or a name from the MCP inventory.`,
      );
    if (lookup.kind === 'ambiguous')
      throw new CatalogRefusal(
        'source_ambiguous',
        `More than one MCP server is called ${JSON.stringify(source.mcp)}. Name one by its id: ${lookup.candidates.map(server => `${server.id} = ${describeMcpServer(server)}`).join('; ')}`,
      );
    return { kind: 'mcp', id: lookup.server.id, name: lookup.server.name };
  }

  /** A resolved reference, read and converted. */
  async #read(reference: CatalogSourceReference) {
    if (reference.kind === 'skill') {
      const listed = (await this.deps.skills.list()).some(skill => skill.path === reference.path);
      if (!listed)
        throw new CatalogRefusal('source_unknown', `${reference.path} is not a skill this machine lists any more.`);
      const name = basename(dirname(reference.path));
      if (!CatalogItemNameSchema.safeParse(name).success)
        throw new CatalogRefusal(
          'source_refused',
          `${JSON.stringify(name)} is not a name a catalog item can have: use letters, digits, - and _.`,
        );
      const folder = await readSkillFolder(this.deps.skillTree, reference.path);
      if (folder.refusal !== undefined) throw new CatalogRefusal('source_refused', folder.refusal);
      const skill = skillOf(folder.files);
      if (typeof skill === 'string') throw new CatalogRefusal('source_refused', `${name} cannot be shared: ${skill}.`);
      return {
        reference,
        location: reference.path,
        name,
        harness: undefined,
        body: { kind: 'skill', skill } as FrozenBody,
        derived: skillSummary(skill),
        problems: folder.problems,
      };
    }
    const server = (await this.deps.mcp.servers()).find(candidate => candidate.id === reference.id);
    if (server === undefined)
      throw new CatalogRefusal(
        'source_unknown',
        `${reference.name} is not an MCP server this machine declares any more.`,
      );
    const converted = mcpSetupOf(server);
    if (!converted.ok) throw new CatalogRefusal('source_refused', converted.reason);
    return {
      reference,
      location: describeMcpServer(server),
      name: server.name,
      harness: converted.harness,
      body: { kind: 'mcp', mcp: converted.setup } as FrozenBody,
      derived: { problem: 'An MCP setup has no description of its own.' } as { problem: string } | { summary: string },
      problems: converted.problems,
    };
  }

  /** Whether the source has changed since the latest version was frozen. */
  async #sourceState(
    identity: DaemonIdentity,
    item: StoredSharedItem,
    entry: CatalogEntry,
  ): Promise<{ state: CatalogSourceState; note?: string }> {
    if (entry.withdrawnAt !== undefined) return { state: 'withdrawn' };
    try {
      const prepared = await this.#prepare({ item, entry });
      const frozen = freezeItem(
        this.#input(identity, NORMALISED_CATALOG_ID, prepared, NORMALISED_ITEM_ID, prepared.version),
      );
      const print = await fingerprint(this.deps.crypto, frozen);
      return { state: print.contentDigest === currentVersion(item).contentDigest ? 'unchanged' : 'changed' };
    } catch (error) {
      if (error instanceof CatalogRefusal && error.refusal !== 'store_damaged')
        return { state: 'unavailable', note: error.message.slice(0, 1_024) };
      throw error;
    }
  }

  async #ownedItem(
    identity: DaemonIdentity,
    catalog: StoredCatalog,
    item: StoredSharedItem,
    entry: CatalogEntry,
    withState: boolean,
  ): Promise<OwnedCatalogItem> {
    const current = currentVersion(item);
    const { state, note } = withState ? await this.#sourceState(identity, item, entry) : {};
    return {
      itemId: item.itemId,
      kind: item.kind,
      name: item.name,
      summary: current.summary,
      ...(item.harness === undefined ? {} : { harness: item.harness }),
      source: current.source,
      current: item.current,
      ...(state === undefined ? {} : { sourceState: state }),
      ...(note === undefined ? {} : { sourceNote: note }),
      ...(entry.withdrawnAt === undefined ? {} : { withdrawnAt: entry.withdrawnAt }),
      versions: item.versions.map(version => {
        const binding = bindingOf(version, catalog.id);
        return {
          version: version.version,
          digest: binding.digest,
          size: binding.size,
          publishedAt: version.publishedAt,
        };
      }),
    };
  }

  async #owned(
    document: CatalogsDocument,
    catalog: StoredCatalog,
    identity: DaemonIdentity,
    withState = false,
  ): Promise<OwnedCatalog> {
    const items: OwnedCatalogItem[] = [];
    for (const entry of catalog.entries)
      items.push(await this.#ownedItem(identity, catalog, itemOf(document, entry.itemId), entry, withState));
    return {
      id: catalog.id,
      name: catalog.name,
      description: catalog.description,
      publisherName: catalog.publisherName,
      visibility: catalog.visibility,
      revision: catalog.revision,
      issuedAt: catalog.issuedAt,
      createdAt: catalog.createdAt,
      role: roleOf(document, catalog.id),
      items,
    };
  }

  async #published(
    document: CatalogsDocument,
    identity: DaemonIdentity,
    catalog: StoredCatalog,
    itemId: string,
  ): Promise<PublishedCatalogItem> {
    const stored = itemOf(document, itemId);
    const current = currentVersion(stored);
    return {
      catalogId: catalog.id,
      itemId,
      itemVersion: current.version,
      digest: bindingOf(current, catalog.id).digest,
      revision: catalog.revision,
      item: await this.#ownedItem(identity, catalog, stored, findEntry(catalog, itemId), true),
    };
  }
}
