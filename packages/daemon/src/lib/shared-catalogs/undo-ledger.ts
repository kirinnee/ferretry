/**
 * What one-tap Add remembers so Undo can take it back (docs/catalogs.md § One-tap Add, and Undo). Memory only.
 *
 * ## Two records, both lost on a restart, both failing safe
 *
 * - **Undo tokens.** A token is 128 random bits, tied to the caller who tapped, good once and good for
 *   {@link QUICK_ADD_UNDO_SECONDS}. A restart forgets every token, so a late Undo is simply `undo_expired`.
 * - **Signed revisions.** Whenever the service signs a catalog's manifest (a member reading it, or an export) the
 *   highest revision signed is noted. Undo may RETRACT (take the item out with no trace) only a revision nobody was
 *   shown. A restart empties this record, but it also empties the tokens that would ask, so no add can be undone
 *   across a restart: every revision from before one counts as signed because none can be retracted at all.
 */
import { QUICK_ADD_UNDO_SECONDS } from '@ferretry/protocol';
import type { RelayCrypto } from '@ferretry/relay';

/** What Undo needs to take one add back. */
export interface UndoRecord {
  readonly catalogId: string;
  readonly itemId: string;
  /** The revision the add made. Undo retracts only while the catalog is still on it. */
  readonly revisionAfterAdd: number;
  /** This tap made the item, so retracting it may drop the item too. */
  readonly createdItem: boolean;
  /** This tap made the default catalog. It stays, empty, whatever Undo does. */
  readonly createdCatalog: boolean;
  /** The catalog already had a line for the item (withdrawn earlier): Undo never erases that withdrawal record. */
  readonly relisted: boolean;
}

interface Held {
  readonly record: UndoRecord;
  readonly caller: string;
  readonly expiresAt: number;
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

export class UndoLedger {
  readonly #held = new Map<string, Held>();
  readonly #signed = new Map<string, number>();

  constructor(private readonly crypto: RelayCrypto) {}

  /** Holds a record for `caller` and answers its token and when it lapses (milliseconds since the epoch). */
  issue(record: UndoRecord, caller: string, now: number): { readonly token: string; readonly expiresAt: number } {
    for (const [token, held] of this.#held) if (held.expiresAt <= now) this.#held.delete(token);
    const token = `cqu_${base64url(this.crypto.randomBytes(16))}`;
    const expiresAt = now + QUICK_ADD_UNDO_SECONDS * 1_000;
    this.#held.set(token, { record, caller, expiresAt });
    return { token, expiresAt };
  }

  /**
   * The record, once. An unknown, lapsed or already used token, and another caller's, all answer `undefined`; only
   * a lapsed one is dropped, so a stranger guessing cannot spend somebody else's token.
   */
  take(token: string, caller: string, now: number): UndoRecord | undefined {
    const held = this.#held.get(token);
    if (held === undefined) return undefined;
    if (held.expiresAt <= now) {
      this.#held.delete(token);
      return undefined;
    }
    if (held.caller !== caller) return undefined;
    this.#held.delete(token);
    return held.record;
  }

  /** A manifest of this catalog at this revision was signed, so somebody may now hold it. */
  noteSigned(catalogId: string, revision: number): void {
    this.#signed.set(catalogId, Math.max(this.#signed.get(catalogId) ?? 0, revision));
  }

  /** Whether the catalog's manifest at `revision` (or a later one) was ever signed since the daemon started. */
  wasSigned(catalogId: string, revision: number): boolean {
    return (this.#signed.get(catalogId) ?? 0) >= revision;
  }
}
