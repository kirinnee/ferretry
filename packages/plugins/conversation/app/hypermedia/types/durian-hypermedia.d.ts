/**
 * THE TYPES OF `durian-hypermedia` AS WE USE THEM, mapped in by the root `tsconfig.json` (`paths`, the way
 * `playwright-core` is). The package's own `types` entry is its TypeScript SOURCE (`./src/index.ts`; its `dist/` is never
 * built here, see `../../vite-durian.ts`), which this workspace's compiler would read as OURS and reject: the source is
 * written without `noUncheckedIndexedAccess` and has duplicate-key literals, so one `import` puts hundreds of errors
 * from `node_modules` into every typecheck. This declaration stands in for that source for the type checker only; the
 * bundler still builds the real source.
 *
 * Only what the hypermedia feature calls is declared, taken from the pinned release's own signatures
 * (`src/document.ts`, `src/types.ts`, `src/react/document.tsx`); the unit that first uses another export adds it
 * here, in the same PR. The permanent fix is upstream shipping declaration files (or source that compiles under
 * `noUncheckedIndexedAccess`): then these files and their `paths` entries are deleted and the import resolves to the package.
 */

export declare const VERSION: string;
/** The format version the parser implements (SPEC.md); 9 in v0.5.1. */
export declare const FORMAT_VERSION: number;

/** One YAML parser for the front matter and the data parts; the browser has no `Bun.YAML`. */
export declare function setYamlParser(parse: ((text: string) => unknown) | null): void;

export interface Problem {
  readonly line: number;
  readonly level: 'error' | 'warn';
  readonly message: string;
}

/** A part of the page. Every part has a `type` and its source `line`; the part-specific fields are Durian's own. */
export interface Block {
  readonly type: string;
  readonly line: number;
  readonly [field: string]: unknown;
}

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
}

export interface ParseOptions {
  readonly path?: string;
  /** `false`: a leading `---` block is Markdown the reader sees, not front matter. */
  readonly frontMatter?: boolean;
  /** Put before every id the page makes, so a page cannot clobber the host's own ids (default `dh-`). */
  readonly idPrefix?: string;
  readonly limits?: Readonly<Partial<Record<string, number>>>;
}

export declare function parse(text: string, options?: ParseOptions): Document;
export declare function check(doc: Document | string, options?: ParseOptions): Problem[];
export declare function llmView(doc: Document | string, options?: ParseOptions): string;
