/**
 * THE PAYLOAD OF A `card` OR `board` BLOCK: references to board cards, read into a closed shape.
 *
 * These two types are the only `fy-render` blocks whose payload names something that LIVES — a card on
 * the board — rather than carrying bytes to draw. The payload is a reference (`&F12`), parsed by the
 * reference grammar's own token reader so there is no second spelling of a card id, and nothing else:
 * no title, no lane and no status is authored here, so a block can never say something the board does
 * not. What it shows is read from the board when it is drawn (`fy-render-embed.tsx`).
 *
 *   card    exactly one `&F12`
 *   board   a list of `&F12` `&F13` … (spaces or lines, an optional leading `- `), or `parent: &F12`
 *           alone, which shows that card's children grouped by lane
 */

import { FY_RENDER_LIMITS } from './fy-render-bounds.ts';
import { parseReferenceToken } from '@ferretry/app';

export type FyRenderEmbedSpec =
  | { readonly kind: 'card'; readonly id: string }
  | { readonly kind: 'cards'; readonly ids: readonly string[] }
  | { readonly kind: 'children'; readonly parent: string };

export type FyRenderEmbedParse =
  | { readonly ok: true; readonly spec: FyRenderEmbedSpec }
  | { readonly ok: false; readonly reason: string };

const PARENT_LINE = /^parent:\s*(\S+)$/u;
const LIST_MARK = /^-\s+/u;

const refuse = (reason: string): FyRenderEmbedParse => ({ ok: false, reason });

const cardId = (word: string): string | null => {
  const reference = parseReferenceToken(word);
  return reference?.kind === 'task' ? reference.id : null;
};

/** Every word of a payload, with list marks and blank lines dropped. */
const words = (payload: string): readonly string[] =>
  payload
    .split('\n')
    .map(line => line.trim().replace(LIST_MARK, ''))
    .filter(line => line !== '')
    .flatMap(line => line.split(/\s+/u));

export function parseFyRenderEmbed(type: 'card' | 'board', payload: string): FyRenderEmbedParse {
  if (new TextEncoder().encode(payload).length > FY_RENDER_LIMITS.embedBytes)
    return refuse('Card payload exceeds 2 KiB');
  const lines = payload
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
  if (lines.length === 0) return refuse(`A ${type} block needs a payload naming a card, such as &F12`);

  const parent = PARENT_LINE.exec(lines[0] ?? '');
  if (parent !== null) {
    if (type !== 'board') return refuse('Only a board block may name a parent');
    if (lines.length > 1) return refuse('A board names a parent or lists cards, never both');
    const id = cardId(parent[1] ?? '');
    return id === null
      ? refuse(`"${parent[1]}" is not a card reference`)
      : { ok: true, spec: { kind: 'children', parent: id } };
  }

  const ids: string[] = [];
  for (const word of words(payload)) {
    const id = cardId(word);
    if (id === null) return refuse(`"${word}" is not a card reference`);
    if (ids.includes(id)) return refuse(`${id} is listed twice`);
    ids.push(id);
  }
  if (type === 'card') {
    const [only] = ids;
    if (ids.length !== 1 || only === undefined) return refuse('A card block names exactly one card');
    return { ok: true, spec: { kind: 'card', id: only } };
  }
  if (ids.length > FY_RENDER_LIMITS.embedCards)
    return refuse(`A board lists at most ${FY_RENDER_LIMITS.embedCards} cards`);
  return { ok: true, spec: { kind: 'cards', ids } };
}
