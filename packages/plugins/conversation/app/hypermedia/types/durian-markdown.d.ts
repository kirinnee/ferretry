/**
 * THE TYPES OF `durian-markdown` AS WE USE THEM, mapped in by `tsconfig.typecheck.json` (`paths`, the way
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
/** The format version the parser implements (SPEC.md); 11 in v0.7.0. */
export declare const FORMAT_VERSION: number;

/** One YAML parser for the front matter and the data parts; the browser has no `Bun.YAML`. */
export declare function setYamlParser(parse: ((text: string) => unknown) | null): void;

/** The caps (`src/safety.ts`): a host may lower or raise any of them with `parse(text, { limits })`. The keys of `Limits` and `PartLimits` are the whole set. */
export interface Limits extends PartLimits {
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
  /** steps of any stepped part (terminal, file tree, editor, code walk, animation) */
  maxSteps: number;
  /** layout work of one animation, and of every animation on the page together */
  maxAnimWork: number;
  maxPageAnimWork: number;
  /** work of one part's expressions (a chart's let, x and series): steps, value slots, characters of text */
  maxEvalSteps: number;
  maxEvalValues: number;
  maxEvalChars: number;
  /** the same for the whole page */
  maxPageEvalSteps: number;
  maxPageEvalValues: number;
  maxPageEvalChars: number;
  /** aliases one YAML text may use */
  maxYamlAliases: number;
  /** characters of one YAML text, and of all of a page's YAML texts together */
  maxYamlChars: number;
  maxPageYamlChars: number;
  /** nodes of one YAML text, and of all of a page's YAML texts together */
  maxYamlNodes: number;
  maxPageYamlNodes: number;
  /** annotations, steps and heatmap cells of one chart */
  maxChartAnnotations: number;
  maxChartSteps: number;
  maxChartHeatCells: number;
  /** rows and inputs of a calculator-layout chart */
  maxCalcRows: number;
  maxCalcInputs: number;
  /** references (`[[type:name]]`) one page may hold, and the bytes of all the parts they resolve to */
  maxReferences: number;
  maxReferenceBytes: number;
  /** bytes of one SVG, and of one interactive part, a reference resolves to */
  maxSvgBytes: number;
  maxInteractiveBytes: number;
}
/** The caps of the folder parts (`src/parts/<name>/limits.ts`, generated into `src/parts/generated/limits.ts`): each key starts with its part's name. */
export interface PartLimits {
  audioTranscriptLines: number;
  audioChapters: number;
  audioMarkers: number;
  audioVttCues: number;
  audioWaveformSamples: number;
  audioPeaksBytes: number;
  audioDecodeBytes: number;
  audioTranscriptBytes: number;
  calendarLines: number;
  calendarOccurrences: number;
  chartKindsValues: number;
  chartKindsViolinValues: number;
  chartKindsBins: number;
  chartKindsCategories: number;
  chartKindsSeries: number;
  chartKindsMarks: number;
  chartKindsStages: number;
  chartKindsSteps: number;
  chartKindsTreeNodes: number;
  chartKindsTreeDepth: number;
  chartKindsDays: number;
  chartKindsLabel: number;
  compareOptions: number;
  compareRows: number;
  compareValue: number;
  compareNote: number;
  compareName: number;
  compareImageAlt: number;
  compareImageLabel: number;
  compareImageUrl: number;
  diffLines: number;
  diffFiles: number;
  diffWordLine: number;
  diffWordTokens: number;
  diffEditLength: number;
  downloadsFiles: number;
  downloadsCheckBytes: number;
  exploreChars: number;
  exploreDepth: number;
  exploreCsvRows: number;
  exploreCsvCols: number;
  exploreQueryChars: number;
  exploreReaderQueryChars: number;
  exploreQueryDepth: number;
  exploreQueryResults: number;
  exploreRegexChars: number;
  exploreRegexProgram: number;
  exploreRegexRepeat: number;
  exploreQueryJsonChars: number;
  exploreReaderSteps: number;
  exploreReaderValues: number;
  exploreReaderChars: number;
  exploreRowsPerNode: number;
  exploreSearchNodes: number;
  exploreTableRows: number;
  exploreTableCols: number;
  exploreStringCut: number;
  fishboneCauses: number;
  fishboneSubCauses: number;
  flameFrames: number;
  flameLines: number;
  flameDepth: number;
  flameName: number;
  galleryImages: number;
  ganttTasks: number;
  ganttSteps: number;
  ganttSections: number;
  ganttDeps: number;
  ganttSpanDays: number;
  glossaryTerms: number;
  glossaryLabel: number;
  glossaryDef: number;
  glossaryAliases: number;
  graphNodes: number;
  graphEdges: number;
  graphGroups: number;
  graphDepth: number;
  graphFoldFirst: number;
  httpLines: number;
  httpHeaders: number;
  httpJsonDepth: number;
  httpJsonNodes: number;
  httpChars: number;
  logLines: number;
  logQueryChars: number;
  logReaderQueryChars: number;
  logQueryDepth: number;
  logQueryResults: number;
  logRegexChars: number;
  logRegexProgram: number;
  logRegexRepeat: number;
  logQueryJsonChars: number;
  logReaderSteps: number;
  logReaderValues: number;
  logReaderChars: number;
  lottieBytes: number;
  lottieFrames: number;
  lottieLayers: number;
  lottieNodes: number;
  mapPlaces: number;
  mapShapes: number;
  mapPoints: number;
  mapFills: number;
  mapArcs: number;
  mapGeoPoints: number;
  mathChars: number;
  mathFormulas: number;
  mathNodes: number;
  pdfPages: number;
  pdfBytes: number;
  referencesEntries: number;
  referencesAuthors: number;
  referencesText: number;
  referencesCites: number;
  sankeyFlows: number;
  sankeyNodes: number;
  sankeySteps: number;
  sequenceParticipants: number;
  sequenceItems: number;
  sequenceDepth: number;
  sparkValues: number;
  stacktraceLines: number;
  statsTiles: number;
  statsSpark: number;
  statsText: number;
  statsNote: number;
  timelineEvents: number;
  traceSpans: number;
  traceLines: number;
  traceDepth: number;
  traceName: number;
  traceAttrs: number;
  traceValue: number;
  traceLogs: number;
  traceServices: number;
  traceText: number;
  traceServiceLabel: number;
  traceOpen: number;
  vennNames: number;
  videoTranscriptLines: number;
  videoChapters: number;
  videoCaptionFiles: number;
  videoVttCues: number;
  videoTranscriptBytes: number;
  videoVttBytes: number;
  videoThumbsBytes: number;
  wardleyComponents: number;
  weatherRows: number;
  weatherLineChars: number;
  weatherNoteChars: number;
}

