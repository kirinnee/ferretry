import type { BlockDef, HostBlock } from 'durian-hypermedia';
import type { ComponentType } from 'react';
import { DURIAN_FENCE, durianFences, linesOf } from './fence-boundaries.ts';
import { durianAsIs } from './fy-render-host.tsx';
import { authorTextBeside, LlmOnlyText } from './llm-text.tsx';
import { HypermediaCode } from './slots.tsx';

/**
 * TWO DURIAN PARTS ARE HELD AS THE CODE THEY ARE, BEFORE DURIAN READS THEM (r12 H4 review R1: S1 and G1).
 *
 * ```chart (S1, HIGH). Durian evaluates a chart's `let` formulas AT PARSE TIME (`src/core/dh-lib.ts` `jsonOf`, then
 * `chart-llm.ts`), on the main thread, and again on every control change. Its expression engine (`src/core/expr.ts`)
 * counts steps per AST node with a fresh budget per definition, a broadcast over a 10,000-item list is ONE step, and the
 * size cap checks only a list's top level. Measured on this pin: a 421-byte chart of nested user functions freezes the tab
 * for 3.2 s, four of them for 12.6 s, and `fill(fill(fill(1,300),300),300)+1` (40 chars) allocates 27 million values. A
 * message can hold hundreds of them and is read again every time its transcript opens. No size cap on OUR side bounds
 * that work, so no chart is evaluated until upstream bounds the evaluator (the ask is in `C1-upstream-ask.md`: one step
 * per broadcast element, one budget per document, a cap on total nested size). Of Durian's parts only `chart` reaches
 * `src/core/expr.ts` (`chart.ts`; `doccheck.ts` too, which a message never runs): the animation, tier list, alignment,
 * terminal, file tree, editor, code walk and mermaid parts read no expression. Our own `fy-render` chart is a different,
 * bounded reader and is untouched.
 *
 * ```codewalk (G1). It is not drawn (its notes are set as HTML, which the page's Trusted Types policy refuses), and a
 * Durian block keeps no source: with an author's `:::llm` after it, the fence's own text was nowhere on the page. Held,
 * its source and notes are drawn as code, and the `:::llm` text is the disclosure beside them.
 *
 * THE WHOLE DEFENCE IS THAT THE EVALUATOR (and the code walk's reader) IS NEVER REACHED. Every fence Durian's own line
 * scan would read as one of these parts (any depth: top level, `:::tabs`, `:::accordion`, `:::human`, `:::llm`) has its
 * fence word renamed to a host block of ours, which Durian carries as data. It stays a PART to Durian, so an author's
 * `:::llm` after it still attaches (after a plain code fence Durian would refuse the whole message). `HYPERMEDIA_PARTS`
 * still names a component for both (its type requires one per part); none is reachable.
 */

/** The fence words held, and the host block each is renamed to. */
const HELD: Readonly<Record<string, string>> = { chart: 'fy-chart-held', codewalk: 'fy-codewalk-held' };

/** The host block a fence word is renamed to, when it is one held. */
const heldNameOf = (word: string | undefined): string | undefined =>
  word !== undefined && Object.hasOwn(HELD, word) ? HELD[word] : undefined;

/**
 * `text` with every fence Durian reads as a held part renamed to its host block; `text` itself when it holds none. It reads
 * the fences the way Durian does (its own pattern and its own line scan), so it holds exactly the ones Durian would
 * evaluate, whatever CommonMark makes of them. Line numbers do not move.
 */
export function holdFences(text: string): string {
  if (!text.includes('chart') && !text.includes('codewalk')) return text;
  const lines = [...linesOf(text)];
  let held = false;
  for (const { open } of durianFences(lines)) {
    const parts = DURIAN_FENCE.exec(lines[open] ?? '');
    const name = heldNameOf(parts?.[3]);
    if (parts === null || name === undefined) continue;
    const before = parts[0].length - (parts[3]?.length ?? 0) - (parts[4]?.length ?? 0);
    lines[open] = `${parts[0].slice(0, before)}${name}${parts[4] ?? ''}`;
    held = true;
  }
  return held ? lines.join('\n') : text;
}

/** What the parser hands the component: the fence body as written, and Durian's own `as-is` text for it. */
interface HeldFenceData {
  readonly body: string;
  readonly generated: string | null;
}

/**
 * The parser half, for ONE message (`heldText` is what {@link holdFences} returned, which Durian is given). No `llm` hook,
 * as with `fy-render`: the author's `:::llm` after the fence stays on `block.llm` for the disclosure.
 */
export function heldFenceParseBlocks(heldText: string): readonly BlockDef<HeldFenceData>[] {
  const lines = linesOf(heldText);
  return Object.values(HELD).map(name => ({
    name,
    parse: input => ({ body: input.body, generated: durianAsIs(lines[input.line - 1], input.body, input.attrs) }),
  }));
}

/** The fence as the code it is, then the author's `:::llm` text as the usual disclosure. */
const heldPart =
  (lang: string): ComponentType<{ block: HostBlock; data: HeldFenceData }> =>
  ({ block, data }) => {
    const text = authorTextBeside(block, data.generated);
    return (
      <>
        <HypermediaCode lang={lang} meta="" text={data.body} />
        {text === null ? null : <LlmOnlyText text={text} />}
      </>
    );
  };

/** The renderer half, module-level and never rebuilt (Durian keys its settings on the identity of the `blocks` array). */
export const HELD_COMPONENT_BLOCKS: readonly BlockDef<
  HeldFenceData,
  ComponentType<{ block: HostBlock; data: HeldFenceData }>
>[] = Object.entries(HELD).map(([lang, name]) => ({ name, Component: heldPart(lang) }));
