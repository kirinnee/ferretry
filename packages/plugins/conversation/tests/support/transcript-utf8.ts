/**
 * Transcript records are measured in UTF-8 bytes — every pointer is a byte offset into the file — but held
 * as JavaScript strings. Encoding a record only to read its length copies every byte of it; over a 32 MiB
 * read that copying was where the event loop waited when the machine was short of memory.
 */

/** The UTF-8 length of `text[from, to)`, counted rather than encoded so nothing is allocated for it. */
export function utf8Length(text: string, from = 0, to = text.length): number {
  let length = 0;
  for (let index = from; index < to; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < to) {
      const low = text.charCodeAt(index + 1);
      // A surrogate pair is one four-byte character; a lone surrogate encodes as U+FFFD, three bytes.
      if (low >= 0xdc00 && low <= 0xdfff) {
        length += 4;
        index += 1;
      } else length += 3;
    } else length += 3;
  }
  return length;
}