/** The default caps, sized for AUTHORED pages (`src/safety.ts`). Never the caps of a chat message: see {@link UNTRUSTED_LIMITS}. */
export declare const LIMITS: Readonly<Limits>;
/** `LIMITS` with smaller YAML and animation caps, for text nobody reviewed (a chat reply, a streamed message). */
export declare const UNTRUSTED_LIMITS: Readonly<Limits>;

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
  | { t: 'ref'; name: string; text: string; data: unknown }
  | {
      t: 'reference';
      type: string;
      name: string;
      label: string | null;
      text: string;
      error?: string;
      state?: 'pending' | 'ready' | 'failed';
      reason?: string;
    };
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
  llmKind: 'as-is' | 'data' | 'steps' | 'lines' | 'unwrap' | 'text' | 'none' | 'drop' | 'replace' | 'host' | 'own';
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
/** An own mark or prompt prefix (`src/types.ts`): a label, a theme colour name and what it means. */
export interface MarkDef {
  label: string;
  colour: string;
  means: string;
}
export interface TerminalBlock extends PartBase {
  type: 'terminal';
  title: string | null;
  prompt: string;
  /** the own prompts this terminal uses */
  prefixes: Record<string, MarkDef>;
  steps: {
    title: string;
    lines: { k: 'cmd' | 'out'; text: string; prompt?: string; hl?: [string, string | null][] }[];
  }[];
}
export interface FileTreeBlock extends PartBase {
  type: 'filetree';
  /** the own marks this tree uses */
  marks: Record<string, MarkDef>;
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
  initial: {
    x: Val[];
    series: ChartSeries[];
    vars: Record<string, Val>;
    error?: string;
    limit?: 'part' | 'page';
    /** The facts of a chart written with steps, a time axis, annotations, formats or a heatmap (`core/chart11.ts`). */
    ext?: unknown;
  };
}
export interface AnimationBlock extends PartBase {
  type: 'animation';
  anim: {
    head: string;
    steps: { title: string; raw: string; line: number }[];
    base: number;
    info: Record<string, string>;
  };
  /** A composed stage (lanes, cards, panels, a time block): its source and the page's roles (role name to colour 0 to 8). */
  stage?: {
    src: {
      head: string;
      steps: { title: string; raw: string; line: number }[];
      base: number;
      info: Record<string, string>;
    };
    roles: Record<string, number>;
  };
  /** what a reader sees as text in this animation, in story order */
  texts: string[];
}
/** A state, class or ER diagram (`core/diagrams.ts`): its own small language, compiled to a scene the animation engine draws. */
export interface DiagramBlock extends PartBase {
  type: 'state' | 'class' | 'er';
  anim: AnimationBlock['anim'] & { part: 'state' | 'class' | 'er'; title: string };
  /** What stops it being drawn; then `body` (its source) is shown plain. */
  refused: { line: number; msg: string }[];
  body: string;
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
/** The fence words of the parts in their own folders (`src/parts/<name>/`, `FOLDER_PART_NAMES`). */
export type FolderPartName =
  | 'audio'
  | 'calendar'
  | 'chart-kinds'
  | 'compare'
  | 'compare-image'
  | 'diff'
  | 'downloads'
  | 'explore'
  | 'fishbone'
  | 'flame'
  | 'gallery'
  | 'gantt'
  | 'glossary'
  | 'graph'
  | 'http'
  | 'log'
  | 'lottie'
  | 'map'
  | 'math'
  | 'pdf'
  | 'references'
  | 'sankey'
  | 'sequence'
  | 'stacktrace'
  | 'stats'
  | 'timeline'
  | 'trace'
  | 'venn'
  | 'video'
  | 'wardley'
  | 'weather';
/** A part in its own folder: `data` is what its parser returned (a shape of its own, not declared here: this app draws none of them yet). */
export type FolderBlock = {
  [N in FolderPartName]: PartBase & { type: N; data: unknown };
}[FolderPartName];
/** A reference on a line of its own, `[[<type>:<name> "label"]]`: the host keeps the part and `resolveReference` answers for it. */
export interface ReferenceBlock extends PartBase {
  type: 'reference';
  ref: { type: string; name: string; label: string | null; text: string };
  state: 'unresolved' | 'pending' | 'ready' | 'failed';
  /** Why it failed (the host's words, or the package's). */
  reason?: string;
  /** The referenced part, when ready. */
  blocks?: Block[];
}
/** Raw SVG a reference stood for: drawn only through an `<img>`. */
export interface SvgBlock extends PartBase {
  type: 'svg';
  svg: string;
  title: string | null;
  alt: string;
}
/** A component the host keeps (HTML, CSS, script) a reference stood for: run only in a sandboxed frame, and only when the host turns it on. */
export interface InteractiveBlock extends PartBase {
  type: 'interactive';
  title: string | null;
  height: number;
  html: string;
  css: string;
  script: string;
  fallback: MdBlock[];
  alt: string;
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
  | AnimationBlock
  | DiagramBlock
  | TierListBlock
  | AlignmentBlock
  | TabsBlock
  | AccordionBlock
  | HumanBlock
  | ErrorBlock
  | HostBlock
  | FolderBlock
  | ReferenceBlock
  | SvgBlock
  | InteractiveBlock;
/** The part names a component may be given for: the closed set of block `type`s. */
export type BlockType = Block['type'];

export interface Document {
  readonly ast: 1;
  readonly format: number;
  readonly source: string;
  readonly path: string;
  readonly frontMatter: Readonly<Record<string, unknown>>;
  readonly title: string | null;
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
