import type { Block } from 'durian-hypermedia';
import {
  AccordionPart,
  AlignmentPart,
  ChartPart,
  EditorPart,
  FileTreePart,
  HostMermaidPart,
  type Components,
  type Slots,
  TabsPart,
  TerminalPart,
  TierListPart,
} from 'durian-hypermedia/react/strict';
import { GuardedAnimation } from './animation-part.tsx';
import { FY_RENDER_COMPONENT_BLOCK, FY_RENDER_SLOTS } from './fy-render-host.tsx';
import { HELD_COMPONENT_BLOCKS } from './held-fences.tsx';
import { HumanSegment, UndrawnPart, withLlmText } from './llm-text.tsx';
import { HypermediaMermaid } from './mermaid-slot.tsx';

/**
 * THE PARTS A MESSAGE DRAWS, and the policy each one is drawn under (r12 H4). `durian-hypermedia/react/strict` is the
 * only entry this plugin imports: its parts set no HTML string (no `dangerouslySetInnerHTML`, no `innerHTML`), so the
 * page's Trusted Types policy has nothing to refuse, and the in-page mermaid library and DOMPurify are not in its graph.
 *
 *   terminal, filetree, editor, tierlist, alignment   Durian's own: text nodes only, no file read, no process.
 *   tabs, accordion                                   Durian's own containers over the SAME renderer (`Blocks`), not
 *                                                     the legacy `Tabs` of `ui/parts`, which writes author HTML.
 *   human                                             ours (`llm-text.tsx`): the body is drawn whatever `llm=` says.
 *   chart                                             NOT drawn by Durian (r12 H4 review R1): its formulas have no bound on
 *                                                     their work, so a ```chart fence is held as code before Durian parses
 *                                                     it (`held-fences.tsx`) and this component is registered but never
 *                                                     reached, until upstream bounds the evaluator. Our `fy-render` chart
 *                                                     is the chart that draws.
 *   animation                                         Durian's engine, 2D and 3D (decision C4: 3D on). The 3D module is
 *                                                     a lazy chunk, loaded when a reader opens a 3D view, and a lost
 *                                                     WebGL context falls back to the flat view (`animation-part.tsx`).
 *   mermaid                                           Durian's part with OUR renderer in its slot (`mermaid-slot.tsx`).
 *   codewalk                                          NOT drawn: its notes are set as HTML (`src/ui/parts.tsx`), which a
 *                                                     Trusted Types page refuses. Held as code like `chart`
 *                                                     (`held-fences.tsx`): its source and notes are drawn, and its `:::llm`
 *                                                     text is the disclosure beside them. `UndrawnPart` is the type's
 *                                                     required component and is not reached.
 *
 * Every part but `codewalk` goes through {@link withLlmText}: an author's `:::llm` text is the collapsed "LLM-only text"
 * disclosure beside it, never poured into the part's place (decision C7).
 *
 * A TYPE THAT NAMES EVERY PART, so Durian adding one is a type error here, not a part drawn by Durian's own default (whose
 * fallback prints an author's `:::llm` text as if it were the part).
 */
type PartName = Exclude<Block['type'], 'markdown' | 'toc' | 'error' | 'host'>;

export const HYPERMEDIA_PARTS: Required<Pick<Components, PartName>> = {
  terminal: withLlmText(TerminalPart),
  filetree: withLlmText(FileTreePart),
  editor: withLlmText(EditorPart),
  tierlist: withLlmText(TierListPart),
  alignment: withLlmText(AlignmentPart),
  tabs: withLlmText(TabsPart),
  accordion: withLlmText(AccordionPart),
  human: HumanSegment,
  chart: withLlmText(ChartPart),
  animation: withLlmText(GuardedAnimation),
  mermaid: withLlmText(HostMermaidPart),
  codewalk: UndrawnPart,
};

/** The host blocks a message is drawn with: `fy-render`, and the chart and code walk held as code. Module-level: Durian keys its settings on the identity of this array. */
export const HYPERMEDIA_COMPONENT_BLOCKS = [FY_RENDER_COMPONENT_BLOCK, ...HELD_COMPONENT_BLOCKS] as const;

/** The slots a message is drawn with: the `fy-render` ones, plus the mermaid slot. Module-level, like every slot object (Durian keys its settings on the identity of this and `HYPERMEDIA_PARTS`). */
export const HYPERMEDIA_PART_SLOTS: Slots = { ...FY_RENDER_SLOTS, Mermaid: HypermediaMermaid };
