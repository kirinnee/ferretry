/**
 * Local MCP-copy previews waiting for a yes: in memory only, bound to the caller that asked, bounded by count
 * (per caller) and by age. A preview HOLDS the setup that was reviewed, so an apply writes exactly that — it
 * never reads the source again. The setup holds placeholders, never an environment value. A restart forgets them all.
 */
import type {
  CatalogInstallTarget,
  CatalogMcpSetup,
  CatalogProvenance,
  LocalMcpOrigin,
  LocalMcpPreviewId,
} from '@ferretry/protocol';

/** The most previews kept for ONE caller; that caller's oldest is dropped for a new one. */
const LOCAL_MCP_PREVIEW_MAX_KEPT = 8;

export interface HeldLocalMcp {
  readonly previewId: LocalMcpPreviewId;
  readonly caller: string;
  readonly expiresAt: number;
  readonly name: string;
  readonly origin: LocalMcpOrigin;
  readonly provenance: CatalogProvenance;
  readonly target: CatalogInstallTarget;
  /** The server as reviewed: every environment value is a whole `${secret:NAME}` placeholder. */
  readonly setup: CatalogMcpSetup;
  /** The placeholders the setup asks the person to bind, each once. */
  readonly placeholders: readonly string[];
}

export type LocalMcpPreviewLookup =
  | { readonly kind: 'found'; readonly preview: HeldLocalMcp }
  | { readonly kind: 'expired' }
  | { readonly kind: 'unknown' };

export class LocalMcpPreviews {
  readonly #held = new Map<string, HeldLocalMcp>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxKept: number = LOCAL_MCP_PREVIEW_MAX_KEPT,
  ) {}

  /** Keep `preview`, dropping what expired a whole lifetime ago and then, over the bound, the caller's oldest. */
  put(preview: HeldLocalMcp, now: number): void {
    for (const [id, held] of this.#held) if (now - held.expiresAt > this.ttlMs) this.#held.delete(id);
    this.#held.set(preview.previewId, preview);
    const mine = [...this.#held.values()].filter(held => held.caller === preview.caller);
    for (const stale of mine.slice(0, Math.max(0, mine.length - this.maxKept))) this.#held.delete(stale.previewId);
  }

  /** Only the caller that asked finds a preview; anyone else is told it is unknown. */
  get(previewId: string, caller: string, now: number): LocalMcpPreviewLookup {
    const held = this.#held.get(previewId);
    if (held === undefined || held.caller !== caller) return { kind: 'unknown' };
    return now >= held.expiresAt ? { kind: 'expired' } : { kind: 'found', preview: held };
  }

  /** An applied preview is spent. */
  consume(previewId: string): void {
    this.#held.delete(previewId);
  }

  get size(): number {
    return this.#held.size;
  }
}
