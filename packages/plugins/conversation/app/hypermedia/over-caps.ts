import type { Block } from 'durian-markdown';

/**
 * A MESSAGE THAT WENT OVER ONE OF DURIAN'S SIX SIZE CAPS (r12 H13, Durian 0.6.2): the YAML caps (`maxYamlChars`,
 * `maxPageYamlChars`, `maxYamlNodes`, `maxPageYamlNodes`) and the animation work caps (`maxAnimWork`, `maxPageAnimWork`).
 * Over one, Durian answers with an ERROR BLOCK in place of the part (and a problem), in its own words. In a chat message that
 * block is not drawn: the whole message is shown as the plain text it is, with the note (`plain-fallback.tsx`), exactly as for a
 * message over a pre-parse limit. A cap is a statement that the text is out of proportion; the app does not dress what is left.
 *
 * No React in this file: it runs inside the Durian worker (`durian-worker.ts`), on the document Durian made.
 *
 * THE WORDS ARE DURIAN'S (`host/yaml.ts` `yamlSizeCheck`, `core/work.ts` `animOverMessage`), so a release that rewords them
 * fails `tests/unit/app/hypermedia/over-caps.test.ts`, which makes each cap's error from the real parser, and not this file quietly.
 */
const CAP_ERROR =
  /^(?:the (?:page's )?YAML (?:is too long|has too many keys and values) \(|this animation needs too much layout work \(|the animations on this page need too much layout work \()/u;

/** The parts whose error block a size cap makes: a chart's YAML and an animation's layout. */
const CAPPED_PARTS: ReadonlySet<string> = new Set(['chart', 'animation']);

/** Whether `block`, or a block inside it, is Durian's error block for one of the six caps. */
function hasCapError(block: Block): boolean {
  switch (block.type) {
    case 'error':
      return block.part !== null && CAPPED_PARTS.has(block.part) && CAP_ERROR.test(block.message);
    case 'tabs':
    case 'accordion':
      return block.items.some(item => item.body.some(hasCapError));
    case 'human':
      return block.body.some(hasCapError);
    default:
      return false;
  }
}

/** True when any block of the document is Durian's error block for a size cap ({@link CAP_ERROR}). */
export const hasCapErrorBlock = (blocks: readonly Block[]): boolean => blocks.some(hasCapError);
