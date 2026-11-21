/** `durian-hypermedia/react/strict` as we use it; see `./durian-hypermedia.d.ts` for why this stands in for the package's source. */
import type { ComponentType, ReactElement } from 'react';
import type { Document } from './durian-hypermedia';

export interface DocumentProps {
  readonly doc: Document;
  /** `light` / `dark` for this document only: always passed, the root says `data-mode`, not `data-theme`. */
  readonly theme?: 'light' | 'dark';
  readonly motion?: 'on' | 'off';
  readonly variant?: string;
  readonly demoteHeadings?: number;
  readonly className?: string;
  readonly components?: Readonly<Record<string, ComponentType<{ readonly block: never }>>>;
}

/** Every part, with mermaid drawn by the host's slot: imports neither mermaid nor DOMPurify. */
export declare function DhDocument(props: DocumentProps): ReactElement;
