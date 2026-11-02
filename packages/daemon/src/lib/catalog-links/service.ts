/**
 * The owner side of download links (docs/catalogs.md § Links): preview what a link would carry, mint one, list
 * them, copy a public one, and turn one off.
 *
 * ## Who holds what
 *
 * A link's key opens its bundle, and the key is in the URL fragment, which the store never sees. This machine
 * holds a PUBLIC link's key, sealed in the vault, so the owner can Copy the link again; it holds a ONE-TIME link's
 * key nowhere. The key appears in exactly two answers: the mint that made the link, and Copy.
 *
 * ## Fail closed
 *
 * - The store is down while minting: nothing is kept, and the answer says so.
 * - Turning a link off cannot reach the store: the record says `ending`, the answer says the link may still work,
 *   and the daemon keeps trying. A link is `ended` only after the store has deleted it.
 * - Copy never contacts the store, and no operation falls back to another store: a link's later calls go to the
 *   origin recorded when it was uploaded.
 *
 * ## Writes are one at a time
 *
 * The file is read, changed and written whole, so two writes at once would lose one. They queue.
 */
import {
  CATALOG_LINK_BUNDLE_FORMAT,
  CATALOG_LINK_EXPIRY_MS,
  CATALOG_LINK_FORMAT,
  CATALOG_LINKS_MAX_LIVE,
  catalogCanonicalText,
  type CatalogLinkPreview,
  type CatalogLinkPreviewRequest,
  type CatalogLinkStoreStatus,
  type CatalogLinkUrl,
  catalogLinkUrl,
  type CreateCatalogLinkRequest,
  type CreatedCatalogLink,
  LINK_ITEM_CATALOG_ID,
  LINK_MAX_LEASE_MS,
  LINK_TOO_BIG_SENTENCE,
  type OwnedCatalogLink,
  type OwnedCatalogLinkList,
  type SharedCatalogLink,
  type SharedCatalogLinkBundle,
} from '@ferretry/protocol';
import {
  catalogItemCanonical,
  type DaemonIdentity,
  LINK_ENVELOPE_MAX_BYTES,
  LINK_STORE_REFUSAL_DETAIL,
  linkEnvelopeSize,
  linkFetchToken,
  linkFetchVerifier,
  mintLinkSecrets,
  type RelayCrypto,
  sealLinkEnvelope,
  signCatalogLink,
  toBase64Url,
} from '@ferretry/relay';
import { itemForCatalog, readItem } from '../shared-catalogs/freeze.ts';
import { CatalogRefusal } from '../shared-catalogs/refusal.ts';
import {
  type CatalogIdentitySource,
  LinkSourceChanged,
  type LinkSubject,
  publisherLabel,
} from '../shared-catalogs/index.ts';
import { type LinksDocument, type StoredLink, findLink, heldCount, pruned, withLink, withoutLink } from './document.ts';
import type { LinkDocumentStore, LinkItems, LinkKeyVault, LinkStoreClient, LinkStoreLocator } from './ports.ts';
import { CatalogLinkRefusal, isLinkRefusalCode } from './refusal.ts';

export interface CatalogLinkDeps {
  readonly documents: LinkDocumentStore;
  readonly vault: LinkKeyVault;
  readonly locator: LinkStoreLocator;
  readonly client: LinkStoreClient;
  readonly items: LinkItems;
  readonly identity: CatalogIdentitySource;
  readonly crypto: RelayCrypto;
  readonly now: () => number;
  /** The hosted app's origin: the page a link opens. */
  readonly appOrigin: string;
  /** A number in [0, 1) for the retry jitter. */
  readonly random: () => number;
}

/** A count is refreshed from the store at most this often. */
export const LINK_REFRESH_MS = 60_000;
export const LINK_RETRY_MIN_MS = 30_000;
export const LINK_RETRY_MAX_MS = 10 * 60_000;
const STATUS_BATCH = 64;

const STORE_SILENT =
  'The link store did not answer, so the link may have been made. Check your links, and turn it off if you do not want it.';
