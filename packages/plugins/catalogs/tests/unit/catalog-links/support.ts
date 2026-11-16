import { parseLinkFragment } from '../../../daemon/lib/boundary.ts';
import type { LinkStatus } from '../../../daemon/lib/relay-wire/index.ts';
import {
  EMPTY_LINKS_DOCUMENT,
  type LinksDocument,
  type StoredLink,
} from '../../../daemon/lib/catalog-links/document.ts';
import type {
  LinkDocumentStore,
  LinkItems,
  LinkKeyVault,
  LinkStoreClient,
  LinkStoreLocator,
  LinkStoreSite,
  LinkUpload,
  StoreAnswer,
} from '../../../daemon/lib/catalog-links/ports.ts';
import { CatalogLinkService, type CatalogLinkDeps } from '../../../daemon/lib/catalog-links/service.ts';
import type { SharedCatalogDeps } from '../../../daemon/lib/shared-catalogs/service.ts';
import { crypto, rig, SKILL_PATH, type Rig } from '../shared-catalogs/support.ts';

export { SKILL_PATH };

export const APP_ORIGIN = 'https://app.example.test';
export const STORE_ORIGIN = 'https://links.example.test';
/** The daemon id of the rig's one fixed identity: the machine that made every stored link below. */
export const RIG_DAEMON_ID = 'fy_daemon_ZG1r5J2fAEj5T2d0nso1FW7tT3p74Y5PxKlL_UTjALA';
/** Another machine's daemon id, as after an identity reset. */
export const OTHER_DAEMON_ID = `fy_daemon_${'A'.repeat(43)}`;

class MemoryLinkDocuments implements LinkDocumentStore {
  document: LinksDocument = EMPTY_LINKS_DOCUMENT;
  writes: string[] = [];
  async read(): Promise<LinksDocument> {
    return this.document;
  }
  async write(document: LinksDocument): Promise<void> {
    this.writes.push(JSON.stringify(document));
    this.document = document;
  }
}

class MemoryVault implements LinkKeyVault {
  readonly keys = new Map<string, string>();
  readonly puts: string[] = [];
  readonly forgotten: string[] = [];
  async put(linkId: string, key: string): Promise<void> {
    this.puts.push(linkId);
    this.keys.set(linkId, key);
  }
  async open(linkId: string): Promise<string | undefined> {
    return this.keys.get(linkId);
  }
  async forget(linkId: string): Promise<void> {
    this.forgotten.push(linkId);
    this.keys.delete(linkId);
  }
}

class FakeLocator implements LinkStoreLocator {
  site: LinkStoreSite = { kind: 'ready', origin: STORE_ORIGIN, selfHosted: false };
  asked = 0;
  async locate(): Promise<LinkStoreSite> {
    this.asked += 1;
    return this.site;
  }
}

type Refused = Extract<StoreAnswer<undefined>, { reason: 'refused' }>['code'];
export const UNREACHABLE = { ok: false, reason: 'unreachable' } as const;
export const refused = (code: Refused): StoreAnswer<never> => ({ ok: false, reason: 'refused', code });
const OK: StoreAnswer<undefined> = { ok: true, value: undefined };

/** A store with no memory: each answer is set by the test, and every call is recorded. */
class FakeClient implements LinkStoreClient {
  uploads: { origin: string; upload: LinkUpload }[] = [];
  removes: { origin: string; bundleId: string }[] = [];
  statuses: { origin: string; bundleIds: readonly string[] }[] = [];
  uploadAnswer: StoreAnswer<undefined> = OK;
  removeAnswer: StoreAnswer<undefined> = OK;
  statusAnswer: (bundleIds: readonly string[]) => StoreAnswer<LinkStatus> = bundleIds => ({
    ok: true,
    value: { version: 1, links: bundleIds.map(bundleId => ({ bundleId, state: 'live' as const, sequence: 1 })) },
  });
  async upload(origin: string, upload: LinkUpload): Promise<StoreAnswer<undefined>> {
    this.uploads.push({ origin, upload });
    return this.uploadAnswer;
  }
  async remove(origin: string, bundleId: string): Promise<StoreAnswer<undefined>> {
    this.removes.push({ origin, bundleId });
    return this.removeAnswer;
  }
  async status(origin: string, bundleIds: readonly string[]): Promise<StoreAnswer<LinkStatus>> {
    this.statuses.push({ origin, bundleIds });
    return this.statusAnswer(bundleIds);
  }
  async available(): Promise<boolean> {
    return true;
  }
}

