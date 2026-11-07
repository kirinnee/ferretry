import {
  type CatalogSigningIdentity,
  fromBase64UrlFixed,
  encodeLinkUploadBody,
  LINK_STORE_CHALLENGE_PATH,
  LINK_STORE_SERVICE_PATH,
  LINK_STORE_STATUS_PATH,
  LinkStatusSchema,
  type LinkStatus,
  LinkStoreAdvertisementSchema,
  LinkStoreChallengeSchema,
  LinkStoreRefusalSchema,
  type LinkStoreRequestBody,
  type LinkUploadMetadata,
  linkBundlePath,
  NONCE_BYTES,
  type RelayCrypto,
  signLinkStoreRequest,
  toBase64Url,
} from '../lib/relay-wire/index.ts';
import type { LinkStoreClient, LinkUpload, StoreAnswer } from '../lib/catalog-links/ports.ts';
import type { CatalogIdentitySource } from '../lib/shared-catalogs/ports.ts';

export type LinkStoreFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpLinkStoreClientOptions {
  readonly fetcher?: LinkStoreFetch;
  readonly timeoutMs?: number;
}

interface SignedFields {
  readonly daemonId: string;
  readonly publicKey: string;
  readonly nonce: string;
  readonly signature: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** The store's biggest honest answer is a status of 64 entries, a few kilobytes. */
const MAX_BODY_BYTES = 64 * 1024;
const UNREACHABLE = { ok: false, reason: 'unreachable' } as const;

/**
 * The daemon half of the link store wire (`@ferretry/relay` `link-store.ts`).
 *
 * - SIGNS ONLY FOR THE HOST IT WAS GIVEN. The host in every transcript is `new URL(origin).host` of the origin the
 *   caller passes, which is the origin the daemon discovered or was configured with. A store that answers from
 *   another host is a redirect, and a redirect is an error here (`redirect: 'error'`).
 * - Each signed request spends one single-use challenge nonce the store issued for this daemon.
 * - NO BODY IS EVER REPORTED. A refusal is its closed code; anything else the store says is `unreachable`.
 */
export class HttpLinkStoreClient implements LinkStoreClient {
  readonly #fetch: LinkStoreFetch;
  readonly #timeoutMs: number;