const NOT_THE_PUBLISHER =
  "This link was made under this machine's previous identity, so it cannot be turned off from here.";
const REVOKE_UNREACHABLE =
  'Turning it off could not reach the link store, so the link may still work. Ferretry keeps trying.';
const SIGNING_UNAVAILABLE =
  "This machine's identity cannot be read, so it cannot make a link. Restart the daemon, and check its log.";

const instant = (ms: number): string => new Date(ms).toISOString();

const isHeld = (link: StoredLink): boolean =>
  link.state === 'pending' || link.state === 'live' || link.state === 'ending';

/** When the store stops serving a link by itself: its own end, or its lease, whichever comes first. */
const linkEnd = (link: StoredLink): number =>
  Math.min(Date.parse(link.expiresAt ?? link.notAfter), Date.parse(link.notAfter));

interface EndAttempt {
  readonly link: StoredLink;
  /** `not-publisher`: the store refused as it does a stranger, and this machine is not the one that made the link. */
  readonly outcome: 'settled' | 'retry' | 'not-publisher';
}

/** What the owner sees of a stored link: never the bundle id, the store, a key or a URL. */
function owned(link: StoredLink, storeState?: 'ok' | 'unreachable'): OwnedCatalogLink {
  return {
    linkId: link.linkId,
    itemId: link.itemId,
    name: link.name,
    itemKind: link.itemKind,
    version: link.version,
    kind: link.kind,
    state: link.state,
    createdAt: link.createdAt,
    servedSince: link.servedSince,
    ...(link.expiresAt === undefined ? {} : { expiresAt: link.expiresAt }),
    ...(link.installCap === undefined ? {} : { installCap: link.installCap }),
    opens: link.opens,
    ...(link.opensCheckedAt === undefined ? {} : { opensCheckedAt: link.opensCheckedAt }),
    ...(storeState === undefined ? {} : { storeState }),
    ...(link.endedAt === undefined ? {} : { endedAt: link.endedAt }),
  };
}

type Selection = Parameters<LinkItems['linkSubject']>[0];

const selectionOf = (request: CatalogLinkPreviewRequest | CreateCatalogLinkRequest['item']): Selection =>
  'itemId' in request ? { itemId: request.itemId, version: request.version } : { source: request.source };

export class CatalogLinkService {
  #queue: Promise<unknown> = Promise.resolve();
  readonly #retries = new Map<string, { readonly attempts: number; readonly nextAt: number }>();
  #storeAnswer: { readonly at: number; readonly status: CatalogLinkStoreStatus } | undefined;
  /** When each store last failed a status call: it is not asked again for a minute, so a polling reader cannot hammer it. */
  readonly #statusFailedAt = new Map<string, number>();

  constructor(private readonly deps: CatalogLinkDeps) {}

  // ── The store ──────────────────────────────────────────────────────────────────────────────────

  /** Whether links can be made now, from the store's own advertisement, remembered for 60 seconds. */
  async storeStatus(): Promise<CatalogLinkStoreStatus> {
    const now = this.deps.now();
    if (this.#storeAnswer !== undefined && now - this.#storeAnswer.at < LINK_REFRESH_MS)
      return this.#storeAnswer.status;
    const site = await this.deps.locator.locate();
    const status: CatalogLinkStoreStatus =
      site.kind === 'ready'
        ? { available: true, origin: site.origin, sentence: 'Download links are on.' }
        : { available: false, sentence: site.reason };
    this.#storeAnswer = { at: now, status };
    return status;
  }

  // ── Preview ────────────────────────────────────────────────────────────────────────────────────

  /** What a link would carry, read and frozen as the person will see it. Writes nothing and calls no store. */
  async preview(request: CatalogLinkPreviewRequest): Promise<CatalogLinkPreview> {
    const identity = await this.#identity();
    const subject = await this.#subject(selectionOf(request));
    const issued = this.deps.now();
    const text = await this.#bundleText(identity, subject, {
      linkId: 'lnk_AAAAAAAAAAAAAAAAAAAAAA',
      bundleId: 'AAAAAAAAAAAAAAAAAAAAAA',
      kind: 'public',
      sequence: 1,
      issuedAt: instant(issued),
      notAfter: instant(issued + LINK_MAX_LEASE_MS),
    });
    const size = linkEnvelopeSize(text);
    return {
      ...(subject.newItem ? {} : { itemId: subject.itemId, version: subject.version }),
      newItem: subject.newItem,
      name: subject.name,
      itemKind: subject.kind,
      summary: subject.summary,
      ...readItem(this.#itemOf(subject)),
      problems: subject.problems,
      location: subject.location,
      digest: subject.contentDigest,
      envelopeBytes: size ?? LINK_ENVELOPE_MAX_BYTES,
      tooBig: size === null,
    };
  }

