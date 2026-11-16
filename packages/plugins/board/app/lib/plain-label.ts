/**
 * A card's summary as plain words. Markdown's marks (links, code ticks, emphasis, strike) are dropped so a clipped row
 * or tile reads as the words, not the marks; `plainPreview` then flattens it to one line. Pure.
 */

const BOUNDARY = String.raw`(?<![\p{L}\p{N}])`;
const BOUNDARY_AFTER = String.raw`(?![\p{L}\p{N}])`;

const LINK = /!?\[([^\]]*)\]\([^)]*\)/gu;
const STRONG = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/gu;
const EMPHASIS_STAR = /\*(?=\S)([^*]+?)(?<=\S)\*/gu;
const EMPHASIS_UNDERSCORE = new RegExp(`${BOUNDARY}_(?=\\S)([^_]+?)(?<=\\S)_${BOUNDARY_AFTER}`, 'gu');
const CODE = /`([^`]*)`/gu;
const STRIKE = /~~(?=\S)(.+?)(?<=\S)~~/gu;

const plainLabel = (label: string): string => {
  const plain = label
    .replaceAll(LINK, '$1')
    .replaceAll(CODE, '$1')
    .replaceAll(STRONG, '$2')
    .replaceAll(STRIKE, '$1')
    .replaceAll(EMPHASIS_STAR, '$1')
    .replaceAll(EMPHASIS_UNDERSCORE, '$1')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  return plain === '' ? label : plain;
};

const FENCE_LINE = /^\s*(?:```|~~~)/u;
const HEADING_MARK = /^\s{0,3}#{1,6}\s+/u;
const LIST_MARK = /^\s*(?:[-*+•]|\d+[.)])\s+/u;
const QUOTE_MARK = /^\s*>\s?/u;
const TABLE_RULE = /^\s*\|?[\s:|-]+\|?\s*$/u;

/**
 * A card's summary as ONE flat line for a row or a tile that clips it: the Markdown's marks (heading hashes, list
 * markers, quote bars, emphasis, code ticks, links) are dropped, the lines joined by a space, and a fenced block
 * or a table's rule line left out. The full text is drawn as Markdown on the card's own page; this is only the
 * preview in front of it. Pure.
 */
export const plainPreview = (text: string): string => {
  let fenced = false;
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    if (FENCE_LINE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || (raw.includes('-') && raw.includes('|') && TABLE_RULE.test(raw))) {
      if (fenced) lines.push(raw.trim());
      continue;
    }
    lines.push(raw.replace(HEADING_MARK, '').replace(QUOTE_MARK, '').replace(LIST_MARK, '').replaceAll('|', ' '));
  }
  return plainLabel(lines.join(' ').replaceAll(/\s+/gu, ' ').trim());
};
