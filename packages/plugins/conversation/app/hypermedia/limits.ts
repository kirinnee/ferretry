/**
 * THE SIZE A MESSAGE MAY BE AND STILL BE PARSED AS HYPERMEDIA. Durian's own cap is 1 MB; `marked` is regex-driven and the
 * transcript tail the daemon hands the app is 512 KiB, so a message over 300,000 bytes is a log pasted whole, not prose
 * an agent wrote. It is shown as the text it is ({@link exceedsMessageCap}), never as Durian's "the page is too big"
 * error, which would hide the message.
 */
const MAX_MESSAGE_BYTES = 300_000;

/** What `parse` is given: the cap above; every other limit is Durian's own default (blocks, depth, steps, chart points). */
export const MESSAGE_LIMITS = { maxInputBytes: MAX_MESSAGE_BYTES } as const;

const encoder = new TextEncoder();

/** True when `text` is over {@link MAX_MESSAGE_BYTES} in UTF-8, measured only when its length cannot settle it. */
export function exceedsMessageCap(text: string): boolean {
  if (text.length > MAX_MESSAGE_BYTES) return true;
  if (text.length * 3 <= MAX_MESSAGE_BYTES) return false;
  return encoder.encode(text).length > MAX_MESSAGE_BYTES;
}
