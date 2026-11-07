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
  type MoveCatalogLinkRequest,
  LINK_ITEM_CATALOG_ID,
  LINK_MAX_LEASE_MS,
  LINK_TOO_BIG_SENTENCE,
  type OwnedCatalogLink,
  type OwnedCatalogLinkList,
  type SharedCatalogLink,
  type SharedCatalogLinkBundle,
  type UpdateCatalogLinkRequest,
} from '../boundary.ts';
import {
  catalogItemCanonical,
  type CatalogSigningIdentity,
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
} from '../../adapters/relay.ts';
import { itemForCatalog, readItem } from '../shared-catalogs/freeze.ts';
import { CatalogRefusal } from '../shared-catalogs/refusal.ts';
import {
  type CatalogIdentitySource,
  LinkSourceChanged,
  type LinkSubject,
  publisherLabel,
} from '../shared-catalogs/service.ts';
import {
  type LinksDocument,
  type PendingUpload,
  type StoredLink,
  findLink,
  heldCount,
  pruned,
  withLink,
  withoutLink,
} from './document.ts';
import type {
  LinkAuditSink,
  LinkDocumentStore,
  LinkItems,
  LinkKeyVault,
  LinkStoreClient,
  LinkStoreLocator,
} from './ports.ts';
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
  /** Told when a link is put back after the store let it lapse. Absent in a build with no audit log. */
  readonly audit?: LinkAuditSink;
}

/** A count is refreshed from the store at most this often. */
export const LINK_REFRESH_MS = 60_000;
export const LINK_RETRY_MIN_MS = 30_000;
export const LINK_RETRY_MAX_MS = 10 * 60_000;
const STATUS_BATCH = 64;
/** A public link is re-signed once its lease has less than this left: a week after the last refresh. */
export const LINK_RENEW_WITHIN_MS = 23 * 24 * 60 * 60 * 1000;

const STORE_SILENT =
  'The link store did not answer, so the link may have been made. Check your links, and turn it off if you do not want it.';
const NOT_THE_PUBLISHER =
  "This link was made under this machine's previous identity, so it cannot be turned off from here.";
const REVOKE_UNREACHABLE =
  'Turning it off could not reach the link store, so the link may still work. Ferretry keeps trying.';
const STORE_SILENT_CHANGE =
  'The link store did not answer, so the change may have been made. Check the link again in a minute.';
const STORE_DID_NOT_TAKE_IT = 'The link store did not take that change, so the link is as it was.';
const CHANGE_WAITING = 'An earlier change to this link is still waiting for the link store. Try again in a minute.';
const SIGNING_UNAVAILABLE =
  "This machine's identity cannot be read, so it cannot make a link. Restart the daemon, and check its log.";

const instant = (ms: number): string => new Date(ms).toISOString();

const isHeld = (link: StoredLink): boolean =>
  link.state === 'pending' || link.state === 'live' || link.state === 'ending';

const isEnded = (link: StoredLink): boolean =>
  link.state === 'ended' || link.state === 'expired' || link.state === 'used';

/** When the store stops serving a link by itself: its own end, or its lease, whichever comes first. */
const linkEnd = (link: StoredLink): number =>
  Math.min(Date.parse(link.expiresAt ?? link.notAfter), Date.parse(link.notAfter));

/** The end of an upload the store may have taken though its answer never came. */
const pendingEnd = (pending: PendingUpload): number =>
  Math.min(Date.parse(pending.expiresAt ?? pending.notAfter), Date.parse(pending.notAfter));

/** When the store may stop serving a link: the later of its committed end and an unanswered upload's. */
const servedUntil = (link: StoredLink): number =>
  link.pendingUpload === undefined ? linkEnd(link) : Math.max(linkEnd(link), pendingEnd(link.pendingUpload));

/**
 * When the owner's own end for a link has passed for good. A one-time link is over when the store stops serving it.
 * A public link is renewed, so a lapsed 30-day lease alone is not its end: only an `expiresAt` is (the later of the
 * committed one and an unanswered upload's, for the upload may be what the store serves).
 */
