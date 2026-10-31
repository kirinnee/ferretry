/**
 * Previews waiting for a yes: in memory only, bounded by count (per caller) and by age. A preview holds the verified
 * item itself, so an apply installs exactly the bytes that were reviewed — it never reads them again from
 * a caller. A restart forgets them all, which is the point: a decision is made against one running daemon.
 */
import type {
  CatalogInstallPreviewId,
  CatalogInstallTarget,
  CatalogProvenance,
  SharedCatalogItem,
} from '@ferretry/protocol';

/** The most previews kept for ONE caller; that caller's oldest is dropped for a new one. */
export const CATALOG_PREVIEW_MAX_KEPT = 8;

export interface HeldPreview {
  readonly previewId: CatalogInstallPreviewId;
  /** Who asked: only this caller may apply it. See `callerOf` in the mount. */
  readonly caller: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly item: SharedCatalogItem;
  readonly provenance: CatalogProvenance;
  readonly revision: number;
  readonly target: CatalogInstallTarget;
  readonly allowOlder: boolean;
  readonly placeholders: readonly string[];
}

export type PreviewLookup =
  | { readonly kind: 'found'; readonly preview: HeldPreview }
  | { readonly kind: 'expired' }
  | { readonly kind: 'unknown' };

export class CatalogPreviews {
  readonly #held = new Map<string, HeldPreview>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxKept: number = CATALOG_PREVIEW_MAX_KEPT,
  ) {}

  /**
   * Keep `preview`, dropping what has been expired for a whole lifetime and then, over the bound, the
   * oldest of THE SAME CALLER's — so one caller can never push another's preview out.
   */
  put(preview: HeldPreview, now: number): void {
    for (const [id, held] of this.#held) if (now - held.expiresAt > this.ttlMs) this.#held.delete(id);
    this.#held.set(preview.previewId, preview);
    const mine = [...this.#held.values()].filter(held => held.caller === preview.caller);
    for (const stale of mine.slice(0, Math.max(0, mine.length - this.maxKept))) this.#held.delete(stale.previewId);
  }

  /** A preview is only ever found by the caller that asked for it; anyone else is told it is unknown. */
  get(previewId: string, caller: string, now: number): PreviewLookup {
    const held = this.#held.get(previewId);
    if (held === undefined || held.caller !== caller) return { kind: 'unknown' };
    return now >= held.expiresAt ? { kind: 'expired' } : { kind: 'found', preview: held };
  }

  /** An applied preview is spent: a second apply of the same yes is refused as unknown. */
  consume(previewId: string): void {
    this.#held.delete(previewId);
  }

  get size(): number {
    return this.#held.size;
  }
}
