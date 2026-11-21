import { type Document, parse } from 'durian-hypermedia';
import { configureDurian } from './durian.ts';
import { MESSAGE_LIMITS } from './limits.ts';
import { hypermediaUrlPolicy } from './url-policy.ts';
import { withReferences } from './with-references.ts';

/**
 * ONE MESSAGE, PARSED: Durian reads it with no front matter (a message that starts with `---` is Markdown the reader
 * sees), our URL policy and the size cap, and our reference grammar is then laid over its prose. `idPrefix` is this
 * message's own, so its heading ids never collide with another message's. A pure function of its input: the same
 * text and prefix always give the same document.
 */
export function parseMessage(text: string, idPrefix: string): Document {
  configureDurian();
  return withReferences(
    parse(text, { frontMatter: false, idPrefix, limits: MESSAGE_LIMITS, urlPolicy: hypermediaUrlPolicy }),
  );
}