export interface LinkRig {
  readonly items: Rig;
  readonly documents: MemoryLinkDocuments;
  readonly vault: MemoryVault;
  readonly locator: FakeLocator;
  readonly client: FakeClient;
  readonly service: CatalogLinkService;
  /** Fraction in [0, 1) the retry jitter uses. */
  readonly jitter: { value: number };
}

export async function linkRig(
  overrides: Partial<CatalogLinkDeps> = {},
  itemDeps: Partial<SharedCatalogDeps> = {},
): Promise<LinkRig> {
  const items = await rig(itemDeps);
  const documents = new MemoryLinkDocuments();
  const vault = new MemoryVault();
  const locator = new FakeLocator();
  const client = new FakeClient();
  const jitter = { value: 0 };
  const service = new CatalogLinkService({
    documents,
    vault,
    locator,
    client,
    items: items.service,
    identity: { identity: async () => items.identity, publisherName: () => items.publisher.name },
    crypto,
    now: () => items.clock.ms,
    appOrigin: APP_ORIGIN,
    random: () => jitter.value,
    ...overrides,
  });
  return { items, documents, vault, locator, client, service, jitter };
}

export const SKILL_SOURCE = { kind: 'skill', skill: 'demo' } as const;

/** The key a URL carries in its fragment. */
export const keyOf = (url: string): string => parseLinkFragment(new URL(url).hash.slice(1)).key;

export async function previewSkill(r: LinkRig) {
  return await r.service.preview({ source: SKILL_SOURCE });
}

export async function mintPublic(r: LinkRig, expires: '1d' | '7d' | '30d' | 'never' = '7d', installCap?: number) {
  const preview = await previewSkill(r);
  return await r.service.mint({
    item: { source: SKILL_SOURCE, digest: preview.digest },
    kind: 'public',
    expires,
    ...(installCap === undefined ? {} : { installCap }),
  });
}

export async function mintOneTime(r: LinkRig) {
  const preview = await previewSkill(r);
  return await r.service.mint({
    item: { source: SKILL_SOURCE, digest: preview.digest },
    kind: 'one-time',
    expires: '1h',
  });
}

let counter = 0;
const id = (length: number): string => {
  counter += 1;
  return `${counter.toString(36).padStart(4, 'A')}`.padEnd(length, 'A').slice(0, length);
};

/** A stored link in any state, for the tests that start from a file. */
export function storedLink(over: Partial<StoredLink> & Pick<StoredLink, 'state'>): StoredLink {
  const linkId = `lnk_${id(22)}`;
  const at = new Date(Date.UTC(2026, 0, 1)).toISOString();
  const later = new Date(Date.UTC(2026, 0, 8)).toISOString();
  const kind = over.kind ?? 'public';
  return {
    linkId,
    itemId: `itm_${'B'.repeat(22)}`,
    name: 'demo',
    itemKind: 'skill',
    version: 1,
    kind,
    createdAt: at,
    opens: 0,
    bundleId: id(22),
    publisher: RIG_DAEMON_ID,
    storeOrigin: STORE_ORIGIN,
    emitsStoreOrigin: false,
    sequence: 1,
    issuedAt: at,
    notAfter: later,
    servedSince: at,
    ...(kind === 'public' ? { keyRef: linkId } : { expiresAt: later }),
    ...over,
  };
}

/** Items whose one skill is made of incompressible files past the store's cap, so a link cannot be sealed. */
export async function tooBigItems(r: LinkRig): Promise<LinkItems> {
  const subject = await r.items.service.linkSubject({ source: SKILL_SOURCE });
  if (subject.shared.kind !== 'skill') throw new Error('the rig shares a skill');
  const noise = (seed: number): string => {
    const bytes = new Uint8Array(180_000);
    for (let at = 0; at < bytes.length; at += 1) bytes[at] = (Math.imul(at + seed, 2654435761) >>> 24) & 0xff;
    return Buffer.from(bytes).toString('base64').slice(0, 250_000);
  };
  const files = Array.from({ length: 16 }, (_, index) => ({ path: `blob-${index}.txt`, content: noise(index) }));
  const big = {
    ...subject,
    shared: { ...subject.shared, skill: { files: [...subject.shared.skill.files, ...files] } },
  };
  return { linkSubject: async () => big, holdsLinkVersion: async () => true };
}
