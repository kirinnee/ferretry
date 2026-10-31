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
 */
import {
  CATALOG_PUBLIC_UNAVAILABLE,
  type CatalogItemPreview,
  type CatalogItemPreviewRequest,
  type CatalogItemSource,
  type CatalogSourceProblem,
  type CatalogSourceReference,
  type CatalogSourceState,
  type CreateCatalogRequest,
  type DeletedCatalog,
  type ExportCatalogRequest,
  type OwnedCatalog,
  type OwnedCatalogItem,
  type OwnedCatalogList,
  type PublishedCatalogItem,
  type SharedCatalogFile,
  SharedCatalogFileSchema,
  type SharedCatalogItem,
  SharedCatalogItemSchema,
  type SharedCatalogManifestEntry,
  type SignedCatalogManifest,
  type UpdateCatalogRequest,
  type WithdrawnCatalogItem,
  CatalogItemNameSchema,
  CatalogLabelSchema,
  SHARED_CATALOG_FILE_FORMAT,
  SHARED_CATALOG_FILE_MAX_BYTES,
  SHARED_CATALOG_MANIFEST_FORMAT,
  catalogCanonicalText,
} from '@ferretry/protocol';
import { signCatalogManifest, verifySharedCatalogFile, type DaemonIdentity, type RelayCrypto } from '@ferretry/relay';
import { basename, dirname } from 'node:path';
import {
  type StoredCatalog,
  type StoredItem,
  type StoredVersion,
  findCatalog,
  findItem,
  latestVersion,
  liveItems,
  withCatalog,
  withCatalogPatch,
  withNewItem,
  withNewVersion,
  withWithdrawn,
  withoutCatalog,
} from './document.ts';
import {
  type FrozenBody,
  NORMALISED_ITEM_ID,
  defaultMcpSummary,
  fingerprint,
  freezeItem,
  readItem,
  skillOf,
  skillSummary,
} from './freeze.ts';
import { lookupMcpServer, mcpSetupOf, describeMcpServer } from './mcp-source.ts';
import type {
  CatalogBlobStore,
  CatalogDocumentStore,
  CatalogIdentitySource,
  McpDirectory,
  SkillDirectory,
} from './ports.ts';
import { CatalogRefusal } from './refusal.ts';
import { readSkillFolder, type SkillTreePort } from './skill-source.ts';

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
  readonly existing: StoredItem | undefined;
  readonly reference: CatalogSourceReference;
  readonly body: FrozenBody;
  readonly name: string;
  readonly harness: StoredItem['harness'];
  readonly summary: string;
  readonly ownSummary: boolean;
  readonly version: number;
  readonly location: string;
  readonly problems: readonly CatalogSourceProblem[];
}

/** The characters base64url writes, for an id of 128 random bits. */
function randomId(crypto: RelayCrypto, prefix: 'cat_' | 'itm_'): string {
  const bytes = crypto.randomBytes(16);
  const text = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `${prefix}${text}`;
}

const instant = (ms: number): string => new Date(ms).toISOString();

/** The name this machine gives itself as a publisher: one clean line, at most 80 characters. */
export function publisherLabel(name: string): string {
  const cleaned = Array.from(name.trim())
    .filter(character => CatalogLabelSchema.safeParse(character).success)
    .join('')
    .trim();
  const bounded = Array.from(cleaned).slice(0, 80).join('').trim();
  return bounded === '' ? 'This machine' : bounded;
}

