import { type Document, parse } from 'durian-hypermedia';
import { configureDurian } from './durian.ts';
import { settleFences } from './fence-boundaries.ts';
import { drawableBodies, fyRenderParseBlock } from './fy-render-host.tsx';
import { LITERAL_CODE_INLINES, mayHoldLiteralCode } from './literal-code.tsx';
import { MESSAGE_LIMITS } from './limits.ts';
import { hypermediaUrlPolicy } from './url-policy.ts';
import { withReferences } from './with-references.ts';

/** One message, read: the document Durian made of it, and the `fy-render` bodies CommonMark found closed in it. */
export interface ReadMessage {
  readonly doc: Document;
  /** The bodies the code slot may draw as blocks ({@link drawableBodies}). */
  readonly drawable: ReadonlyMap<string, string>;
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
 */
export function readMessage(source: string, idPrefix: string): ReadMessage {
  configureDurian();
  const settled = settleFences(source);
  const doc = parse(settled.text, {
    blocks: [fyRenderParseBlock(settled)],
    frontMatter: false,
    idPrefix,
    limits: MESSAGE_LIMITS,
    urlPolicy: hypermediaUrlPolicy,
    // Offered only to a message that can hold such a span: every other message is read by Durian's own lexer.
    inlines: mayHoldLiteralCode(settled.text) ? LITERAL_CODE_INLINES : undefined,
  });
  return { doc: withReferences(doc), drawable: drawableBodies(settled) };
}

/** The document of {@link readMessage}. */
export const parseMessage = (source: string, idPrefix: string): Document => readMessage(source, idPrefix).doc;
