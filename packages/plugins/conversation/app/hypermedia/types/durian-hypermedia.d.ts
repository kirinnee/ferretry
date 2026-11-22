/**
 * THE TYPES OF `durian-hypermedia` AS WE USE THEM, mapped in by the root `tsconfig.json` (`paths`, the way
 * `playwright-core` is). The package's own `types` entry is its TypeScript SOURCE (`./src/index.ts`; its `dist/` is never
 * built here, see `../../vite-durian.ts`), which this workspace's compiler would read as OURS and reject: the source is
 * written without `noUncheckedIndexedAccess` and has duplicate-key literals, so one `import` puts hundreds of errors
 * from `node_modules` into every typecheck (even `src/safety.ts` alone fails; measured on v0.5.1). This declaration
 * stands in for that source for the type checker only; the bundler still builds the real source.
 *
 * EXACT, NOT LOOSE. Every shape here is copied from the pinned release (`src/safety.ts`, `src/document.ts`,
 * `src/types.ts`, `src/markdown.ts`, `src/core/*.ts`) with NO index signature and no `Record<string, ...>` standing in for
 * a closed set of keys: a misspelled cap (`limits.maxInputByte`) or part name (`'chrat'`) must fail the typecheck, because
 * at runtime Durian spreads `{ ...LIMITS, ...limits }` and an unknown key is silently ignored, so a security cap would
 * not apply. `tests/unit/app/hypermedia/durian-types.test.ts` holds the `@ts-expect-error` probes that fail when these
 * loosen. The package cannot be imported for its types (above), so a Durian bump re-reads these shapes by hand: that
 * test file also checks the declared cap names against the installed `src/safety.ts`.
 *
 * Only what the hypermedia feature calls is declared; the unit that first uses another export adds it here, in the same
 * PR. The permanent fix is upstream shipping declaration files (or source that compiles under
 * `noUncheckedIndexedAccess`): then these files and their `paths` entries are deleted and the import resolves to the package.
 */

export declare const VERSION: string;
/** The format version the parser implements (SPEC.md); 9 in v0.5.1. */
export declare const FORMAT_VERSION: number;

/** One YAML parser for the front matter and the data parts; the browser has no `Bun.YAML`. */
export declare function setYamlParser(parse: ((text: string) => unknown) | null): void;

/** The caps (`src/safety.ts`): a host may lower or raise any of them with `parse(text, { limits })`. The ten keys are the whole set. */
export interface Limits {
  /** the whole input, in UTF-8 bytes */
  maxInputBytes: number;
  /** blocks in the document (Markdown blocks, parts and the blocks inside containers) */
  maxBlocks: number;
  /** nesting of lists, quotes and inline marks inside Markdown */
  maxDepth: number;
  /** things on an animation's stage (entities, list values) */
  maxAnimEntities: number;
  /** steps of an animation */
  maxAnimSteps: number;
  /** characters of one animation's source */
  maxAnimChars: number;
  /** data points of one chart (all series together) */
  maxChartPoints: number;
  /** items of one tier list or alignment grid */
  maxItems: number;
  /** characters of one mermaid diagram */
  maxMermaidChars: number;
  /** steps of any stepped part (terminal, file tree, editor, code walk, mermaid) */
  maxSteps: number;
}

export interface Problem {
  line: number;
  level: 'error' | 'warn';
  message: string;
}

/** `src/core/expr.ts`. */
export type Val = number | string | boolean | Val[];

/** `src/markdown.ts`. */
export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: MdInline[] }
  | { t: 'code'; v: string }
  | { t: 'br' }
  | { t: 'link'; href: string | null; title?: string; c: MdInline[] }
  | { t: 'img'; src: string | null; alt: string; title?: string }
  | { t: 'coderef'; ref: string; c: MdInline[] }
  | { t: 'kbd'; label: string; chords: string[][] }
  | { t: 'mouse'; act: string; press: 'l' | 'r' | 'w' | ''; badge: string; target: string }
  | { t: 'ref'; name: string; text: string; data: unknown };
export type CalloutKind = 'note' | 'tip' | 'important' | 'warn' | 'security';
export type MdBlock =
  | { t: 'p'; c: MdInline[] }
  | { t: 'text'; c: MdInline[] }
  | { t: 'h'; depth: number; id: string; text: string; c: MdInline[] }
  | { t: 'list'; ordered: boolean; start: number | null; items: { task: boolean; checked: boolean; c: MdBlock[] }[] }
  | { t: 'quote'; c: MdBlock[] }
  | { t: 'callout'; kind: CalloutKind; label: string; c: MdBlock[] }
  | { t: 'code'; lang: string; meta?: string; text: string; hl?: unknown }
  | { t: 'table'; align: ('left' | 'right' | 'center' | null)[]; head: MdInline[][]; rows: MdInline[][][] }
  | { t: 'hr' }
  | { t: 'raw'; text: string };

