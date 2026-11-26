import { PART_SHAPES } from './lazy-part-shapes.ts';

/**
 * THE FOLDER PARTS' PARSERS, AND KATEX, FETCHED WHEN A MESSAGE FIRST NEEDS THEM (U1 review, item 2: the cold chat path).
 *
 * Durian 0.7.0's parser carries thirty-one parts and the maths library (KaTeX, which writes the tree of a formula AT PARSE TIME). Measured
 * at U1 that was 333 KB gzip in the parser worker the first rich message starts, against 110 KB before the swap, for parts almost no
 * message uses. The parser is synchronous and a part's code cannot be fetched in the middle of a parse, so the worker holds the parts the
 * way it holds the scene compiler (`scene-late.ts`): by a door that is shut until what is behind it has arrived, and an ask that finds the
 * door shut is repeated once it has.
 *
 *  - `vite-durian.ts` rewrites Durian's generated registry (`lazyRegistry`): each `import audio from "../audio/part"` becomes
 *    `const audio = lazyPart("audio")` and the real import is a dynamic one, registered here (`registerPartLoaders`). KaTeX is the same
 *    (`katex-late.ts`, `registerKatexLoader`).
 *  - A stand-in answers what the parser asks BEFORE it parses (`PART_SHAPES`) and, when its part's code is not here, says which part it
 *    needs (`needs`) and answers with nothing. A parse that needed something is discarded, never shown and never cached: the worker
 *    (`durian-worker.ts`) loads what was named (`loadNeeded`) and parses again.
 *  - Nothing is lost: a part parsed after its code arrived is parsed by the part's own code, and `tests/perf/lazy-worker.test.ts` holds
 *    the built worker's answers equal to the eager parser's on messages that use every kind of thing that is lazy.
 *
 * A build that does not go through the plugin (Bun's own bundler, `bun test`) never imports this file: Durian reads its own registry
 * there, with every part in it.
 */

interface RealPart {
  parse(input: unknown, context: unknown): unknown;
  llm?(data: unknown, input: unknown): unknown;
  llmExempt?(data: unknown): unknown;
  check?(data: unknown, input: unknown): unknown;
}
/** What a part's `part.ts` module is: its definition is the default export. */
type PartModule = { readonly default: RealPart };

const parts = new Map<string, RealPart>();
const partLoaders = new Map<string, () => Promise<PartModule>>();
const needed = new Set<string>();
/** KaTeX, once it has arrived (`katex-late.ts` reads it). */
let katexLibrary: unknown;
let katexLoader: (() => Promise<{ readonly default: unknown }>) | undefined;

/** Registers how each part's code is fetched (the registry the plugin rewrote calls this once, when it evaluates). */
export function registerPartLoaders(loaders: Readonly<Record<string, () => Promise<PartModule>>>): void {
  for (const [name, load] of Object.entries(loaders)) partLoaders.set(name, load);
}

/** Registers how KaTeX is fetched. */
export function registerKatexLoader(load: () => Promise<{ readonly default: unknown }>): void {
  katexLoader = load;
}

/** KaTeX, or `undefined` while it has not arrived. */
export const katexIfHere = (): unknown => katexLibrary;

/** Says the parse in progress needs this: part names, and `katex`. */
export function needs(name: string): void {
  needed.add(name);
}

/** What the parse that just ended needed and did not have, and forgets it. Empty: the parse is the real one. */
export function takeNeeds(): string[] {
  const names = [...needed];
  needed.clear();
  return names;
}

/** Fetches what a parse named. A name nobody can fetch is an error (the page shows the message as text). */
export async function loadNeeded(names: readonly string[]): Promise<void> {
  await Promise.all(
    names.map(async name => {
      if (name === 'katex') {
        if (katexLoader === undefined) throw new Error('katex has no loader');
        katexLibrary ??= (await katexLoader()).default;
        return;
      }
      if (parts.has(name)) return;
      const load = partLoaders.get(name);
      if (load === undefined) throw new Error(`the ${name} part has no loader`);
      parts.set(name, (await load()).default);
    }),
  );
}

/**
 * The stand-in for one part's definition: what the parser reads before parsing (`PART_SHAPES`) and a `parse`, `llm`, `llmExempt` and
 * `check` that are the part's own once its code is here. Until then `parse` names the part and answers `null`.
 */
export function lazyPart(name: string): Record<string, unknown> {
  const shape = PART_SHAPES[name];
  if (shape === undefined) throw new Error(`the ${name} part has no shape: add it to lazy-part-shapes.ts`);
  const real = (): RealPart | undefined => {
    const found = parts.get(name);
    if (found === undefined) needs(name);
    return found;
  };
  return {
    name,
    form: 'fenced',
    steps: shape.steps,
    llmKind: shape.llmKind,
    ...(shape.fences === undefined ? {} : { fences: shape.fences }),
    ...(shape.chartKinds === undefined ? {} : { chartKinds: shape.chartKinds }),
    parse: (input: unknown, context: unknown): unknown => real()?.parse(input, context) ?? null,
    ...(shape.llm ? { llm: (data: unknown, input: unknown): unknown => real()?.llm?.(data, input) ?? '' } : {}),
    ...(shape.llmExempt ? { llmExempt: (data: unknown): unknown => real()?.llmExempt?.(data) ?? false } : {}),
    check: (data: unknown, input: unknown): unknown => real()?.check?.(data, input) ?? [],
  };
}
