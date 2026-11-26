import type { Block } from 'durian-markdown';
import { AlignmentPart } from 'durian-markdown/react/alignment';
import { CodeWalkPart } from 'durian-markdown/react/codewalk';
import { AccordionPart, TabsPart } from 'durian-markdown/react/containers';
import { EditorPart } from 'durian-markdown/react/editor';
import { FileTreePart } from 'durian-markdown/react/filetree';
import type { Components, Slots } from 'durian-markdown/react/strict';
import { TerminalPart } from 'durian-markdown/react/terminal';
import { TierListPart } from 'durian-markdown/react/tierlist';
import { GuardedAnimation } from './animation-part.tsx';
import { HypermediaHeading } from './demoted-heading.tsx';
import { FY_RENDER_COMPONENT_BLOCK, FY_RENDER_SLOTS } from './fy-render-host.tsx';
import { HELD_COMPONENT_BLOCKS } from './held-fences.tsx';
import { HumanSegment, UndrawnPart, withLlmText } from './llm-text.tsx';
import { MERMAID_COMPONENT_BLOCK } from './mermaid-slot.tsx';

/**
 * THE PARTS A MESSAGE DRAWS, and the policy each one is drawn under (r12 H4; DurianMarkdown 0.7.0, U1 of the swap).
 * Each part is imported from ITS OWN entry (`durian-markdown/react/terminal`, ...), never from `react/strict`, which lists every part of
 * the package and holds all of them (pdf.js, three, cytoscape, lottie, chart.js) in the page whatever is drawn: `react/strict` is
 * imported for TYPES only (erased). A part's entry sets no HTML string (no `dangerouslySetInnerHTML`, no `innerHTML`: `durian-asks.test.ts`
 * greps the whole package), so the page's Trusted Types policy has nothing to refuse.
 *
 *   terminal, filetree, editor, tierlist, alignment   Durian's own: text nodes only, no file read, no process.
 *   codewalk                                          Durian's own since U1. It was held as code because 0.6.2 set its notes
 *                                                     as HTML; its notes have been React elements since 0.3.0, and
 *                                                     `hypermedia-csp.visual.test.ts` runs every upstream fixture under the
 *                                                     page's policy with 0 violations.
 *   tabs, accordion                                   Held as code (`held-fence-parse.ts`); the components are the type's
 *                                                     required ones and are not reached.
 *   human                                             ours (`llm-text.tsx`): the body is drawn whatever `llm=` says.
 *   chart                                             NOT drawn until U5: held as code before Durian parses it
 *                                                     (`held-fences.tsx`), so its formulas never run; this component is
 *                                                     `UndrawnPart`, never reached.
 *   animation                                         Durian's engine, 2D and 3D (decision C4: 3D on), a lazy chunk, and a
 *                                                     lost WebGL context falls back to the flat view (`animation-part.tsx`).
 *                                                     Held as code today (`ANIMATION_DRAWS`).
 *   state, class, er                                  Held as code with the animation, whose scene compiler they share.
 *   every folder part (`diff`, `graph`, `log`, ...)   Held as code until each is reviewed and drawn (`held-fence-parse.ts`).
 *   mermaid                                           Not a Durian part any more: a host block of ours (`mermaid-slot.tsx`).
 *   reference, svg, interactive                       `[[type:name "label"]]` is drawn by Durian's own reference chip. With no
 *                                                     resolver given it is a chip with its label and never a request; `svg` and
 *                                                     `interactive` exist only as the answer to one, so nothing makes them yet.
 *
 * Every part goes through {@link withLlmText}: an author's `:::llm` text is the collapsed "LLM-only text" disclosure beside
 * it, never poured into the part's place (decision C7).
 */
/**
 * A TYPE THAT NAMES EVERY PART DURIAN HAS, so a release that adds one is a type error here, not a part drawn by Durian's own
 * default (whose fallback prints an author's `:::llm` text as if it were the part). The folder parts are named, as one group,
 * by `HELD_FOLDER_PARTS` (`held-fence-parse.ts`), which is typed against Durian's own list of them.
 */
type PartName = Exclude<
  Block['type'],
  | 'markdown'
  | 'toc'
  | 'error'
  | 'host'
  | 'reference'
  | 'svg'
  | 'interactive'
  | Extract<Block, { data: unknown }>['type']
>;

export const HYPERMEDIA_PARTS: Required<Pick<Components, PartName>> = {
  terminal: withLlmText(TerminalPart),
  filetree: withLlmText(FileTreePart),
  editor: withLlmText(EditorPart),
  codewalk: withLlmText(CodeWalkPart),
  tierlist: withLlmText(TierListPart),
  alignment: withLlmText(AlignmentPart),
  tabs: withLlmText(TabsPart),
  accordion: withLlmText(AccordionPart),
  human: HumanSegment,
  chart: UndrawnPart,
  animation: withLlmText(GuardedAnimation),
  state: UndrawnPart,
  class: UndrawnPart,
  er: UndrawnPart,
};

/**
 * The host blocks a message is drawn with: `fy-render`, the mermaid block, and every part held as code. Module-level: Durian
 * keys its settings on the identity of this array.
 */
export const HYPERMEDIA_COMPONENT_BLOCKS = [
  FY_RENDER_COMPONENT_BLOCK,
  MERMAID_COMPONENT_BLOCK,
  ...HELD_COMPONENT_BLOCKS,
] as const;

/** The slots a message is drawn with: the `fy-render` ones, plus our heading. Module-level, like every slot object (Durian keys its settings on the identity of this and `HYPERMEDIA_PARTS`). */
export const HYPERMEDIA_PART_SLOTS: Slots = {
  ...FY_RENDER_SLOTS,
  Heading: HypermediaHeading,
};
