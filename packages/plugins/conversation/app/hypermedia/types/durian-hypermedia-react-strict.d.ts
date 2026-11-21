/**
 * `durian-hypermedia/react/strict` as we use it; see `./durian-hypermedia.d.ts` for why this stands in for the package's
 * source, and why nothing here is loose. Shapes are `src/react/strict.tsx`, `src/react/document.tsx` and `src/react/context.tsx`.
 */
import type { ComponentType, ReactElement } from 'react';
import type { Block, BlockType, Document } from './durian-hypermedia';

/**
 * A component per part type, keyed by the REAL block types only (a misspelled key is an error) and receiving the block
 * Durian hands that key: `{ block }` and nothing else, so a renderer that needs another prop Durian never supplies does
 * not typecheck. Durian's own type is `Partial<Record<BlockType, ComponentType<{ block: any }>>>`; this is the same keys
 * with the block narrowed per key, so everything accepted here is accepted by Durian (never the other way round).
 */
export type Components = {
  readonly [K in BlockType]?: ComponentType<{ readonly block: Extract<Block, { type: K }> }>;
};

export interface DocumentProps {
  readonly doc: Document;
  /** `light` / `dark` for this document only: always passed, the root says `data-mode`, not `data-theme`. */
  readonly theme?: 'light' | 'dark';
  readonly motion?: 'on' | 'off';
  readonly variant?: string;
  readonly demoteHeadings?: number;
  readonly className?: string;
  readonly components?: Components;
}

/** Every part, with mermaid drawn by the host's slot: imports neither mermaid nor DOMPurify. */
export declare function DhDocument(props: DocumentProps): ReactElement;
