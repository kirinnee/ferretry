import { type Document, parse } from 'durian-hypermedia';
import { animationEngineReady } from './animation-engine.ts';
import { configureDurian } from './durian.ts';
import { settleFences } from './fence-boundaries.ts';
import { type DrawableFyRenderBodiesMap, drawableBodies, fyRenderParseBlock } from './fy-render-host.tsx';
import { ANIMATION_DRAWS, heldFenceParseBlocks, holdFences } from './held-fences.tsx';
import { LITERAL_CODE_INLINES, mayHoldLiteralCode } from './literal-code.tsx';
import { exceedsMessageCap, exceedsParserBudget, exceedsPreParseLimits, PARSER_LIMITS } from './limits.ts';
import { hypermediaUrlPolicy } from './url-policy.ts';
import { withReferences } from './with-references.ts';

/** One message, read: the document Durian made of it, and the `fy-render` bodies CommonMark found closed in it. */
export interface ReadMessage {
  readonly doc: Document;
  /** The bodies the code slot may draw as blocks ({@link drawableBodies}). */
  readonly drawable: DrawableFyRenderBodiesMap;
}

/**
 * ONE MESSAGE, READ: Durian reads it with no front matter (a message that starts with `---` is Markdown the reader
 * sees), our URL policy and the size cap, and our reference grammar is then laid over its prose. `idPrefix` is this
 * message's own, so its heading ids never collide with another message's. A pure function of its input: the same
 * text and prefix always give the same result.
 *
 * EVERY FENCE'S BOUNDARIES ARE DECIDED BEFORE DURIAN SPLITS THE MESSAGE (`settleFences`): by CommonMark, from
 * micromark's tokens, once. A fence still arriving, or one Durian and CommonMark would end in different places, makes the
 * message plain code from that fence on, so nothing at or after it draws and a partial body is never run; a block draws
 * only where its parsed fence has a real closing delimiter. Durian is given that one decision, not asked again.
 *
 * ONE INPUT BESIDES THE TEXT: whether the 2D animation engine has arrived (`animation-engine.ts`). Without it an animation
 * fence is read as code; with it, as the animation. It only ever goes from the first to the second.
 *
 * `arriving` is true for the tail of a message still streaming in: a closing delimiter that is its last line is not yet
 * one (the rest of that line may turn it into content), so that fence stays open and inert until the line ends. A final
 * message is read as written.
 *
 * `null` MEANS "SHOW THE TEXT": the message is over a pre-parse limit (`exceedsPreParseLimits`, shown with a note: see
 * `plain-fallback.tsx`), or over the author's cap (`exceedsMessageCap`, counted on the bytes written), or
 * the text Durian would be given is over the parser's fixed budget (`exceedsParserBudget`: normalising line endings and NULs
 * and holding fences all change the size). Either way the message is shown as the text it is, never answered with Durian's
 * own "the page is too big" error (`limits.ts`).
 */
export function readMessage(
  source: string,
  idPrefix: string,
  arriving = false,
  /** Whether the 2D animation engine is here: the current state of the gate unless a caller (the view, which re-reads on arrival) says. */
  animationReady = animationEngineReady(),
): ReadMessage | null {
  if (exceedsMessageCap(source)) return null;
  // THE PRE-PARSE LIMITS come first, before anything reads the text but the limit check itself (`exceedsPreParseLimits`).
  if (exceedsPreParseLimits(source)) return null;
  configureDurian();
  const settled = settleFences(source, arriving);
  // A chart (unbounded formulas), a code walk and a `:::tabs` container are held as code before Durian can read them
  // (`held-fences.tsx`), and so is an animation until it draws again (`ANIMATION_DRAWS`, then its lazy engine).
  const text = holdFences(settled.text, !(ANIMATION_DRAWS && animationReady));
  if (exceedsParserBudget(text)) return null;
  const doc = parse(text, {
    blocks: [fyRenderParseBlock(settled), ...heldFenceParseBlocks(text)],
    frontMatter: false,
    idPrefix,
    limits: PARSER_LIMITS,
    urlPolicy: hypermediaUrlPolicy,
    // Offered only to a message that can hold such a span: every other message is read by Durian's own lexer.
    inlines: mayHoldLiteralCode(text) ? LITERAL_CODE_INLINES : undefined,
  });
  return { doc: withReferences(doc), drawable: drawableBodies(settled) };
}

/** The document of {@link readMessage}, or `null` when the message is shown as text. */
export const parseMessage = (source: string, idPrefix: string): Document | null =>
  readMessage(source, idPrefix)?.doc ?? null;
