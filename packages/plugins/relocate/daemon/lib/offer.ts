import type { Clock, IdentitySigner } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { type CloneCrypto, type PrivateKeyHandle, toBase64Url } from '@ferretry/std/sealing';
import {
  RELOCATE_FORMAT,
  RELOCATE_MAX_BUNDLE_BYTES,
  RELOCATE_CHUNK_BYTES,
  RELOCATE_MAX_OPEN_OFFERS,
  RELOCATE_OFFER_TTL_MS,
  type RelocateOffer,
} from '../../contract/index.ts';

/** A refusal with a closed code the route answers with and the app words. */
export class OfferError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'OfferError';
  }
}

/**
 * What one offer can hold in memory is bounded by these two caps together (about the bundle cap, plus the per-chunk
 * framing): a chunk is at most one chunk's worth and an index is below the chunk count. Nothing else is counted.
 */
/** The most chunks one bundle can have: the cap's worth of chunks, plus one for the manifest's framing. */
const MAX_CHUNKS = Math.ceil(RELOCATE_MAX_BUNDLE_BYTES / RELOCATE_CHUNK_BYTES) + 1;
/** Each sealed chunk is its plaintext plus a nonce and a tag. */
const MAX_CHUNK_BYTES = RELOCATE_CHUNK_BYTES + 64;
/** How long a spent offer is remembered after it would have expired, so a replay reads "already used", not "unknown". */
const SPENT_GRACE_MS = 60_000;

interface OpenOffer {
  readonly offer: RelocateOffer;
  readonly privateKey: PrivateKeyHandle;
  readonly expiresAtMs: number;
  readonly chunks: Map<number, Uint8Array>;
}

/** What `take` hands the importer: the one-time private key and the chunks that were uploaded, once, ever. */
export interface SpentOffer {
  readonly offer: RelocateOffer;
  readonly privateKey: PrivateKeyHandle;
  readonly chunks: ReadonlyMap<number, Uint8Array>;
}

/**
 * The one-time offers this machine has opened (the TARGET end). Each holds an X25519 private key and the ciphertext
 * uploaded for it, in memory only: nothing here is written to disk, a restart forgets every offer, and an offer is spent
 * by its FIRST import attempt, whether or not that attempt succeeds, so one offer can never open a bundle twice.
 */
export class OfferBook {
  readonly #open = new Map<string, OpenOffer>();
  readonly #spent = new Map<string, number>();

  constructor(
    private readonly deps: {
      readonly crypto: CloneCrypto;
      readonly signer: Pick<IdentitySigner, 'signRelocateOffer'>;
      readonly clock: Pick<Clock, 'now' | 'nowMs'>;
    },
  ) {}

  /** Opens a new offer, signed with this daemon's identity. Refuses while another is open: each can buffer a whole bundle. */
  async open(): Promise<RelocateOffer> {
    this.expire();
    if (this.#open.size >= RELOCATE_MAX_OPEN_OFFERS)
      throw new OfferError(409, 'another move is already being received on this machine', 'offer_busy');
    const keys = await this.deps.crypto.generateEphemeralKeyPair();
    const offerId = `fy_relocate_offer_${toBase64Url(this.deps.crypto.randomBytes(16))}`;
    const expiresAtMs = this.deps.clock.nowMs() + RELOCATE_OFFER_TTL_MS;
    const expiresAt = new Date(expiresAtMs).toISOString() as Instant;
    const publicKey = toBase64Url(keys.publicKey);
    const signed = await this.deps.signer.signRelocateOffer({ v: RELOCATE_FORMAT, offerId, publicKey, expiresAt });
    // The signature is awaited above: a second open could have been admitted meanwhile, so the bound is checked again.
    if (this.#open.size >= RELOCATE_MAX_OPEN_OFFERS)
      throw new OfferError(409, 'another move is already being received on this machine', 'offer_busy');
    const offer: RelocateOffer = {
      v: RELOCATE_FORMAT,
      offerId,
      daemonId: signed.daemonId,
      identityKey: signed.identityKey,
      publicKey,
      expiresAt,
      signature: signed.signature,
    };
    this.#open.set(offerId, { offer, privateKey: keys.privateKey, expiresAtMs, chunks: new Map() });
    return offer;
  }

  /** Whether the offer is open now, without spending it. Refuses with a sentence a person can read. */
  check(offerId: string): void {
    this.#find(offerId);
  }

  /** Keeps one uploaded chunk. A chunk may be uploaded again (a retry) and replaces the earlier one. */
  receive(offerId: string, index: number, chunk: Uint8Array): void {
    const open = this.#find(offerId);
    if (index >= MAX_CHUNKS) throw new OfferError(400, 'that is more chunks than a move can have', 'chunk_index');
    if (chunk.length > MAX_CHUNK_BYTES || chunk.length === 0)
      throw new OfferError(400, 'a chunk is not larger than the move’s chunk size', 'chunk_size');
    open.chunks.set(index, chunk);
  }

  /**
   * Spends the offer and hands it over: from here it is never open again. The key and the chunks leave the book, so a
   * second `take` (a replayed import) finds it spent.
   */
  take(offerId: string): SpentOffer {
    const open = this.#find(offerId);
    this.#open.delete(offerId);
    this.#spent.set(offerId, open.expiresAtMs + SPENT_GRACE_MS);
    return { offer: open.offer, privateKey: open.privateKey, chunks: open.chunks };
  }

  /** Forgets every offer whose time is up, with the keys and ciphertext they held. */
  expire(): void {
    const nowMs = this.deps.clock.nowMs();
    for (const [id, open] of this.#open) if (open.expiresAtMs <= nowMs) this.#open.delete(id);
    for (const [id, until] of this.#spent) if (until <= nowMs) this.#spent.delete(id);
  }

  #find(offerId: string): OpenOffer {
    this.expire();
    if (this.#spent.has(offerId))
      throw new OfferError(409, 'this offer was already used; open a new one on this machine', 'offer_spent');
    const open = this.#open.get(offerId);
    if (open === undefined)
      throw new OfferError(
        404,
        'no such offer here: it timed out or was never opened; open a new one',
        'offer_unknown',
      );
    return open;
  }
}
