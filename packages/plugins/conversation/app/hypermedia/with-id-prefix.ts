import type { Document } from 'durian-hypermedia';

/**
 * A DOCUMENT FOR THIS MESSAGE'S OWN IDS. A message is read once per text and the document kept (`durian-reader.ts`), so the
 * prefix its heading ids were made with is made of its text, and two messages with the same text would share their ids. Each
 * message on screen therefore takes its own: every heading id, anchor link and anything else Durian wrote that prefix into
 * is the same string in the document's data, and is replaced where it stands.
 *
 * The prefix being replaced (`dh-<53 bits of the text's own hash>-`) is not text an author can put in a message by chance or
 * by design (it would have to be the hash of the message that holds it), so no prose is ever changed. A pure function of its
 * input; the same document is returned when the prefixes are the same.
 */
export function withIdPrefix(doc: Document, from: string, to: string): Document {
  if (from === to) return doc;
  return JSON.parse(JSON.stringify(doc).replaceAll(from, to)) as Document;
}