  // ── Mint ───────────────────────────────────────────────────────────────────────────────────────

  mint(request: CreateCatalogLinkRequest): Promise<CreatedCatalogLink> {
    return this.#serially(async () => {
      const site = await this.deps.locator.locate();
      if (site.kind === 'unavailable') throw new CatalogLinkRefusal('link_store_unavailable', site.reason);
      const identity = await this.#identity();
      const document = await this.deps.documents.read();
      if (heldCount(document.links) >= CATALOG_LINKS_MAX_LIVE)
        throw new CatalogLinkRefusal(
          'links_full',
          `This machine keeps at most ${CATALOG_LINKS_MAX_LIVE} links on. Turn one off to make another.`,
        );
      const summary = 'source' in request.item ? request.item.summary : undefined;
      const subject = await this.#subject(selectionOf(request.item), summary);
      if (subject.contentDigest !== request.item.digest)
        throw new CatalogLinkRefusal(
          'changed_since_preview',
          `${subject.name} changed since you previewed it. Preview it again, read what it holds now, and then confirm.`,
        );

      const now = this.deps.now();
      const issuedAt = instant(now);
      const lifetime = CATALOG_LINK_EXPIRY_MS[request.expires];
      const expiresAt = lifetime === null ? undefined : instant(now + lifetime);
      const notAfter = instant(Math.min(now + LINK_MAX_LEASE_MS, now + (lifetime ?? LINK_MAX_LEASE_MS)));
      const linkId = `lnk_${toBase64Url(this.deps.crypto.randomBytes(16))}`;
      const { key, bundleId } = mintLinkSecrets(this.deps.crypto);
      const text = await this.#bundleText(identity, subject, {
        linkId,
        bundleId,
        kind: request.kind,
        sequence: 1,
        issuedAt,
        notAfter,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      const sealed = await sealLinkEnvelope(this.deps.crypto, key, bundleId, 1, text);
      if (!sealed.ok) throw new CatalogLinkRefusal('link_too_big', LINK_TOO_BIG_SENTENCE);
      const token = await linkFetchToken(this.deps.crypto, key, bundleId);
      const verifier = token === null ? null : await linkFetchVerifier(this.deps.crypto, token);
      if (verifier === null) throw new Error('A link key could not be turned into a fetch verifier.');

      const pendingUpload = {
        sequence: 1,
        version: subject.version,
        notAfter,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(request.installCap === undefined ? {} : { installCap: request.installCap }),
      };
      const record: StoredLink = {
        linkId,
        itemId: subject.itemId,
        name: subject.name,
        itemKind: subject.kind,
        version: subject.version,
        kind: request.kind,
        state: 'pending',
        createdAt: issuedAt,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(request.installCap === undefined ? {} : { installCap: request.installCap }),
        opens: 0,
        bundleId,
        publisher: identity.daemonId,
        storeOrigin: site.origin,
        emitsStoreOrigin: site.selfHosted,
        sequence: 1,
        issuedAt,
        notAfter,
        servedSince: issuedAt,
        ...(request.kind === 'public' ? { keyRef: linkId } : {}),
        pendingUpload,
      };
      // The key is sealed BEFORE the record that names it, and the record is written BEFORE the upload: a crash in
      // between leaves a pending record the next boot settles, never a link on the store nobody knows about.
      if (request.kind === 'public') await this.deps.vault.put(linkId, key);
      await this.deps.documents.write(withLink(document, record));

      const uploaded = await this.deps.client.upload(site.origin, {
        bundleId,
        action: 'create',
        kind: request.kind,
        sequence: 1,
        notAfter,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(request.installCap === undefined ? {} : { installCap: request.installCap }),
        fetchVerifier: verifier,
        envelope: sealed.value,
      });
      if (!uploaded.ok) {
        // A refusal is a definite no, so nothing is kept. An answer that never came may still have been a yes:
        // the pending record stays and the next reconciliation asks the store.
        if (uploaded.reason === 'refused') await this.#drop(linkId);
        throw uploaded.reason === 'refused' && uploaded.code === 'link_too_big'
          ? new CatalogLinkRefusal('link_too_big', LINK_TOO_BIG_SENTENCE)
          : new CatalogLinkRefusal(
              'link_store_unavailable',
              uploaded.reason === 'refused' ? LINK_STORE_REFUSAL_DETAIL[uploaded.code].message : STORE_SILENT,
            );
      }

      try {
        await subject.keep?.();
      } catch (error) {
        // The store has the bundle and this machine could not keep the item behind it: take the bundle back down.
        await this.#attemptEnd(record, 'item-gone');
        throw error;
      }
      const live: StoredLink = { ...record, state: 'live' };
      delete (live as { pendingUpload?: unknown }).pendingUpload;
      const next = withLink(await this.deps.documents.read(), live);
      await this.deps.documents.write(pruned(next, now));
      const url = catalogLinkUrl(this.deps.appOrigin, {
        bundleId,
        key,
        publisher: identity.daemonId,
        ...(site.selfHosted ? { storeOrigin: site.origin } : {}),
      });
      return { link: owned(live), url };
    });
  }

  // ── Read ───────────────────────────────────────────────────────────────────────────────────────

  async list(itemId?: string): Promise<OwnedCatalogLinkList> {
    const identity = await this.#identity();
    const { document, states } = await this.#refreshed();
    return {
      publisher: identity.daemonId,
      links: document.links
        .filter(link => itemId === undefined || link.itemId === itemId)
        .map(link => owned(link, states.get(link.linkId))),
      max: CATALOG_LINKS_MAX_LIVE,
    };
  }

  async get(linkId: string): Promise<OwnedCatalogLink> {
    const { document, states } = await this.#refreshed();
    return owned(this.#found(document, linkId), states.get(linkId));
  }

  /** The URL of a public link that is live, from the sealed key. The store is not asked. */
  async copy(linkId: string): Promise<CatalogLinkUrl> {
    const identity = await this.#identity();
    const link = this.#found(await this.deps.documents.read(), linkId);
    if (link.kind !== 'public')
      throw new CatalogLinkRefusal('link_not_public', 'A one-time link was shown once, when it was made.');
    if (link.state !== 'live') throw new CatalogLinkRefusal('link_not_live', 'This link is not on any more.');
    const key = await this.deps.vault.open(linkId);
    if (key === undefined)
      throw new CatalogLinkRefusal('link_not_live', 'This machine no longer holds the key to this link.');
    return {
      url: catalogLinkUrl(this.deps.appOrigin, {
        bundleId: link.bundleId,
        key,
        publisher: identity.daemonId,
        ...(link.emitsStoreOrigin ? { storeOrigin: link.storeOrigin } : {}),
      }),
    };
  }

  // ── Turn off ───────────────────────────────────────────────────────────────────────────────────

  /** Deletes the bundle at the store, then ends the link. If the store cannot be reached the link is `ending` and the daemon retries. */
  revoke(linkId: string): Promise<OwnedCatalogLink> {
    return this.#serially(async () => {
      const link = this.#found(await this.deps.documents.read(), linkId);
      if (!isHeld(link)) return owned(link);
      const attempt = await this.#attemptEnd(link, 'owner');
      if (attempt.outcome === 'not-publisher')
        throw new CatalogLinkRefusal(
          'signing_unavailable',
          `${NOT_THE_PUBLISHER} It stops working by ${instant(linkEnd(link))}.`,
        );
      if (attempt.outcome === 'retry') throw new CatalogLinkRefusal('link_store_unavailable', REVOKE_UNREACHABLE);
      return owned(attempt.link);
    });
  }

  // ── Reconciliation ─────────────────────────────────────────────────────────────────────────────

  /**
   * Finishes what a crash or a lost connection left half done. Run at boot and on a timer:
   * - `pending`: the store is asked. If it has that upload, a one-time link is taken down (nobody was ever given
   *   its key) and a public link is made live; otherwise the record and its key are dropped.
   * - a live link with an unconfirmed upload: committed when the store has that sequence, dropped otherwise.
   * - `ending`: the delete is tried again, with a pause that grows to ten minutes.
   * A store that cannot be reached leaves every record as it was.
   */
  reconcile(): Promise<void> {
    return this.#serially(async () => {
      const now = this.deps.now();
      for (const link of (await this.deps.documents.read()).links) {
        if (link.state === 'pending') await this.#settle(link, 'create');
        else if (link.state === 'live' && link.pendingUpload !== undefined) await this.#settle(link, 'replace');
        else if (link.state === 'ending' && (this.#retries.get(link.linkId)?.nextAt ?? 0) <= now)
          await this.#attemptEnd(link, link.endReason ?? 'owner');
      }
    });
  }

  async #settle(link: StoredLink, action: 'create' | 'replace'): Promise<void> {
    const pending = link.pendingUpload;
    const status = await this.deps.client.status(link.storeOrigin, [link.bundleId]);
    if (!status.ok || pending === undefined) return;
    const entry = status.value.links.find(candidate => candidate.bundleId === link.bundleId);
    const stored = entry?.state === 'live' && entry.sequence === pending.sequence;
    if (!stored) {
      if (action === 'create') await this.#drop(link.linkId);
      else await this.#write(link.linkId, ({ pendingUpload: _dropped, ...rest }) => rest);
      return;
    }
    if (action === 'create') {
      if (link.kind === 'one-time') {
        await this.#attemptEnd(link, 'owner');
        return;
      }
      if (!(await this.deps.items.holdsLinkVersion(link.itemId, pending.version))) {
        await this.#attemptEnd(link, 'item-gone');
        return;
      }
    }
    await this.#write(link.linkId, ({ pendingUpload: _committed, ...rest }) => ({
      ...rest,
      state: 'live',
      version: pending.version,
      sequence: pending.sequence,
      notAfter: pending.notAfter,
      ...(pending.expiresAt === undefined ? {} : { expiresAt: pending.expiresAt }),
      ...(pending.installCap === undefined ? {} : { installCap: pending.installCap }),
    }));
  }

  /**
   * Deletes the bundle, then ends the link. A store that says the bundle is gone has already done what was asked.
   *
   * `link_unknown` is what the store says both to "no such bundle" and to "not your bundle", so it counts as done
   * ONLY while the identity that uploaded the link is still this machine's. Under another identity the link may be
   * live and cannot be touched from here: it keeps its record and its key, retries slowly, and is ended as `expired`
   * once its own end has passed. Any other failure leaves the link `ending` and schedules the next try.
   */
  async #attemptEnd(link: StoredLink, reason: NonNullable<StoredLink['endReason']>): Promise<EndAttempt> {
    const answer = await this.deps.client.remove(link.storeOrigin, link.bundleId);
    const now = this.deps.now();
    const refusal = !answer.ok && answer.reason === 'refused' ? answer.code : undefined;
    const notPublisher =
      refusal === 'link_unknown' && (await this.deps.identity.identity())?.daemonId !== link.publisher;
    if (notPublisher && linkEnd(link) <= now) {
      this.#retries.delete(link.linkId);
      const lapsed = await this.#write(link.linkId, ({ pendingUpload: _dropped, ...rest }) => ({
        ...rest,
        state: 'expired',
        endedAt: instant(linkEnd(link)),
        endReason: 'expired',
      }));
      if (link.keyRef !== undefined) await this.deps.vault.forget(link.keyRef);
      return { link: lapsed, outcome: 'settled' };
    }
    if (answer.ok || ((refusal === 'link_unknown' || refusal === 'link_gone') && !notPublisher)) {
      this.#retries.delete(link.linkId);
      const ended = await this.#write(link.linkId, ({ pendingUpload: _dropped, ...rest }) => ({
        ...rest,
        state: 'ended',
        endedAt: instant(now),
        endReason: reason,
      }));
      if (link.keyRef !== undefined) await this.deps.vault.forget(link.keyRef);
      return { link: ended, outcome: 'settled' };
    }
    const attempts = (this.#retries.get(link.linkId)?.attempts ?? 0) + 1;
    const base = Math.min(LINK_RETRY_MIN_MS * 2 ** (attempts - 1), LINK_RETRY_MAX_MS);
    this.#retries.set(link.linkId, { attempts, nextAt: now + base / 2 + (this.deps.random() * base) / 2 });
    const waiting = await this.#write(link.linkId, ({ pendingUpload: _dropped, ...rest }) => ({
      ...rest,
      state: 'ending',
      endReason: reason,
    }));
    return { link: waiting, outcome: notPublisher ? 'not-publisher' : 'retry' };
  }

  // ── The file ───────────────────────────────────────────────────────────────────────────────────

  /** Rewrites one link of the file as it is NOW, so a change made while a store call was out is not lost. */
  async #write(linkId: string, change: (link: StoredLink) => Omit<StoredLink, never>): Promise<StoredLink> {
    const document = await this.deps.documents.read();
    const next = change(this.#found(document, linkId)) as StoredLink;
    await this.deps.documents.write(pruned(withLink(document, next), this.deps.now()));
    return next;
  }

  /** Forgets a link that never reached the store, and the key made for it. */
  async #drop(linkId: string): Promise<void> {
    await this.deps.documents.write(withoutLink(await this.deps.documents.read(), linkId));
    await this.deps.vault.forget(linkId);
  }

  /**
   * The file with each live link's end applied, and the opens of those not checked for a minute refreshed from
   * the store, once per store. A store that cannot be reached leaves the last count, marked `unreachable`.
   */
  #refreshed(): Promise<{
    readonly document: LinksDocument;
    readonly states: ReadonlyMap<string, 'ok' | 'unreachable'>;
  }> {
    return this.#serially(async () => {
      const now = this.deps.now();
      const original = await this.deps.documents.read();
      const states = new Map<string, 'ok' | 'unreachable'>();
      const forgotten: string[] = [];
      let links = original.links.map(link => {
        if (link.state !== 'live') return link;
        const end = linkEnd(link);
        if (end > now) return link;
        if (link.keyRef !== undefined) forgotten.push(link.keyRef);
        return { ...link, state: 'expired' as const, endedAt: instant(end), endReason: 'expired' as const };
      });
      const stale = links.filter(
        link =>
          link.state === 'live' &&
          (link.opensCheckedAt === undefined || now - Date.parse(link.opensCheckedAt) >= LINK_REFRESH_MS),
      );
      for (const link of links) if (link.state === 'live') states.set(link.linkId, 'ok');
      const origins = [...new Set(stale.map(link => link.storeOrigin))];
      for (const origin of origins) {
        const here = stale.filter(link => link.storeOrigin === origin);
        for (let at = 0; at < here.length; at += STATUS_BATCH) {
          const batch = here.slice(at, at + STATUS_BATCH);
          const failedAt = this.#statusFailedAt.get(origin);
          const answer =
            failedAt !== undefined && now - failedAt < LINK_REFRESH_MS
              ? undefined
              : await this.deps.client.status(
                  origin,
                  batch.map(link => link.bundleId),
                );
          if (answer === undefined || !answer.ok) {
            if (answer !== undefined) this.#statusFailedAt.set(origin, now);
            for (const link of batch) states.set(link.linkId, 'unreachable');
            continue;
          }
          this.#statusFailedAt.delete(origin);
          links = links.map(link => {
            const entry = batch.some(candidate => candidate.linkId === link.linkId)
              ? answer.value.links.find(candidate => candidate.bundleId === link.bundleId)
              : undefined;
            if (entry === undefined) return link;
            const counted = { ...link, opens: entry.opens ?? link.opens, opensCheckedAt: instant(now) };
            if (entry.state === 'used')
              return { ...counted, state: 'used' as const, endedAt: instant(now), endReason: 'used' as const };
            if (entry.state === 'lapsed' || entry.state === 'ended') {
              if (link.keyRef !== undefined) forgotten.push(link.keyRef);
              return {
                ...counted,
                state: entry.state === 'lapsed' ? ('expired' as const) : ('ended' as const),
                endedAt: instant(now),
                endReason: entry.state === 'lapsed' ? ('expired' as const) : ('owner' as const),
              };
            }
            return counted;
          });
        }
      }
      const document: LinksDocument = pruned({ ...original, links }, now);
      if (JSON.stringify(document) !== JSON.stringify(original)) {
        await this.deps.documents.write(document);
        for (const linkId of forgotten) await this.deps.vault.forget(linkId);
      }
      return { document, states };
    });
  }

  // ── Building a link ────────────────────────────────────────────────────────────────────────────

  async #subject(selection: Selection, summary?: string): Promise<LinkSubject> {
    try {
      return await this.deps.items.linkSubject(selection, summary);
    } catch (error) {
      if (error instanceof LinkSourceChanged) throw new CatalogLinkRefusal('item_source_changed', error.message);
      if (error instanceof CatalogRefusal && isLinkRefusalCode(error.refusal))
        throw new CatalogLinkRefusal(error.refusal, error.message);
      throw error;
    }
  }

  #itemOf(subject: LinkSubject) {
    return itemForCatalog(subject.shared, {
      catalogId: LINK_ITEM_CATALOG_ID,
      itemId: subject.itemId,
      itemVersion: subject.version,
    });
  }

  /** The canonical text of the bundle: the signed document and the item it signs. */
  async #bundleText(
    identity: DaemonIdentity,
    subject: LinkSubject,
    fields: Pick<
      SharedCatalogLink,
      'linkId' | 'bundleId' | 'kind' | 'sequence' | 'issuedAt' | 'notAfter' | 'expiresAt'
    >,
  ): Promise<string> {
    const item = this.#itemOf(subject);
    const canonical = await catalogItemCanonical(this.deps.crypto, item);
    if (canonical === null)
      throw new CatalogLinkRefusal('signing_unavailable', `${subject.name} has no one canonical spelling.`);
    const link: SharedCatalogLink = {
      format: CATALOG_LINK_FORMAT,
      version: 1,
      publisher: identity.daemonId,
      publisherName: publisherLabel(this.deps.identity.publisherName()),
      ...fields,
      item: {
        itemId: subject.itemId,
        kind: subject.kind,
        name: subject.name,
        summary: subject.summary,
        version: subject.version,
        digest: canonical.digest,
        size: canonical.size,
        publishedAt: subject.publishedAt,
        ...(subject.harness === undefined ? {} : { harness: subject.harness }),
      },
    };
    const signed = await signCatalogLink(this.deps.crypto, identity, link);
    if (!signed.ok) throw new CatalogLinkRefusal('signing_unavailable', signed.reason);
    const bundle: SharedCatalogLinkBundle = {
      format: CATALOG_LINK_BUNDLE_FORMAT,
      version: 1,
      signedLink: signed.value,
      item,
    };
    const text = catalogCanonicalText(bundle);
    if (!text.ok) throw new CatalogLinkRefusal('signing_unavailable', 'This link has no one canonical spelling.');
    return text.text;
  }

  async #identity(): Promise<DaemonIdentity> {
    const identity = await this.deps.identity.identity();
    if (identity === undefined) throw new CatalogLinkRefusal('signing_unavailable', SIGNING_UNAVAILABLE);
    return identity;
  }

  #found(document: LinksDocument, linkId: string): StoredLink {
    const link = findLink(document, linkId);
    if (link === undefined) throw new CatalogLinkRefusal('link_unknown', 'This machine has no such link.');
    return link;
  }

  #serially<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
