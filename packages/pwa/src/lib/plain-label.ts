/**
 * A card's summary as plain words. An option's label is read as plain words by `plainLabel` in `@ferretry/protocol`,
 * which the buttons, the deck's arrow keys and the CLI share; this is the summary's flattened preview. Pure.
 */

import { plainLabel } from '@ferretry/protocol';

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