const finalEnd = (link: StoredLink): number => {
  if (link.kind === 'one-time') return servedUntil(link);
  const own = (expiresAt: string | undefined): number => (expiresAt === undefined ? Infinity : Date.parse(expiresAt));
  return Math.max(
    own(link.expiresAt),
    link.pendingUpload === undefined ? -Infinity : own(link.pendingUpload.expiresAt),
  );
};

/** The record without its unanswered upload, whose latest possible end is kept: dropping it never shortens how long the store may serve the link. */
function withoutPending(link: StoredLink): StoredLink {
  const { pendingUpload: _dropped, ...rest } = link;
  const stops = servedUntil(link);
  return stops > linkEnd(link)
    ? { ...rest, notAfter: instant(stops), ...(link.expiresAt === undefined ? {} : { expiresAt: instant(stops) }) }
    : rest;
}

/** A link made under another identity: ended, with the latest instant the store may still serve it. */
function stranded(link: StoredLink, now: number): StoredLink {
  return {
    ...withoutPending(link),
    state: 'ended',
    endedAt: instant(now),
    endReason: 'identity-changed',
  };
}

interface EndAttempt {
  readonly link: StoredLink;
  /** `not-publisher`: the store refused as it does a stranger, and this machine is not the one that made the link. */
  readonly outcome: 'settled' | 'retry' | 'not-publisher';
}

/** What the owner sees of a stored link: never the bundle id, the store, a key or a URL. */
function owned(link: StoredLink, storeState?: 'ok' | 'unreachable' | 'lapsed'): OwnedCatalogLink {
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
    ...(link.kind === 'public' ? { sequence: link.sequence } : {}),
    ...(link.movedFrom === undefined ? {} : { movedFrom: link.movedFrom }),
    ...(link.revivedAt === undefined ? {} : { revivedAt: link.revivedAt }),
    ...(link.endReason === undefined || !isEnded(link) ? {} : { endReason: link.endReason }),
    ...(link.endReason === 'identity-changed' ? { stopsBy: instant(linkEnd(link)) } : {}),
  };
}

/** The one sentence the list says when the store let a link lapse, or a changed identity left links it cannot touch. */
function listSentence(
  links: readonly StoredLink[],
  states: ReadonlyMap<string, 'ok' | 'unreachable' | 'lapsed'>,
  now: number,
): string | undefined {
  const lapsed = links.filter(link => states.get(link.linkId) === 'lapsed').length;
  const stranded = links.filter(link => link.endReason === 'identity-changed' && linkEnd(link) > now).length;
  const parts = [
    ...(lapsed === 0
      ? []
      : [
          `${lapsed === 1 ? '1 link was' : `${lapsed} links were`} dropped by the link store while this machine was off, and ${lapsed === 1 ? 'is' : 'are'} put back the next time this machine checks.`,
        ]),
    ...(stranded === 0
      ? []
      : [
          `${stranded === 1 ? '1 link was' : `${stranded} links were`} made under this machine's previous identity, so ${stranded === 1 ? 'it' : 'they'} cannot be changed or turned off from here. ${stranded === 1 ? 'It stops' : 'They stop'} working when the lease ends.`,
        ]),
  ];
  return parts.length === 0 ? undefined : parts.join(' ');
}

