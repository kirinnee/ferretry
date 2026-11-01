/**
 * Following the model catalog Ferretry publishes (docs/model-catalog.md § Live updates), so a model
 * list changes on every paired daemon without a release.
 *
 * ONE SMALL READ DECIDES. `catalog/version.json` is compared with the version this machine holds:
 * equal means nothing is downloaded; different ("diff == update") means the full catalog is read and
 * CHECKED before it is used —
 *
 * 1. the hosted app's `release-manifest.sig` must be an Ed25519 signature, by the key compiled into
 *    this build, over the exact bytes of `release-manifest.json`;
 * 2. that signed list must name `catalog/models.json` with the SHA-256 of the bytes just read;
 * 3. the document must be a published catalog of the version `version.json` named.
 *
 * Anything else is refused with one sentence, and the catalog this machine already holds — or the one
 * built into it — stays in effect. A catalog is labels, model ids and tiers; it grants nothing, so the
 * check guards correctness, not a permission.
 *
 * NEVER ON AN IDLE TIMER. A check happens at boot, when something reads the catalogs (a picker, a
 * runtime list, an apply) and the last check is older than the interval (six hours), and when the owner
 * asks (`fy models refresh`). A check is a plain GET with no credential and no inference.
 */
import {
  type ModelCatalog,
  PUBLISHED_MODEL_CATALOG_FILE,
  PUBLISHED_MODEL_CATALOG_VERSION_FILE,
  PublishedModelCatalogVersionSchema,
  readPublishedModelCatalog,
} from '@ferretry/fleet';
import type { ModelCatalogRefreshResult } from '@ferretry/protocol';

/** The signed release list and its signature, at the hosted app's root (docs/pwa-release-signing.md). */
export const RELEASE_LIST_FILE = 'release-manifest.json';
export const RELEASE_SIGNATURE_FILE = 'release-manifest.sig';

/** The hosted app's origin, which serves the published catalog beside the app itself (one address, owned by the protocol). */
export { HOSTED_APP_ORIGIN } from '@ferretry/protocol';

/** Bytes as the hosted app answered them, over a plain buffer WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** How long a check stands before a read asks again. */
export const MODEL_CATALOG_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** One read of the hosted app: its status and bytes, or `undefined` when it could not be reached. */
export interface ModelCatalogFetchPort {
  get(path: string): Promise<{ readonly status: number; readonly bytes: Bytes } | undefined>;
}

/** The last catalog this machine took, kept in its state home so a restart starts from it. */
export interface ModelCatalogCachePort {
  read(): Promise<unknown>;
  write(document: unknown): Promise<void>;
}

export interface PublishedModelCatalogDeps {
  /** Absent when this daemon follows no published catalog. */
  readonly fetch?: ModelCatalogFetchPort;
  readonly cache: ModelCatalogCachePort;
  /** The hosted app's release public key, as PEM: the one the build compiled in. */
  readonly publicKeyPem: string;
  readonly nowMs: () => number;
  /** Told after a newer catalog is in effect, so what runtimes offer can move with it. Must not throw. */
  readonly onUpdated?: (version: number) => Promise<void>;
  readonly intervalMs?: number;
}

/** What the cache holds. */
interface Held {
  readonly version?: number;
  readonly document?: unknown;
  readonly fetchedAt?: string;
  readonly checkedAt?: string;
  readonly last?: ModelCatalogRefreshResult;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The cache document, read leniently: a damaged one reads as nothing held, never as a failure. */
function heldFrom(value: unknown): Held {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.version === 'number' ? { version: value.version } : {}),
    ...('document' in value ? { document: value.document } : {}),
    ...(typeof value.fetchedAt === 'string' ? { fetchedAt: value.fetchedAt } : {}),
    ...(typeof value.checkedAt === 'string' ? { checkedAt: value.checkedAt } : {}),
    ...(isRecord(value.last) && typeof value.last.outcome === 'string'
      ? { last: value.last as unknown as ModelCatalogRefreshResult }
      : {}),
  };
}

