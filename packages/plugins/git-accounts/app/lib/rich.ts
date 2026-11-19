/** A run of text: plain, bold (`**x**`) or code (backticks). Only these two marks exist; nothing is parsed as HTML. */
export interface RichPart {
  readonly kind: 'text' | 'bold' | 'code';
  readonly text: string;
  /** Where the part starts in the source: unique within one sentence, so it is the part's key. */
  readonly at: number;
}

const MARK = /(\*\*[^*]+\*\*|`[^`]+`)/u;

export function richParts(source: string): readonly RichPart[] {
  let at = 0;
  const parts: RichPart[] = [];
  for (const part of source.split(MARK)) {
    if (part !== '') {
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
        parts.push({ kind: 'bold', text: part.slice(2, -2), at });
      else if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
        parts.push({ kind: 'code', text: part.slice(1, -1), at });
      else parts.push({ kind: 'text', text: part, at });
    }
    at += part.length;
  }
  return parts;
}
