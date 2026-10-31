/**
 * Previews waiting for a yes: in memory only, bounded by count and by age. A preview holds the verified
 * item itself, so an apply installs exactly the bytes that were reviewed — it never reads them again from
 * a caller. A restart forgets them all, which is the point: a decision is made against one running daemon.
 */
import type {
  CatalogInstallPreviewId,
  CatalogInstallTarget,
  CatalogProvenance,
  SharedCatalogItem,
} from '@ferretry/protocol';

/** The most previews kept at once; the oldest is dropped for a new one. */
export const CATALOG_PREVIEW_MAX_KEPT = 16;

export interface HeldPreview {
  readonly previewId: CatalogInstallPreviewId;
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

  /** Keep `preview`, dropping what has been expired for a whole lifetime and then the oldest over the bound. */
  put(preview: HeldPreview, now: number): void {
    for (const [id, held] of this.#held) if (now - held.expiresAt > this.ttlMs) this.#held.delete(id);
    this.#held.set(preview.previewId, preview);
    while (this.#held.size > this.maxKept) {
      const oldest = this.#held.keys().next().value as string;
      this.#held.delete(oldest);
    }
  }

  get(previewId: string, now: number): PreviewLookup {
    const held = this.#held.get(previewId);
    if (held === undefined) return { kind: 'unknown' };
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