const toBase64 = (bytes: Bytes): string => btoa(String.fromCharCode(...bytes));

const fromBase64 = (text: string): Bytes => Uint8Array.from(atob(text), character => character.charCodeAt(0));

const base64Url = (bytes: Bytes): string =>
  toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

const fromBase64Url = (text: string): Bytes | undefined => {
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) return undefined;
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  try {
    return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return undefined;
  }
};

const sha256 = async (bytes: Bytes): Promise<string> =>
  base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

/** A PEM public key's SPKI bytes, or `undefined` when it is not one. */
export function spkiFromPem(pem: string): Bytes | undefined {
  const match = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/u.exec(pem);
  if (match === null) return undefined;
  try {
    return fromBase64((match[1] as string).replace(/\s+/gu, ''));
  } catch {
    return undefined;
  }
}

/**
 * Check a published catalog against the hosted app's signed release list. Answers the document's value,
 * or the sentence that says why it was refused.
 */
export async function verifyPublishedCatalog(input: {
  readonly publicKeyPem: string;
  readonly list: Bytes;
  readonly signature: string;
  readonly catalog: Bytes;
}): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string }> {
  const spki = spkiFromPem(input.publicKeyPem);
  if (spki === undefined) return { ok: false, reason: 'this build carries no release key to check a catalog with' };
  const [fingerprint, signatureText, extra] = input.signature.trim().split('.');
  const signature = signatureText === undefined ? undefined : fromBase64Url(signatureText);
  if (fingerprint === undefined || signature === undefined || extra !== undefined)
    return { ok: false, reason: 'the release list is not signed' };
  if (fingerprint !== (await sha256(spki)))
    return { ok: false, reason: 'the release list is signed by a key this build does not trust' };
  let verified = false;
  try {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify']);
    verified = await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, input.list);
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: 'the release list signature does not verify' };
  let listed: unknown;
  try {
    listed = (JSON.parse(new TextDecoder().decode(input.list)) as { files?: Record<string, unknown> }).files?.[
      PUBLISHED_MODEL_CATALOG_FILE
    ];
  } catch {
    return { ok: false, reason: 'the signed release list is not a document' };
  }
  if (typeof listed !== 'string') return { ok: false, reason: 'the signed release list does not name the catalog' };
  if (listed !== (await sha256(input.catalog)))
    return { ok: false, reason: 'the catalog is not the one the signed release list names' };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(input.catalog)) };
  } catch {
    return { ok: false, reason: 'the catalog is not a document' };
  }
}

/** The published catalog this machine follows: what it holds, and the check that keeps it current. */
export class PublishedModelCatalogService {
  #held: Held | undefined;
  #running: Promise<ModelCatalogRefreshResult> | undefined;
  readonly #intervalMs: number;

  constructor(private readonly deps: PublishedModelCatalogDeps) {
    this.#intervalMs = deps.intervalMs ?? MODEL_CATALOG_CHECK_INTERVAL_MS;
  }

  /** Whether this daemon follows a published catalog at all. */
  get enabled(): boolean {
    return this.deps.fetch !== undefined;
  }

