import type { BlockDef, HostBlock } from 'durian-hypermedia';
import type { ComponentType } from 'react';
import { type HeldFenceData, HELD_BLOCKS } from './held-fence-parse.ts';
import { authorTextBeside, LlmOnlyText } from './llm-text.tsx';
import { HypermediaCode } from './slots.tsx';

/**
 * TWO DURIAN PARTS ARE HELD AS THE CODE THEY ARE, BEFORE DURIAN READS THEM (r12 H4 review R1: S1 and G1). This file is the
 * renderer half; the parser half, which renames the fences and carries their source as data, is `held-fence-parse.ts`
 * (it runs inside the Durian worker, so it has no React in it).
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
 * `HYPERMEDIA_PARTS` still names a component for both (its type requires one per part); none is reachable.
 */

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
>[] = HELD_BLOCKS.map(([lang, name]) => ({
  name,
  Component: heldPart(lang),
}));