/** `src/core/chart.ts`, `src/core/tier.ts`, `src/core/align.ts`. */
export interface ChartControl {
  kind: 'slider' | 'select' | 'toggle' | 'button';
  name: string;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  value?: Val;
  options?: Val[];
  set?: Record<string, Val>;
}
export interface ChartSeries {
  name: string;
  data: unknown[];
  kind?: string;
  tone?: string;
  axis?: string;
}
interface SpecError {
  line: number;
  msg: string;
}
interface SpecItem {
  name: string;
  note: string;
}
export interface TierSpec {
  title: string;
  tiers: { name: string; colour: string; items: SpecItem[]; line: number }[];
  declared: boolean;
  errors: SpecError[];
}
export interface AlignSpec {
  title: string;
  xs: string[];
  ys: string[];
  cells: { col: number; row: number; label: string; items: SpecItem[]; line: number }[];
  points: (SpecItem & { x: number; y: number; line: number })[];
  errors: SpecError[];
}

/** Every part but a host's own and an error carries these (`PartBase`, `src/types.ts`). */
interface PartBase {
  /** the author's #id, prefixed (see `ParseOptions.idPrefix`), or null */
  id: string | null;
  /** the line of the part in the source (1-based) */
  line: number;
  /** the info string's key=value attributes, as written */
  attrs: Record<string, string>;
  /** what an LLM reads in place of this part */
  llm: string | null;
  llmKind: 'as-is' | 'data' | 'steps' | 'lines' | 'unwrap' | 'text' | 'none' | 'drop' | 'replace' | 'host';
}

export interface MarkdownBlock {
  type: 'markdown';
  line: number;
  md: MdBlock[];
}
export interface TocBlock {
  type: 'toc';
  line: number;
  depth: number;
  scope: 'page' | 'section';
  items: { depth: number; text: string; id: string }[];
}
export interface TerminalBlock extends PartBase {
  type: 'terminal';
  title: string | null;
  prompt: string;
  steps: {
    title: string;
    lines: { k: 'cmd' | 'out'; text: string; prompt?: string; hl?: [string, string | null][] }[];
  }[];
}
export interface FileTreeBlock extends PartBase {
  type: 'filetree';
  trees: {
    title: string | null;
    rows: {
      depth: number;
      name: string;
      folder: boolean;
      badges: string[];
      closed: boolean;
      note: string;
      gap: boolean;
      path: string;
      line?: number;
    }[];
  }[];
}
export interface EditorBlock extends PartBase {
  type: 'editor';
  files: {
    path: string;
    repo: string;
    made: boolean;
    commit: string | null;
    lang: string;
    code: string | null;
    open: boolean;
    error: string | null;
    hl?: unknown;
  }[];
  steps: {
    title: string;
    file: string;
    before: string;
    after: string;
    added: number[];
    removed: number[];
    error: string | null;
    beforeHl?: unknown;
    afterHl?: unknown;
  }[];
}
export interface CodeWalkBlock extends PartBase {
  type: 'codewalk';
  steps: {
    animated: boolean;
    key: string;
    repo: string;
    file: string;
    commit: string | null;
    lines: [number, number] | null;
    focus: [number, number] | null;
    marks: number[];
    lang: string;
    code: string | null;
    error: string | null;
    note: MdInline[];
    hl?: unknown;
    dedent?: number;
  }[];
  walkFiles: Record<string, string | null>;
  walkHl?: Record<string, unknown>;
}
export interface ChartBlock extends PartBase {
  type: 'chart';
  /** Durian types the chart spec as `any`: its shape is the chart YAML's, checked at parse time. */
  chart: unknown;
  controls: ChartControl[];
  initial: { x: Val[]; series: ChartSeries[]; vars: Record<string, Val>; error?: string };
}
export interface MermaidBlock extends PartBase {
  type: 'mermaid';
  steps: { title: string; src: string }[];
}
export interface AnimationBlock extends PartBase {
  type: 'animation';
  anim: {
    head: string;
    steps: { title: string; raw: string; line: number }[];
    base: number;
    info: Record<string, string>;
  };
  /** what a reader sees as text in this animation, in story order */
  texts: string[];
}
export interface TierListBlock extends PartBase {
  type: 'tierlist';
  tier: TierSpec;
}
export interface AlignmentBlock extends PartBase {
  type: 'alignment';
  align: AlignSpec;
}
export interface TabsBlock extends PartBase {
  type: 'tabs';
  items: { title: string; id: string; body: Block[] }[];
}
export interface AccordionBlock extends PartBase {
  type: 'accordion';
  items: { title: string; id: string; body: Block[] }[];
}
export interface HumanBlock extends PartBase {
  type: 'human';
  body: Block[];
}
/** A part that went over a cap, failed to parse, or is not allowed. */
export interface ErrorBlock {
  type: 'error';
  line: number;
  part: string | null;
  message: string;
}
/** A host's own block (registered with `defineBlock`); unused here until a unit registers one. */
export interface HostBlock extends PartBase {
  type: 'host';
  name: string;
  body: string;
  data: unknown;
}