  async #read(): Promise<Held> {
    this.#held ??= heldFrom(await this.deps.cache.read().catch(() => undefined));
    return this.#held;
  }

  async #keep(held: Held): Promise<void> {
    this.#held = held;
    await this.deps.cache.write(held).catch(() => undefined);
  }

  /** The published catalogs this machine holds, by id; `undefined` before it holds any. */
  async catalogs(): Promise<Readonly<Record<string, ModelCatalog>> | undefined> {
    const held = await this.#read();
    return held.document === undefined ? undefined : readPublishedModelCatalog(held.document)?.catalogs;
  }

  /** The version held and when it was last fetched and checked. */
  async status(): Promise<Omit<Held, 'document'>> {
    const { document: _document, ...status } = await this.#read();
    return status;
  }

  /** Check now when the last check is older than the interval; never throws, never waits on the network. */
  refreshIfDue(): void {
    void this.refresh(false).catch(() => undefined);
  }

  /** Check for a newer published catalog: always when `force`, else only when the last check is old. */
  async refresh(force: boolean): Promise<ModelCatalogRefreshResult> {
    this.#running ??= this.#refresh(force).finally(() => {
      this.#running = undefined;
    });
    return await this.#running;
  }

  async #refresh(force: boolean): Promise<ModelCatalogRefreshResult> {
    const { fetch } = this.deps;
    const held = await this.#read();
    const version = held.version === undefined ? {} : { version: held.version };
    if (fetch === undefined) return { outcome: 'disabled' };
    const now = this.deps.nowMs();
    const checked = held.checkedAt === undefined ? Number.NaN : Date.parse(held.checkedAt);
    if (!force && now - checked < this.#intervalMs) return { outcome: 'not-due', ...version };
    const result = await this.#check(fetch, held);
    const checkedAt = new Date(now).toISOString();
    if (result.kind === 'updated') {
      await this.#keep({
        version: result.version,
        document: result.document,
        fetchedAt: checkedAt,
        checkedAt,
        last: result.result,
      });
      await this.deps.onUpdated?.(result.version).catch(() => undefined);
    } else {
      await this.#keep({ ...held, checkedAt, last: result.result });
    }
    return result.result;
  }

  async #check(
    fetch: ModelCatalogFetchPort,
    held: Held,
  ): Promise<
    | {
        readonly kind: 'updated';
        readonly version: number;
        readonly document: unknown;
        readonly result: ModelCatalogRefreshResult;
      }
    | { readonly kind: 'kept'; readonly result: ModelCatalogRefreshResult }
  > {
    const keptVersion = held.version === undefined ? {} : { version: held.version };
    const kept = (outcome: 'unchanged' | 'unreachable' | 'refused', reason?: string) => ({
      kind: 'kept' as const,
      result: { outcome, ...keptVersion, ...(reason === undefined ? {} : { reason }) },
    });
    const read = async (path: string): Promise<Bytes | string> => {
      const answer = await fetch.get(path);
      if (answer === undefined) return `the hosted app could not be reached for ${path}`;
      if (answer.status !== 200) return `the hosted app answered ${answer.status} for ${path}`;
      return answer.bytes;
    };
    const versionBytes = await read(PUBLISHED_MODEL_CATALOG_VERSION_FILE);
    if (typeof versionBytes === 'string') return kept('unreachable', versionBytes);
    let published: number;
    try {
      published = PublishedModelCatalogVersionSchema.parse(JSON.parse(new TextDecoder().decode(versionBytes))).version;
    } catch {
      return kept('refused', 'the published catalog version is not a version');
    }
    if (published === held.version && held.document !== undefined) return kept('unchanged');
    const [list, signature, catalog] = await Promise.all([
      read(RELEASE_LIST_FILE),
      read(RELEASE_SIGNATURE_FILE),
      read(PUBLISHED_MODEL_CATALOG_FILE),
    ]);
    for (const part of [list, signature, catalog]) if (typeof part === 'string') return kept('unreachable', part);
    const verified = await verifyPublishedCatalog({
      publicKeyPem: this.deps.publicKeyPem,
      list: list as Bytes,
      signature: new TextDecoder().decode(signature as Bytes),
      catalog: catalog as Bytes,
    });
    if (!verified.ok) return kept('refused', verified.reason);
    const document = readPublishedModelCatalog(verified.value);
    if (document === undefined) return kept('refused', 'the published catalog is not a catalog document');
    if (document.version !== published)
      return kept('refused', 'the published catalog changed while it was read; the next check takes it');
    return {
      kind: 'updated',
      version: published,
      document: verified.value,
      result: { outcome: 'updated', version: published },
    };
  }
}