export class SharedCatalogService {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SharedCatalogDeps) {}

  // ── Reads ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Every catalog. Whether each source has changed is worked out only when asked: it re-reads every live
   * item's skill folder or MCP declaration, and the list is open to a ferret, which could ask in a loop.
   */
  async list(options: { readonly sourceState: boolean } = { sourceState: false }): Promise<OwnedCatalogList> {
    const identity = await this.#identity();
    const document = await this.deps.documents.read();
    const catalogs: OwnedCatalog[] = [];
    for (const catalog of document.catalogs) catalogs.push(await this.#owned(catalog, identity, options.sourceState));
    return { publisher: identity.daemonId, catalogs };
  }

  async previewItem(catalogId: string, request: CatalogItemPreviewRequest): Promise<CatalogItemPreview> {
    const identity = await this.#identity();
    const catalog = findCatalog(await this.deps.documents.read(), catalogId);
    const prepared =
      'itemId' in request
        ? await this.#prepare({ item: findItem(catalog, request.itemId) })
        : await this.#prepare({ source: request.source, summary: request.summary });
    const item = freezeItem(this.#input(identity, catalog, prepared, NORMALISED_ITEM_ID, prepared.version));
    const print = await fingerprint(this.deps.crypto, item);
    const latest = prepared.existing === undefined ? undefined : latestVersion(prepared.existing);
    return {
      catalogId: catalog.id,
      ...(prepared.existing === undefined ? {} : { itemId: prepared.existing.itemId }),
      kind: prepared.body.kind,
      name: prepared.name,
      summary: prepared.summary,
      ...(prepared.harness === undefined ? {} : { harness: prepared.harness }),
      location: prepared.location,
      version: prepared.version,
      ...(latest !== undefined && latest.contentDigest === print.contentDigest
        ? { sameAsVersion: latest.version }
        : {}),
      digest: print.contentDigest,
      size: print.size,
      ...readItem(item),
      problems: prepared.problems,
    };
  }

  // ── Catalogs ───────────────────────────────────────────────────────────────────────────────────

  create(request: CreateCatalogRequest): Promise<OwnedCatalog> {
    if (request.visibility === 'public') throw new CatalogRefusal('public_unavailable', CATALOG_PUBLIC_UNAVAILABLE);
    return this.#serially(async () => {
      const identity = await this.#identity();
      const id = randomId(this.deps.crypto, 'cat_');
      const next = withCatalog(await this.deps.documents.read(), {
        id,
        name: request.name,
        description: request.description ?? '',
        publisherName: publisherLabel(this.deps.identity.publisherName()),
        now: instant(this.deps.now()),
      });
      await this.deps.documents.write(next);
      return await this.#owned(findCatalog(next, id), identity);
    });
  }

  update(catalogId: string, request: UpdateCatalogRequest): Promise<OwnedCatalog> {
    if (request.visibility === 'public') throw new CatalogRefusal('public_unavailable', CATALOG_PUBLIC_UNAVAILABLE);
    return this.#serially(async () => {
      const identity = await this.#identity();
      const document = await this.deps.documents.read();
      const next = withCatalogPatch(document, catalogId, request, instant(this.deps.now()));
      if (next !== document) await this.deps.documents.write(next);
      return await this.#owned(findCatalog(next, catalogId), identity);
    });
  }

  remove(catalogId: string): Promise<DeletedCatalog> {
    return this.#serially(async () => {
      const next = withoutCatalog(await this.deps.documents.read(), catalogId);
      // BEFORE the catalog's own file changes: a failure in between leaves people without a catalog that still
      // exists, never holding a name for one that is gone.
      await this.deps.membership?.forgetCatalog(catalogId);
      await this.deps.documents.write(next);
      return { catalogId };
    });
  }

  // ── Items ──────────────────────────────────────────────────────────────────────────────────────

  addItem(
    catalogId: string,
    request: { readonly source: CatalogItemSource; readonly digest: string; readonly summary?: string | undefined },
  ): Promise<PublishedCatalogItem> {
    return this.#serially(async () => {
      const identity = await this.#identity();
      const document = await this.deps.documents.read();
      const catalog = findCatalog(document, catalogId);
      const prepared = await this.#prepare({ source: request.source, summary: request.summary });
      await this.#bind(identity, catalog, prepared, request.digest);
      const itemId = randomId(this.deps.crypto, 'itm_');
      const version = await this.#version(identity, catalog, prepared, itemId, 1);
      const now = instant(this.deps.now());
      const item: StoredItem = {
        itemId,
        kind: prepared.body.kind,
        name: prepared.name,
        ...(prepared.harness === undefined ? {} : { harness: prepared.harness }),
        ownSummary: prepared.ownSummary,
        versions: [version.stored(now)],
      };
      const next = withNewItem(document, catalogId, item, now);
      await this.deps.blobs.put(version.stored(now).digest, version.text);
      await this.deps.documents.write(next);
      return await this.#published(identity, findCatalog(next, catalogId), itemId);
    });
  }

  publishVersion(
    catalogId: string,
    itemId: string,
    request: { readonly digest: string },
  ): Promise<PublishedCatalogItem> {
    return this.#serially(async () => {
      const identity = await this.#identity();
      const document = await this.deps.documents.read();
      const catalog = findCatalog(document, catalogId);
      const existing = findItem(catalog, itemId);
      const prepared = await this.#prepare({ item: existing });
      await this.#bind(identity, catalog, prepared, request.digest);
      const latest = latestVersion(existing);
      const version = await this.#version(identity, catalog, prepared, itemId, prepared.version);
      if (version.contentDigest === latest.contentDigest)
        throw new CatalogRefusal(
          'nothing_to_publish',
          `${existing.name} has not changed since version ${latest.version}, so there is nothing new to publish.`,
        );
      const now = instant(this.deps.now());
      const next = withNewVersion(document, catalogId, itemId, version.stored(now), now);
      await this.deps.blobs.put(version.stored(now).digest, version.text);
      await this.deps.documents.write(next);
      return await this.#published(identity, findCatalog(next, catalogId), itemId);
    });
  }

  withdraw(catalogId: string, itemId: string): Promise<WithdrawnCatalogItem> {
    return this.#serially(async () => {
      const next = withWithdrawn(await this.deps.documents.read(), catalogId, itemId, instant(this.deps.now()));
      await this.deps.documents.write(next);
      const catalog = findCatalog(next, catalogId);
      return {
        catalogId,
        itemId,
        revision: catalog.revision,
        withdrawnAt: findItem(catalog, itemId).withdrawnAt as string,
      };
    });
  }

  // ── Export ─────────────────────────────────────────────────────────────────────────────────────

  async exportCatalog(catalogId: string, request: ExportCatalogRequest): Promise<SharedCatalogFile> {
    const identity = await this.#identity();
    const catalog = findCatalog(await this.deps.documents.read(), catalogId);
    const live = liveItems(catalog);
    const chosen = new Set(request.itemIds ?? live.map(item => item.itemId));
    for (const itemId of chosen) {
      const item = findItem(catalog, itemId);
      if (item.withdrawnAt !== undefined)
        throw new CatalogRefusal('item_withdrawn', `${item.name} was withdrawn, so it cannot be exported.`);
    }
    const items: SharedCatalogItem[] = [];
    for (const item of live) if (chosen.has(item.itemId)) items.push(await this.#frozen(item, latestVersion(item)));
    const signed = await this.#signedManifest(identity, catalog);
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
  async signedManifest(catalogId: string): Promise<SignedCatalogManifest> {
    const identity = await this.#identity();
    return await this.#signedManifest(identity, findCatalog(await this.deps.documents.read(), catalogId));
  }

  /** One frozen version of a live item, checked against the digest the document lists for it. */
  async frozenItem(catalogId: string, itemId: string, version: number): Promise<SharedCatalogItem> {
    const catalog = findCatalog(await this.deps.documents.read(), catalogId);
    const item = findItem(catalog, itemId);
    if (item.withdrawnAt !== undefined)
      throw new CatalogRefusal('item_withdrawn', `${item.name} was withdrawn, so it cannot be read.`);
    const stored = item.versions.find(candidate => candidate.version === version);
    if (stored === undefined)
      throw new CatalogRefusal('item_unknown', `${item.name} has no version ${String(version)}.`);
    return await this.#frozen(item, stored);
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────────

  async #signedManifest(identity: DaemonIdentity, catalog: StoredCatalog): Promise<SignedCatalogManifest> {
    const entries: SharedCatalogManifestEntry[] = liveItems(catalog).map(item => {
      const version = latestVersion(item);
      return {
        itemId: item.itemId,
        kind: item.kind,
        name: item.name,
        summary: version.summary,
        version: version.version,
        digest: version.digest,
        size: version.size,
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
      withdrawn: catalog.items.flatMap(item =>
        item.withdrawnAt === undefined ? [] : [{ itemId: item.itemId, at: item.withdrawnAt }],
      ),
    });
    if (!signed.ok) throw new CatalogRefusal('export_failed', signed.reason);
    return signed.value;
  }

  #serially<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
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

  /** A frozen version read back and checked against the digest this document lists for it. */
  async #frozen(item: StoredItem, version: StoredVersion): Promise<SharedCatalogItem> {
    const damaged = (why: string) =>
      new CatalogRefusal(
        'store_damaged',
        `The frozen copy of ${item.name} version ${version.version} ${why}. Nothing was changed.`,
      );
    const text = await this.deps.blobs.get(version.digest);
    if (text === undefined) throw damaged('is missing');
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw damaged('is not JSON');
    }
    const parsed = SharedCatalogItemSchema.safeParse(document);
    if (!parsed.success) throw damaged('is not a catalog item');
    const canonical = catalogCanonicalText(parsed.data);
    if (!canonical.ok) throw damaged('no longer matches its digest');
    const hash = await this.deps.crypto.sha256(new TextEncoder().encode(canonical.text));
    const digest = `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`;
    if (digest !== version.digest) throw damaged('no longer matches its digest');
    return parsed.data;
  }

  #input(identity: DaemonIdentity, catalog: StoredCatalog, prepared: Prepared, itemId: string, version: number) {
    return {
      publisher: identity.daemonId,
      catalogId: catalog.id,
      itemId,
      itemVersion: version,
      name: prepared.name,
      summary: prepared.summary,
      harness: prepared.harness,
      body: prepared.body,
    };
  }

  /** The item for this version, its text and both digests. */
  async #version(
    identity: DaemonIdentity,
    catalog: StoredCatalog,
    prepared: Prepared,
    itemId: string,
    version: number,
  ) {
    const item = freezeItem(this.#input(identity, catalog, prepared, itemId, version));
    const print = await fingerprint(this.deps.crypto, item);
    const canonical = catalogCanonicalText(item);
    const text = canonical.ok ? canonical.text : JSON.stringify(item);
    return {
      contentDigest: print.contentDigest,
      text,
      stored: (publishedAt: string): StoredVersion => ({
        version,
        digest: print.digest,
        contentDigest: print.contentDigest,
        size: print.size,
        publishedAt,
        summary: prepared.summary,
        source: prepared.reference,
      }),
    };
  }

  /** Refuses unless the source, read now, hashes to the digest the person previewed. */
  async #bind(identity: DaemonIdentity, catalog: StoredCatalog, prepared: Prepared, digest: string): Promise<void> {
    const item = freezeItem(this.#input(identity, catalog, prepared, NORMALISED_ITEM_ID, prepared.version));
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
    from: { readonly source: CatalogItemSource; readonly summary?: string | undefined } | { readonly item: StoredItem },
  ): Promise<Prepared> {
    const existing = 'item' in from ? from.item : undefined;
    if (existing?.withdrawnAt !== undefined)
      throw new CatalogRefusal('item_withdrawn', `${existing.name} was withdrawn, so it takes no new version.`);
    const reference = existing === undefined ? undefined : latestVersion(existing).source;
    const read =
      'item' in from
        ? await this.#read(reference as CatalogSourceReference)
        : await this.#read(await this.#resolve(from.source));
    if (existing !== undefined && existing.name !== read.name)
      throw new CatalogRefusal(
        'source_refused',
        `The source is now called ${read.name}, not ${existing.name}. Add it as a new item instead.`,
      );
    const own = 'item' in from ? undefined : from.summary;
    const summary =
      own ??
      (existing?.ownSummary === true
        ? latestVersion(existing).summary
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
    throw new CatalogRefusal('source_refused', 'problem' in derived ? derived.problem : 'This needs a summary.');
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
    catalog: StoredCatalog,
    item: StoredItem,
  ): Promise<{ state: CatalogSourceState; note?: string }> {
    if (item.withdrawnAt !== undefined) return { state: 'withdrawn' };
    try {
      const prepared = await this.#prepare({ item });
      const frozen = freezeItem(this.#input(identity, catalog, prepared, NORMALISED_ITEM_ID, prepared.version));
      const print = await fingerprint(this.deps.crypto, frozen);
      return { state: print.contentDigest === latestVersion(item).contentDigest ? 'unchanged' : 'changed' };
    } catch (error) {
      if (error instanceof CatalogRefusal && error.refusal !== 'store_damaged')
        return { state: 'unavailable', note: error.message.slice(0, 1_024) };
      throw error;
    }
  }

  async #ownedItem(
    identity: DaemonIdentity,
    catalog: StoredCatalog,
    item: StoredItem,
    withState: boolean,
  ): Promise<OwnedCatalogItem> {
    const latest = latestVersion(item);
    const { state, note } = withState ? await this.#sourceState(identity, catalog, item) : {};
    return {
      itemId: item.itemId,
      kind: item.kind,
      name: item.name,
      summary: latest.summary,
      ...(item.harness === undefined ? {} : { harness: item.harness }),
      source: latest.source,
      ...(state === undefined ? {} : { sourceState: state }),
      ...(note === undefined ? {} : { sourceNote: note }),
      ...(item.withdrawnAt === undefined ? {} : { withdrawnAt: item.withdrawnAt }),
      versions: item.versions.map(version => ({
        version: version.version,
        digest: version.digest,
        size: version.size,
        publishedAt: version.publishedAt,
      })),
    };
  }

  async #owned(catalog: StoredCatalog, identity: DaemonIdentity, withState = false): Promise<OwnedCatalog> {
    const items: OwnedCatalogItem[] = [];
    for (const item of catalog.items) items.push(await this.#ownedItem(identity, catalog, item, withState));
    return {
      id: catalog.id,
      name: catalog.name,
      description: catalog.description,
      publisherName: catalog.publisherName,
      visibility: catalog.visibility,
      revision: catalog.revision,
      issuedAt: catalog.issuedAt,
      createdAt: catalog.createdAt,
      items,
    };
  }

  async #published(identity: DaemonIdentity, catalog: StoredCatalog, itemId: string): Promise<PublishedCatalogItem> {
    const stored = findItem(catalog, itemId);
    const latest = latestVersion(stored);
    return {
      catalogId: catalog.id,
      itemId,
      itemVersion: latest.version,
      digest: latest.digest,
      revision: catalog.revision,
      item: await this.#ownedItem(identity, catalog, stored, true),
    };
  }
}