  constructor(
    private readonly crypto: RelayCrypto,
    private readonly identity: CatalogIdentitySource,
    options: HttpLinkStoreClientOptions = {},
  ) {
    // Wrapped, not stored bare: a builtin kept as a member takes its holder as the receiver when it is invoked.
    if (options.fetcher === undefined) throw new Error('the kernel fetch port is required');
    this.#fetch = options.fetcher;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async available(origin: string): Promise<boolean> {
    const answer = await this.#send(origin, LINK_STORE_SERVICE_PATH, { method: 'GET' });
    if (!answer.ok || !answer.response.ok) return false;
    const parsed = LinkStoreAdvertisementSchema.safeParse(await this.#json(answer.response));
    return parsed.success && parsed.data.available;
  }

  async upload(origin: string, upload: LinkUpload): Promise<StoreAnswer<undefined>> {
    const envelopeSha256 = toBase64Url(await this.crypto.sha256(upload.envelope));
    const body: LinkStoreRequestBody = {
      request: 'upload',
      bundleId: upload.bundleId,
      action: upload.action,
      kind: upload.kind,
      sequence: upload.sequence,
      ...(upload.expectSequence === undefined ? {} : { expectSequence: upload.expectSequence }),
      notAfter: upload.notAfter,
      ...(upload.expiresAt === undefined ? {} : { expiresAt: upload.expiresAt }),
      ...(upload.installCap === undefined ? {} : { installCap: upload.installCap }),
      fetchVerifier: upload.fetchVerifier,
      envelopeSha256,
      envelopeBytes: upload.envelope.length,
    };
    return await this.#signed(origin, body, async signed => {
      const metadata: LinkUploadMetadata = {
        ...signed,
        action: upload.action,
        kind: upload.kind,
        sequence: upload.sequence,
        ...(upload.expectSequence === undefined ? {} : { expectSequence: upload.expectSequence }),
        notAfter: upload.notAfter,
        ...(upload.expiresAt === undefined ? {} : { expiresAt: upload.expiresAt }),
        ...(upload.installCap === undefined ? {} : { installCap: upload.installCap }),
        fetchVerifier: upload.fetchVerifier,
        envelopeSha256,
        envelopeBytes: upload.envelope.length,
      };
      const answer = await this.#send(origin, linkBundlePath(upload.bundleId), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: encodeLinkUploadBody(metadata, upload.envelope) as Uint8Array<ArrayBuffer>,
      });
      return answer.ok
        ? await this.#answered(answer.response, async () => ({ ok: true, value: undefined }))
        : UNREACHABLE;
    });
  }

  async remove(origin: string, bundleId: string): Promise<StoreAnswer<undefined>> {
    return await this.#signed(origin, { request: 'delete', bundleId }, async signed => {
      const answer = await this.#send(origin, linkBundlePath(bundleId), {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signed),
      });
      return answer.ok
        ? await this.#answered(answer.response, async () => ({ ok: true, value: undefined }))
        : UNREACHABLE;
    });
  }

  async status(origin: string, bundleIds: readonly string[]): Promise<StoreAnswer<LinkStatus>> {
    return await this.#signed(origin, { request: 'status', bundleIds }, async signed => {
      const answer = await this.#send(origin, LINK_STORE_STATUS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...signed, bundleIds }),
      });
      if (!answer.ok) return UNREACHABLE;
      const response = answer.response;
      return await this.#answered(response, async () => {
        const parsed = LinkStatusSchema.safeParse(await this.#json(response));
        return parsed.success ? { ok: true, value: parsed.data } : UNREACHABLE;
      });
    });
  }

  /** Asks for a challenge, signs the request body with it, and hands the signed fields to `then`. */
  async #signed<T>(
    origin: string,
    body: LinkStoreRequestBody,
    then: (signed: SignedFields) => Promise<StoreAnswer<T>>,
  ): Promise<StoreAnswer<T>> {
    const identity = await this.identity.identity();
    if (identity === undefined) return UNREACHABLE;
    const host = new URL(origin).host;
    const nonce = await this.#challenge(origin, identity);
    if (nonce === undefined) return UNREACHABLE;
    const signed = await signLinkStoreRequest(this.crypto, identity, {
      daemonId: identity.daemonId,
      host,
      nonce,
      body,
    });
    return await then(signed);
  }

  async #challenge(origin: string, identity: CatalogSigningIdentity): Promise<Uint8Array | undefined> {
    const answer = await this.#send(origin, LINK_STORE_CHALLENGE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ daemonId: identity.daemonId }),
    });
    if (!answer.ok || !answer.response.ok) return undefined;
    const parsed = LinkStoreChallengeSchema.safeParse(await this.#json(answer.response));
    if (!parsed.success) return undefined;
    return fromBase64UrlFixed(parsed.data.nonce, NONCE_BYTES) ?? undefined;
  }

  /** One request: no redirect, no cache, a deadline. A failure to get any answer is `unreachable`. */
  async #send(
    origin: string,
    path: string,
    init: RequestInit,
  ): Promise<{ readonly ok: true; readonly response: Response } | { readonly ok: false }> {
    try {
      const response = await this.#fetch(new URL(path, origin).toString(), {
        ...init,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      return { ok: true, response };
    } catch {
      return { ok: false };
    }
  }

  /**
   * The body as JSON, or `undefined` when it is not JSON, is over the cap, or does not arrive within the deadline
   * (the request's abort signal runs until the body ends). Nothing past the cap is buffered.
   */
  async #json(response: Response): Promise<unknown> {
    if (response.body === null || Number(response.headers.get('content-length')) > MAX_BODY_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          return undefined;
        }
        chunks.push(part.value);
      }
      return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    } catch {
      return undefined;
    }
  }

  /**
   * A 2xx is a yes, read by `onYes`. Any other answer is the store's closed refusal if it spoke one, and otherwise
   * an answer that cannot be trusted to mean no, so `unreachable`.
   */
  async #answered<T>(response: Response, onYes: () => Promise<StoreAnswer<T>>): Promise<StoreAnswer<T>> {
    if (response.ok) return await onYes();
    const parsed = LinkStoreRefusalSchema.safeParse(await this.#json(response));
    return parsed.success ? { ok: false, reason: 'refused', code: parsed.data.error.code } : UNREACHABLE;
  }
}
