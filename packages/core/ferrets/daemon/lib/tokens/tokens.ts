import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BearerDigest, FerretBearerDirectory } from '@ferretry/core-gate/contract';
import { FERRET_TOKEN_PREFIX } from '@ferretry/core-gate/contract';
import type { Instant } from '@ferretry/std';
import type { FerretId } from '../../../contract/index.ts';

/**
 * FERRET TOKENS (§2.2, today's `NodeSessionCredentialIssuer` + the credential digest locations, folded with
 * `c52/pr-18`: a ferret's bearer is `fys_` and 43 base64url characters, and nothing else). Ferrets keeps only the
 * SHA-256 of each token in `state/ferrets/tokens.json`; the token itself is handed once to the ferret's launch and
 * never stored, logged or returned by a route. Gate asks `bearers:ferret` (this directory) who a digest belongs to.
 */

/** 256 bits: once a board is mounted this token is the only thing telling one ferret from another. */
const TOKEN_BYTES = 32;

export interface TokenEntry {
  readonly ferret: FerretId;
  readonly digest: string;
  readonly issuedAt: string;
  readonly revoked?: true;
  readonly cutOff?: true;
}

export interface IssuedToken {
  /** The bearer, for the ferret's launch environment only. Never persisted. */
  readonly token: string;
  readonly entry: TokenEntry;
}

/** SHA-256 of the whole token (prefix included), hex: the only form at rest. */
export const tokenDigest = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export function issueToken(
  ferret: FerretId,
  at: Instant,
  random: (size: number) => Uint8Array = randomBytes,
): IssuedToken {
  const token = `${FERRET_TOKEN_PREFIX}${Buffer.from(random(TOKEN_BYTES)).toString('base64url')}`;
  return { token, entry: { ferret, digest: tokenDigest(token), issuedAt: at } };
}

const sameDigest = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

/**
 * The in-memory directory Gate reads through `bearers:ferret`: synchronous, digests only, constant-time compares.
 * One live token per ferret: issuing a new one revokes the previous one (a restart rotates the credential).
 */
export class FerretTokenDirectory implements FerretBearerDirectory {
  private entries: TokenEntry[] = [];
  private moved = 0;
  private available = true;

  constructor(entries: readonly TokenEntry[] = []) {
    this.entries = [...entries];
  }

  ferretFor(digest: BearerDigest): FerretId | undefined {
    if (!this.available) return undefined;
    let found: FerretId | undefined;
    // Every live entry is compared, so the time taken does not say which one matched.
    for (const entry of this.entries)
      if (entry.revoked !== true && sameDigest(entry.digest, digest) && found === undefined) found = entry.ferret;
    return found;
  }

  generation(): number {
    return this.moved;
  }

  /** Records a newly issued token for its ferret and revokes that ferret's previous ones. */
  add(entry: TokenEntry): void {
    this.entries = [...this.revokedFor(entry.ferret), entry];
    this.moved += 1;
  }

  /** Revokes every live token of `ferret`; true when one was live. */
  revoke(ferret: FerretId): boolean {
    const live = this.entries.some(entry => entry.ferret === ferret && entry.revoked !== true);
    this.entries = this.revokedFor(ferret);
    if (live) this.moved += 1;
    return live;
  }

  /** Whether `ferret` holds a live token. */
  holds(ferret: FerretId): boolean {
    return (
      this.available &&
      !this.isCutOff(ferret) &&
      this.entries.some(entry => entry.ferret === ferret && entry.revoked !== true)
    );
  }

  /** Damaged credential state cannot prove who was cut off. No rotation or authentication is allowed. */
  unavailable(): void {
    this.available = false;
    this.moved += 1;
  }

  isAvailable(): boolean {
    return this.available;
  }

  isCutOff(ferret: FerretId): boolean {
    return !this.available || this.entries.some(entry => entry.ferret === ferret && entry.cutOff === true);
  }

  /** The revocation and durable owner cutoff are one tokens.json write. */
  cutOff(ferret: FerretId, at: Instant): void {
    if (!this.entries.some(entry => entry.ferret === ferret))
      this.entries.push({ ferret, digest: '0'.repeat(64), issuedAt: at, revoked: true, cutOff: true });
    this.entries = this.entries.map(entry =>
      entry.ferret === ferret ? { ...entry, revoked: true, cutOff: true } : entry,
    );
    this.moved += 1;
  }

  restore(ferret: FerretId): void {
    this.entries = this.entries.map(entry => {
      if (entry.ferret !== ferret) return entry;
      const { cutOff: _cutOff, ...rest } = entry;
      return rest;
    });
    this.moved += 1;
  }

  /** What `tokens.json` stores: digests and dates. */
  snapshot(): readonly TokenEntry[] {
    return this.entries;
  }

  private revokedFor(ferret: FerretId): TokenEntry[] {
    return this.entries.map(entry =>
      entry.ferret === ferret && entry.revoked !== true ? { ...entry, revoked: true as const } : entry,
    );
  }
}
