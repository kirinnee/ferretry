/**
 * THE SIZE A MESSAGE MAY BE AND STILL BE PARSED AS HYPERMEDIA. Durian's own cap is 1 MB; `marked` is regex-driven and the
 * transcript tail the daemon hands the app is 512 KiB, so a message over 300,000 bytes is a log pasted whole, not prose
 * an agent wrote. It is shown as the text it is ({@link exceedsMessageCap}), never as Durian's "the page is too big"
 * error, which would hide the message.
 */
const MAX_MESSAGE_BYTES = 300_000;

/** The cap the AUTHOR's message is held to: what the CLI's `fy render check` and {@link exceedsMessageCap} count. */
export const MESSAGE_LIMITS = { maxInputBytes: MAX_MESSAGE_BYTES } as const;

/**
 * THE FIXED BUDGET OF THE PARSER, which is not the author's cap. The text Durian is given is not the message byte for
 * byte: line endings are normalised, a NUL becomes U+FFFD (1 byte to 3), and a held fence's opener gains a word. Durian
 * counts what it is given, so a cap equal to the message cap would answer a message just under it with Durian's own "the
 * page is too big" error. The parser's budget is Durian's default, a fixed number far above any reading of a message
 * under the cap (the worst growth, every byte a NUL, is three times 300,000); a text that still passes it is shown as
 * the text it is ({@link exceedsParserBudget}), never as that error.
 */
export const PARSER_LIMITS = { maxInputBytes: 1_000_000 } as const;

const encoder = new TextEncoder();

/** True when `text` is over `limit` bytes in UTF-8, measured only when its length cannot settle it (a UTF-16 unit is at most 3 bytes). */
function exceedsBytes(text: string, limit: number): boolean {
  if (text.length > limit) return true;
  if (text.length * 3 <= limit) return false;
  return encoder.encode(text).length > limit;
}

/** True when the message the author wrote is over {@link MESSAGE_LIMITS}, counted in UTF-8 bytes. */
export const exceedsMessageCap = (text: string): boolean => exceedsBytes(text, MESSAGE_LIMITS.maxInputBytes);

/** True when the text Durian would be given is over {@link PARSER_LIMITS}, counted in UTF-8 bytes. */
export const exceedsParserBudget = (text: string): boolean => exceedsBytes(text, PARSER_LIMITS.maxInputBytes);

/**
 * HOW BIG THE DOCUMENT DURIAN MADE MAY BE, FOR THE MESSAGE IT WAS MADE FROM (checked inside the worker, before the result is
 * copied across to the page). A small input must never grow into a tree the page has to receive, copy and draw: the parse
 * can be stopped at a time budget, but a result that arrives in time can still be enormous.
 *
 *  - SERIALIZED SIZE: at most {@link DOCUMENT_BYTES_PER_BYTE} times the message's bytes, plus {@link DOCUMENT_BYTES_FLOOR}. Durian's
 *    tree is JSON with a field name per node (`{"t":"text","v":"…"}`). MEASURED on the pinned release: prose 3.8×, a table 6.8×,
 *    a list 10×, a heading and a line of text per section 14×, and the densest honest Markdown (an emphasis mark on every
 *    word) 16.8×. 24 leaves headroom over that and still bounds the result to 24 × 300,000 bytes plus the floor, about 7.3 MB,
 *    for the largest message the cap lets through. The floor lets a short message through whatever its ratio (a three-byte
 *    emphasis is 118×).
 *  - NODES: at most {@link DOCUMENT_NODES_PER_BYTE} per message byte plus {@link DOCUMENT_NODES_FLOOR}: a node is at least a
 *    mark or a character of the message, so more than three per byte is expansion, not reading.
 */
export const DOCUMENT_BYTES_PER_BYTE = 24;
export const DOCUMENT_BYTES_FLOOR = 65_536;
export const DOCUMENT_NODES_PER_BYTE = 3;
export const DOCUMENT_NODES_FLOOR = 2_000;

/**
 * True when `doc` (plain data: objects, arrays, strings, numbers) is over the budget for `source`. The node count is taken
 * first and stops at the cap, so a tree far over it is never serialized; only a tree within the node cap is.
 */
export function exceedsDocumentBudget(doc: unknown, source: string): boolean {
  const bytes = encoder.encode(source).length;
  const nodeCap = DOCUMENT_NODES_PER_BYTE * bytes + DOCUMENT_NODES_FLOOR;
  let nodes = 0;
  const pending: unknown[] = [doc];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next !== 'object' || next === null) continue;
    nodes += 1;
    if (nodes > nodeCap) return true;
    for (const child of Object.values(next)) pending.push(child);
  }
  return JSON.stringify(doc).length > DOCUMENT_BYTES_PER_BYTE * bytes + DOCUMENT_BYTES_FLOOR;
}
