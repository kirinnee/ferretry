/**
 * `durian-hypermedia/react/strict` as we use it; see `./durian-hypermedia.d.ts` for why this stands in for the package's
 * source, and why nothing here is loose. Shapes are `src/react/strict.tsx`, `src/react/document.tsx` and `src/react/context.tsx`.
 */
import type { ComponentType, ReactElement, ReactNode } from 'react';
import type {
  AccordionBlock,
  AlignmentBlock,
  AnimationBlock,
  Block,
  BlockDef,
  BlockType,
  ChartBlock,
  Document,
  EditorBlock,
  FileTreeBlock,
  HostBlock,
  InlineDef as ParsedInlineDef,
  MermaidBlock,
  TabsBlock,
  TerminalBlock,
  TierListBlock,
  UrlPolicy,
} from './durian-hypermedia';

/**
 * A component per part type, keyed by the REAL block types only (a misspelled key is an error) and receiving the block
 * Durian hands that key: `{ block }` and nothing else, so a renderer that needs another prop Durian never supplies does
 * not typecheck. Durian's own type is `Partial<Record<BlockType, ComponentType<{ block: any }>>>`; this is the same keys
 * with the block narrowed per key, so everything accepted here is accepted by Durian (never the other way round).
 */
export type Components = {
  readonly [K in BlockType]?: ComponentType<{ readonly block: Extract<Block, { type: K }> }>;
};

export interface CodeSlotProps {
  /** The first word of the fence's info string ("" when none). */
  readonly lang: string;
  /** The code, as written. */
  readonly text: string;
  /** The rest of the info string after the language ("" when none). */
  readonly meta: string;
}
export interface InlineCodeSlotProps {
  readonly text: string;
}
export interface LinkSlotProps {
  /** The URL after the URL policy. */
  readonly href: string;
  readonly title?: string;
  /** The URL has a scheme or starts with `//`. */
  readonly external: boolean;
  readonly children: ReactNode;
}

/** One step of a mermaid diagram, for the host's `Mermaid` slot to draw (Durian's `DiagramDrawProps`). */
export interface MermaidSlotProps {
  /** The step's mermaid source. */
  readonly src: string;
  readonly title: string;
  /** This step's place in the diagram. */
  readonly step: number;
  /** True while this step is the one shown (every step is mounted at once). */
  readonly active: boolean;
}

/** One Markdown heading, for the host's `Heading` slot to draw (Durian's `HeadingSlotProps`). */
export interface HeadingSlotProps {
  /** The level written in the message (1 for `#`). */
  readonly depth: number;
  /** The level to draw, after `demoteHeadings` (at most 6). */
  readonly level: number;
  /** The heading's id (prefixed, unique in the message). */
  readonly id: string;
  /** The heading as plain text. */
  readonly text: string;
  readonly children: ReactNode;
}

/** The chrome and Markdown elements a host may draw itself (Durian's `Slots`, the ones we set). */
export interface Slots {
  readonly Heading?: ComponentType<HeadingSlotProps>;
  readonly Mermaid?: ComponentType<MermaidSlotProps>;
  readonly Code?: ComponentType<CodeSlotProps>;
  readonly InlineCode?: ComponentType<InlineCodeSlotProps>;
  readonly Link?: ComponentType<LinkSlotProps>;
}

/** A host's inline token with the component that draws it (`text` is the raw match; `data` is `undefined`: we give no `parse`). */
export interface InlineDef extends ParsedInlineDef {
  readonly Component?: ComponentType<{ readonly text: string; readonly data: unknown }>;
}

export interface DocumentProps {
  readonly doc: Document;
  /** `light` / `dark` for this document only: always passed, the root says `data-mode`, not `data-theme`. */
  readonly theme?: 'light' | 'dark';
  readonly motion?: 'on' | 'off';
  readonly variant?: string;
  readonly demoteHeadings?: number;
  readonly className?: string;
  readonly components?: Components;
  readonly slots?: Slots;
  readonly inlines?: readonly InlineDef[];
  /** Links are checked again with this policy at render time. */
  readonly urlPolicy?: UrlPolicy;
  /** Host blocks: their `Component` draws them (the parser half is passed to `parse`). Keep the array stable. */
  readonly blocks?: readonly BlockDef<any, ComponentType<{ readonly block: HostBlock; readonly data: any }>>[];
}

/** Every part, with mermaid drawn by the host's slot: imports neither mermaid nor DOMPurify. */
export declare function DhDocument(props: DocumentProps): ReactElement;
/** The document view alone: only the parts named in `components` are drawn, the rest as LLM text. */
export declare function DocumentView(props: DocumentProps): ReactElement;
/** Draws a list of blocks with the components in context (what a container's body is drawn with). */
export declare function Blocks(props: { readonly blocks: readonly Block[] }): ReactElement;
/** The terminal part (` ```terminal `). */
export declare const TerminalPart: ComponentType<{ readonly block: TerminalBlock }>;
/** The file tree part (` ```filetree `). */
export declare const FileTreePart: ComponentType<{ readonly block: FileTreeBlock }>;
/** The editor part (` ```editor `). */
export declare const EditorPart: ComponentType<{ readonly block: EditorBlock }>;
/** The chart part (` ```chart `): Chart.js on a canvas, loaded when the chart mounts. */
export declare const ChartPart: ComponentType<{ readonly block: ChartBlock }>;
/** The mermaid part with no mermaid library: each step is drawn by the host's `Mermaid` slot. */
export declare const HostMermaidPart: ComponentType<{ readonly block: MermaidBlock }>;
/** The animation part (` ```animation `): 2D in SVG, 3D (three.js, a lazy module) when a reader opens it. */
export declare const AnimationPart: ComponentType<{ readonly block: AnimationBlock }>;
/** The tier list part. */
export declare const TierListPart: ComponentType<{ readonly block: TierListBlock }>;
/** The alignment grid part. */
export declare const AlignmentPart: ComponentType<{ readonly block: AlignmentBlock }>;
/** The `:::tabs` container. */
export declare const TabsPart: ComponentType<{ readonly block: TabsBlock }>;
/** The `:::accordion` container. */
export declare const AccordionPart: ComponentType<{ readonly block: AccordionBlock }>;
