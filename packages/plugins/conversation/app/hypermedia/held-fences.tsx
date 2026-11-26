import type { BlockDef, HostBlock } from 'durian-markdown';
import type { ComponentType } from 'react';
import { type HeldFenceData, HELD_BLOCKS } from './held-fence-parse.ts';
import { authorTextBeside, LlmOnlyText } from './llm-text.tsx';
import { HypermediaCode } from './slots.tsx';

/**
 * SOME DURIAN PARTS ARE HELD AS THE CODE THEY ARE, BEFORE DURIAN READS THEM (r12 H4 review R1; widened in U1 of the DurianMarkdown swap). This
 * file is the renderer half; the parser half, which renames the fences and carries their source as data, is
 * `held-fence-parse.ts` (it runs inside the Durian worker, so it has no React in it). Held: `chart` (below), the `animation`, the
 * `state`, `class` and `er` diagrams, `:::tabs` and `:::accordion`, and every part of Durian 0.7.0's folders until a unit reviews and
 * draws it. A held fence is shown as the highlighted code it is, with the author's `:::llm` text beside it as the usual disclosure.
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
 * ```codewalk is NOT held any more (U1): Durian has drawn its notes as React elements since 0.3.0, and the page's policy is run over every
 * upstream fixture with 0 violations. The expression engine of 0.7.0 is metered (a per-part and a per-page budget), but `chart` stays
 * held until U5 re-measures the freeze cases against it.
 *
 * `HYPERMEDIA_PARTS` still names a component for each part it must (its type requires one); none of the held ones is reachable.
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