export type Block =
  | MarkdownBlock
  | TocBlock
  | TerminalBlock
  | FileTreeBlock
  | EditorBlock
  | CodeWalkBlock
  | ChartBlock
  | MermaidBlock
  | AnimationBlock
  | TierListBlock
  | AlignmentBlock
  | TabsBlock
  | AccordionBlock
  | HumanBlock
  | ErrorBlock
  | HostBlock;
/** The part names a component may be given for: the closed set of block `type`s. */
export type BlockType = Block['type'];

export interface Document {
  readonly ast: 1;
  readonly format: number;
  readonly source: string;
  readonly path: string;
  readonly frontMatter: Readonly<Record<string, unknown>>;
  readonly title: string | null;
  readonly banner: { kind: string; text: MdInline[] } | null;
  readonly blocks: readonly Block[];
  readonly headings: readonly { readonly depth: number; readonly text: string; readonly id: string }[];
  readonly problems: readonly Problem[];
  readonly llm: string;
  /** true once `highlight()` added colours to code */
  readonly highlighted: boolean;
}

export interface ParseOptions {
  /** the page's file name; decides the .md / .dh.md check */
  readonly path?: string;
  /** `false`: a leading `---` block is Markdown the reader sees, not front matter. */
  readonly frontMatter?: boolean;
  /** Put before every id the page makes, so a page cannot clobber the host's own ids (default `dh-`). */
  readonly idPrefix?: string;
  /** Caps (default: Durian's `LIMITS`): only the keys of `Limits` exist. */
  readonly limits?: Readonly<Partial<Limits>>;
  /** Checks every link and image URL (the parser applies it, and the renderer again). */
  readonly urlPolicy?: UrlPolicy;
  /**
   * A host's own inline tokens in prose, tried BEFORE Markdown's own (`src/markdown.ts`): each match becomes a `ref` node
   * carrying its raw text. Pass the same array every time (Durian caches the lexer by its identity).
   */
  readonly inlines?: readonly InlineDef[];
  /** Host blocks for this call, added to the ones registered process-wide. */
  readonly blocks?: readonly BlockDef<any, any>[];
}

/** The host's URL hook: the URL to use, or `null` to drop it (the text stays, without a link). */
export type UrlPolicy = (url: string, kind: 'link' | 'image') => string | null;

/** A host inline token (`src/markdown.ts`): a pattern with no `g`/`y` flag; the React entry adds its `Component`. */
export interface InlineDef {
  /** lower case letters, digits and dashes */
  readonly name: string;
  readonly match: RegExp;
}

export declare function parse(text: string, options?: ParseOptions): Document;
export declare function check(doc: Document | string, options?: ParseOptions): Problem[];
export declare function llmView(doc: Document | string, options?: ParseOptions): string;

/** What the parser hands a host block: the lines inside the fence, the fence's `key=value` attributes and its line. */
export interface BlockInput {
  readonly body: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly line: number;
}

/** A host's own fenced part: one definition serves the parser (`parse`, `llm`, `check`) and the renderer (`Component`). */
export interface BlockDef<D = unknown, C = unknown> {
  readonly name: string;
  /** Body to data. Throwing shows Durian's error block, so a host that wants plain code answers instead. */
  readonly parse?: (input: BlockInput) => D;
  /** What an LLM reads in place of the block. */
  readonly llm?: (data: D, input: BlockInput) => string;
  readonly check?: (
    data: D,
    input: BlockInput,
  ) => { readonly line?: number; readonly level?: 'error' | 'warn'; readonly message: string }[];
  readonly Component?: C;
}
