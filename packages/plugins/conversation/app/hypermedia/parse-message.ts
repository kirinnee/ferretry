import { type Document, parse } from 'durian-hypermedia';
import { configureDurian } from './durian.ts';
import { settleFences } from './fence-boundaries.ts';
import { type DrawableFyRenderBodiesMap, drawableBodies, fyRenderParseBlock } from './fy-render-parse.ts';
import { ANIMATION_DRAWS, heldFenceParseBlocks, holdFences } from './held-fence-parse.ts';
import { LITERAL_CODE_PARSE_INLINES, mayHoldLiteralCode } from './literal-code-match.ts';
import {
  exceedsDocumentBudget,
  exceedsMessageCap,
  exceedsParserBudget,
  exceedsPreParseLimits,
  PARSER_LIMITS,
} from './limits.ts';
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
 * ONE INPUT BESIDES THE TEXT: whether the 2D animation engine is here. Without it an animation fence is read as code; with
 * it, as the animation. The Durian worker (`durian-worker.ts`, the one caller in the product) never has it: the scene
 * compiler is a chunk of the page, not of the worker, so an animation in a message is shown as the code it is.
 *
 * THIS MODULE RUNS IN THE DURIAN WORKER (`durian-worker.ts`) AND NOWHERE ELSE IN THE PRODUCT: nothing on the page's main
 * thread reads a message with Durian (`tests/unit/app/hypermedia/durian-main-thread.test.ts` holds the import graph to
 * that), because a parse can take far longer than a frame and only a worker can be stopped. So it imports no React and no
 * shell: its inputs and its result are plain data.
 *
 * `arriving` is true for the tail of a message still streaming in: a closing delimiter that is its last line is not yet
 * one (the rest of that line may turn it into content), so that fence stays open and inert until the line ends. A final
 * message is read as written.
 *
 * `null` MEANS "SHOW THE TEXT": the message is over a pre-parse limit (`exceedsPreParseLimits`, shown with a note: see
 * `plain-fallback.tsx`), or over the author's cap (`exceedsMessageCap`, counted on the bytes written), or
 * the text Durian would be given is over the parser's fixed budget (`exceedsParserBudget`: normalising line endings and NULs
 * and holding fences all change the size). Either way the message is shown as the text it is, never answered with Durian's
 * own "the page is too big" error (`limits.ts`). It also means the document Durian made is out of proportion to the message
 * (`exceedsDocumentBudget`): a small input that grew into a huge tree is never sent across to the page.
 */
export function readMessage(
  source: string,
  idPrefix: string,
  arriving = false,
  /** Whether the 2D animation engine is here. Absent: it is not, and an animation fence is code. */
  animationReady = false,
  /** Durian's parser: only a test hands another (a stub that is slow, or that expands), so the time budget and the size budget can be proved. */
  parser: typeof parse = parse,
): ReadMessage | null {
  if (exceedsMessageCap(source)) return null;
  // THE PRE-PARSE LIMITS come first, before anything reads the text but the limit check itself (`exceedsPreParseLimits`).
  if (exceedsPreParseLimits(source)) return null;
  configureDurian();
  const settled = settleFences(source, arriving);
  // A chart (unbounded formulas), a code walk and a `:::tabs` or `:::accordion` container are held as code before Durian can read them
  // (`held-fence-parse.ts`), and so is an animation until it draws again (`ANIMATION_DRAWS`, then its lazy engine).
  const text = holdFences(settled.text, !(ANIMATION_DRAWS && animationReady));
  if (exceedsParserBudget(text)) return null;
  const doc = parser(text, {
    blocks: [fyRenderParseBlock(settled), ...heldFenceParseBlocks(text)],
    frontMatter: false,
    idPrefix,
    limits: PARSER_LIMITS,
    urlPolicy: hypermediaUrlPolicy,
    // Offered only to a message that can hold such a span: every other message is read by Durian's own lexer.
    inlines: mayHoldLiteralCode(text) ? LITERAL_CODE_PARSE_INLINES : undefined,
  });
  const read = withReferences(doc);
  return exceedsDocumentBudget(read, source) ? null : { doc: read, drawable: drawableBodies(settled) };
}

/** The document of {@link readMessage}, or `null` when the message is shown as text. */
export const parseMessage = (source: string, idPrefix: string): Document | null =>
  readMessage(source, idPrefix)?.doc ?? null;