/** What a change to a public link's document changes; a field left out stays as it is. */
interface Change {
  readonly version?: number;
  /** The digest the person reviewed for `version`. */
  readonly digest?: string;
  /** `null` removes the end. */
  readonly expiresAt?: string | null;
  /** `null` removes the cap. */
  readonly installCap?: number | null;
  /** The store had lapsed the link: upload it again with action `create`. */
  readonly revive?: boolean;
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
  // read-scoped: none — public store availability and held-link counts carry no file or secret text.
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
      // A version retired between the read above and the record just written would be served though retired; once the
      // record is written a retire sees it and is refused, so this is the last moment to notice.
      if (!subject.newItem && !(await this.deps.items.holdsLinkVersion(subject.itemId, subject.version))) {
        await this.#drop(linkId);
        throw new CatalogLinkRefusal('version_retired', `${subject.name} version ${subject.version} was retired.`);
      }

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
      return { link: owned(live), url, created: subject.newItem };
    });
  }

  // ── Read ───────────────────────────────────────────────────────────────────────────────────────

  async list(itemId?: string): Promise<OwnedCatalogLinkList> {
    const identity = await this.#identity();
    const { document, states } = await this.#refreshed();
    const sentence = listSentence(document.links, states, this.deps.now());
    return {
      publisher: identity.daemonId,
      links: document.links
        .filter(link => itemId === undefined || link.itemId === itemId)
        .map(link => owned(link, states.get(link.linkId))),
      max: CATALOG_LINKS_MAX_LIVE,
      ...(sentence === undefined ? {} : { sentence }),
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
          `${NOT_THE_PUBLISHER} It stops working by ${instant(servedUntil(link))}.`,
        );
      if (attempt.outcome === 'retry') throw new CatalogLinkRefusal('link_store_unavailable', REVOKE_UNREACHABLE);
      return owned(attempt.link);
    });
  }

  // ── Move, change, refresh ──────────────────────────────────────────────────────────────────────

  /** Moves a public link to another version of the same item: the same URL and key, a new document. */
  move(linkId: string, request: MoveCatalogLinkRequest): Promise<OwnedCatalogLink> {
    return this.#serially(async () => {
      const link = await this.#livePublic(linkId);
      if (link.version !== request.from)
        throw new CatalogLinkRefusal(
          'current_changed',
          `This link serves version ${link.version} now, not version ${request.from}. Look at it again before moving it.`,
        );
      if (request.version === link.version)
        throw new CatalogLinkRefusal('nothing_to_publish', `This link already serves version ${link.version}.`);
      return owned(await this.#replace(link, { version: request.version, digest: request.digest }));
    });
  }

  /** Whether this change makes the link reach further (a later end, a higher or no cap): the route asks for a passkey first if so. */
  widens(linkId: string, request: UpdateCatalogLinkRequest): Promise<boolean> {
    return this.#serially(async () => {
      const link = this.#publicLive(await this.#applyLocal(), linkId);
      return this.#plan(link, request, this.deps.now()).widens;
    });
  }

  /**
   * Changes a public link's end and cap. `proven` says the caller proved a passkey for a change that widens; a change
   * that turned into a widening after the caller was asked (the link moved on meanwhile) is refused, not made.
   */
  update(linkId: string, request: UpdateCatalogLinkRequest, proven: boolean): Promise<OwnedCatalogLink> {
    return this.#serially(async () => {
      const link = await this.#livePublic(linkId);
      const plan = this.#plan(link, request, this.deps.now());
      if (!plan.changes) return owned(link);
      if (plan.widens && !proven)
        throw new CatalogLinkRefusal(
          'current_changed',
          'This link changed while you were confirming, and the change now reaches further than what you confirmed. Look at it again.',
        );
      return owned(await this.#replace(link, plan.change));
    });
  }

  #plan(
    link: StoredLink,
    request: UpdateCatalogLinkRequest,
    now: number,
  ): { readonly changes: boolean; readonly widens: boolean; readonly change: Change } {
    const lifetime = request.expires === undefined ? undefined : CATALOG_LINK_EXPIRY_MS[request.expires];
    const currentEnd = link.expiresAt === undefined ? Infinity : Date.parse(link.expiresAt);
    const newEnd = lifetime === undefined ? currentEnd : lifetime === null ? Infinity : now + lifetime;
    const newCap = request.installCap === undefined ? link.installCap : (request.installCap ?? undefined);
    const widensEnd = newEnd > currentEnd;
    const widensCap = link.installCap !== undefined && (newCap === undefined || newCap > link.installCap);
    return {
      changes: newEnd !== currentEnd || newCap !== link.installCap,
      widens: widensEnd || widensCap,
      change: {
        ...(newEnd === currentEnd ? {} : { expiresAt: Number.isFinite(newEnd) ? instant(newEnd) : null }),
        ...(newCap === link.installCap ? {} : { installCap: newCap ?? null }),
      },
    };
  }

  /**
   * Keeps every live public link inside its 30-day lease, and puts back one the store let lapse. Run at boot and
   * every six hours. A link is re-signed a week after its last refresh; one the store reports lapsed (this machine
   * was off past the lease) or no longer knows is uploaded again under the same id and key. A link whose item or
   * version is gone is ended, not refreshed. A store that cannot be reached leaves everything as it was.
   */
  refresh(): Promise<void> {
    return this.#serially(async () => {
      const document = await this.#applyLocal();
      const now = this.deps.now();
      const candidates = document.links.filter(
        link => link.state === 'live' && link.kind === 'public' && link.pendingUpload === undefined,
      );
      for (const origin of new Set(candidates.map(link => link.storeOrigin))) {
        const here = candidates.filter(link => link.storeOrigin === origin);
        for (let at = 0; at < here.length; at += STATUS_BATCH) {
          const batch = here.slice(at, at + STATUS_BATCH);
          const answer = await this.deps.client.status(
            origin,
            batch.map(link => link.bundleId),
          );
          if (!answer.ok) continue;
          for (const link of batch) {
            const entry = answer.value.links.find(candidate => candidate.bundleId === link.bundleId);
            if (entry === undefined) continue;
            const lapsed = entry.state === 'lapsed' || entry.state === 'unknown';
            const renews =
              entry.state === 'live' &&
              Date.parse(link.notAfter) - now < LINK_RENEW_WITHIN_MS &&
              Math.min(now + LINK_MAX_LEASE_MS, link.expiresAt === undefined ? Infinity : Date.parse(link.expiresAt)) >
                Date.parse(link.notAfter);
            if (lapsed || renews) await this.#keepOn(link, lapsed);
          }
        }
      }
    });
  }

  async #keepOn(link: StoredLink, revive: boolean): Promise<void> {
    try {
      await this.#replace(link, { revive });
    } catch (error) {
      if (!(error instanceof CatalogLinkRefusal)) throw error;
      if (
        error.refusal === 'version_retired' ||
        error.refusal === 'version_unknown' ||
        error.refusal === 'item_unknown'
      )
        await this.#attemptEnd(link, 'item-gone');
    }
  }

  /**
   * Uploads the next document of a public link: a new version, a new end or cap, a fresh lease, or the same link put
   * back. The change is written down BEFORE the upload so a crash leaves a change the next boot settles. The store
   * takes it only if the link is still at the sequence this machine last wrote (a compare-and-swap).
   */
  async #replace(link: StoredLink, change: Change): Promise<StoredLink> {
    const identity = await this.#identity();
    const now = this.deps.now();
    if (identity.daemonId !== link.publisher) {
      // The identity changed since the caller looked: a link is never signed or uploaded under another publisher.
      await this.#write(link.linkId, current => stranded(current, now));
      if (link.keyRef !== undefined) await this.deps.vault.forget(link.keyRef);
      throw new CatalogLinkRefusal('signing_unavailable', NOT_THE_PUBLISHER);
    }
    const version = change.version ?? link.version;
    const expiresAt = change.expiresAt === undefined ? link.expiresAt : (change.expiresAt ?? undefined);
    const installCap = change.installCap === undefined ? link.installCap : (change.installCap ?? undefined);
    const issuedAt = instant(now);
    const notAfter = instant(
      Math.min(now + LINK_MAX_LEASE_MS, expiresAt === undefined ? Infinity : Date.parse(expiresAt)),
    );
    const sequence = link.sequence + 1;
    const subject = await this.#subject({ itemId: link.itemId, version });
    if (change.digest !== undefined && subject.contentDigest !== change.digest)
      throw new CatalogLinkRefusal(
        'changed_since_preview',
        `${subject.name} version ${version} changed since you looked at it. Look at it again, read what it holds now, and then confirm.`,
      );
    const key = await this.deps.vault.open(link.linkId);
    if (key === undefined)
      throw new CatalogLinkRefusal('link_not_live', 'This machine no longer holds the key to this link.');
    const text = await this.#bundleText(identity, subject, {
      linkId: link.linkId,
      bundleId: link.bundleId,
      kind: 'public',
      sequence,
      issuedAt,
      notAfter,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    const sealed = await sealLinkEnvelope(this.deps.crypto, key, link.bundleId, sequence, text);
    if (!sealed.ok) throw new CatalogLinkRefusal('link_too_big', LINK_TOO_BIG_SENTENCE);
    const token = await linkFetchToken(this.deps.crypto, key, link.bundleId);
    const verifier = token === null ? null : await linkFetchVerifier(this.deps.crypto, token);
    if (verifier === null) throw new Error('A link key could not be turned into a fetch verifier.');

    const pending: PendingUpload = {
      sequence,
      version,
      notAfter,
      issuedAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(installCap === undefined ? {} : { installCap }),
      ...(change.revive === true ? { revived: true } : {}),
    };
    await this.#write(link.linkId, current => ({ ...current, pendingUpload: pending }));
    // A version retired since it was read is refused now that the record names it: a retire from here on sees the record.
    if (version !== link.version && !(await this.deps.items.holdsLinkVersion(link.itemId, version))) {
      await this.#unpend(link.linkId);
      throw new CatalogLinkRefusal('version_retired', `${subject.name} version ${version} was retired.`);
    }
    const uploaded = await this.deps.client.upload(link.storeOrigin, {
      bundleId: link.bundleId,
      action: change.revive === true ? 'create' : 'replace',
      kind: 'public',
      sequence,
      ...(change.revive === true ? {} : { expectSequence: link.sequence }),
      notAfter,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(installCap === undefined ? {} : { installCap }),
      fetchVerifier: verifier,
      envelope: sealed.value,
    });
    if (!uploaded.ok) {
      // A refusal is a definite no, so the link is as it was. An answer that never came may still have been a yes:
      // the change stays written down and the next reconciliation asks the store.
      if (uploaded.reason === 'refused') await this.#unpend(link.linkId);
      throw new CatalogLinkRefusal(
        'link_store_unavailable',
        uploaded.reason === 'refused'
          ? `${STORE_DID_NOT_TAKE_IT} ${LINK_STORE_REFUSAL_DETAIL[uploaded.code].message}`
          : STORE_SILENT_CHANGE,
      );
    }
    return await this.#commit(link.linkId, pending);
  }

  async #unpend(linkId: string): Promise<void> {
    await this.#write(linkId, ({ pendingUpload: _dropped, ...rest }) => rest);
  }

  /** A public link that is live, with a change of its own that was left unconfirmed settled first. */
  async #livePublic(linkId: string): Promise<StoredLink> {
    let link = this.#publicLive(await this.#applyLocal(), linkId);
    if (link.pendingUpload === undefined) return link;
    await this.#settle(link, 'replace');
    link = this.#publicLive(await this.deps.documents.read(), linkId);
    if (link.pendingUpload !== undefined) throw new CatalogLinkRefusal('link_store_unavailable', CHANGE_WAITING);
    return link;
  }

  #publicLive(document: LinksDocument, linkId: string): StoredLink {
    const link = this.#found(document, linkId);
    if (link.kind !== 'public')
      throw new CatalogLinkRefusal('link_not_public', 'A one-time link is made once and cannot be changed.');
    if (link.state !== 'live') throw new CatalogLinkRefusal('link_not_live', 'This link is not on any more.');
    return link;
  }

  /**
   * What time and identity decide with no store call: a live link past its end has expired, and a pending or live
   * link made under another identity is ended (the store takes changes and deletes only from the identity that made
   * a link, and a refresh signed by a new identity would fail the fingerprint check in the app). The key is forgotten.
   */
  async #local(
    links: readonly StoredLink[],
    now: number,
  ): Promise<{ readonly links: StoredLink[]; readonly forgotten: string[] }> {
    const current = (await this.deps.identity.identity())?.daemonId;
    const forgotten: string[] = [];
    const next = links.map((link): StoredLink => {
      const expired = link.state === 'live' && finalEnd(link) <= now;
      const changed =
        !expired &&
        current !== undefined &&
        link.publisher !== current &&
        (link.state === 'live' || link.state === 'pending');
      if (!expired && !changed) return link;
      if (link.keyRef !== undefined) forgotten.push(link.keyRef);
      const { pendingUpload: _dropped, ...rest } = link;
      return expired
        ? { ...rest, state: 'expired', endedAt: instant(finalEnd(link)), endReason: 'expired' }
        : stranded(link, now);
    });
    return { links: next, forgotten };
  }

  /** {@link #local} written to the file, and the keys of the links it ended forgotten. */
  async #applyLocal(): Promise<LinksDocument> {
    const original = await this.deps.documents.read();
    const local = await this.#local(original.links, this.deps.now());
    const document = pruned({ ...original, links: local.links }, this.deps.now());
    if (JSON.stringify(document) === JSON.stringify(original)) return original;
    await this.deps.documents.write(document);
    for (const linkId of local.forgotten) await this.deps.vault.forget(linkId);
    return document;
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
    // A public link whose lease ran out while the answer was missing still shows the sequence it was taken at: the
    // upload was accepted, and refresh revives it from there. Ended, used and one-time links are never revived.
    const stored =
      entry?.sequence === pending.sequence &&
      (entry.state === 'live' || (entry.state === 'lapsed' && link.kind === 'public'));
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
    await this.#commit(link.linkId, pending);
  }

  /** The upload the store took becomes the link: its version, sequence, lease, end and cap, whichever of them it changed. */
  async #commit(linkId: string, pending: PendingUpload): Promise<StoredLink> {
    const committed = await this.#write(
      linkId,
      ({ pendingUpload: _committed, expiresAt: _end, installCap: _cap, ...rest }) => ({
        ...rest,
        state: 'live',
        version: pending.version,
        sequence: pending.sequence,
        notAfter: pending.notAfter,
        ...(pending.issuedAt === undefined ? {} : { issuedAt: pending.issuedAt }),
        ...(pending.version === rest.version
          ? {}
          : { movedFrom: rest.version, servedSince: pending.issuedAt ?? rest.servedSince }),
        ...(pending.revived === true ? { revivedAt: pending.issuedAt ?? instant(this.deps.now()) } : {}),
        ...(pending.expiresAt === undefined ? {} : { expiresAt: pending.expiresAt }),
        ...(pending.installCap === undefined ? {} : { installCap: pending.installCap }),
      }),
    );
    if (pending.revived === true) await this.#revived(committed);
    return committed;
  }

  async #revived(link: StoredLink): Promise<void> {
    await this.deps.audit
      ?.record({
        event: 'catalog.link.revived',
        actor: { kind: 'host' },
        cause: 'daemon',
        subject: link.linkId,
        outcome: 'succeeded',
        detail: { linkId: link.linkId, sequence: link.sequence },
      })
      .catch(() => undefined);
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
    if (notPublisher && servedUntil(link) <= now) {
      this.#retries.delete(link.linkId);
      const lapsed = await this.#write(link.linkId, ({ pendingUpload: _dropped, ...rest }) => ({
        ...rest,
        state: 'expired',
        endedAt: instant(servedUntil(link)),
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
    const waiting = await this.#write(link.linkId, current => ({
      ...withoutPending(current),
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
    readonly states: ReadonlyMap<string, 'ok' | 'unreachable' | 'lapsed'>;
  }> {
    return this.#serially(async () => {
      const now = this.deps.now();
      const original = await this.deps.documents.read();
      const states = new Map<string, 'ok' | 'unreachable' | 'lapsed'>();
      const local = await this.#local(original.links, now);
      const forgotten = [...local.forgotten];
      let links = local.links;
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
            if (entry.state === 'lapsed' && link.kind === 'public') {
              // A public link the store let lapse (this machine was off past its lease) is put back by the next refresh.
              states.set(link.linkId, 'lapsed');
              return counted;
            }
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
    identity: CatalogSigningIdentity,
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

  async #identity(): Promise<CatalogSigningIdentity> {
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
