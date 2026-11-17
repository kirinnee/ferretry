/**
 * WHERE EACH FIELD SITS ON THE PAGE PICTURE: the boxes the card outlines on the daemon's picture of a page request
 * (`GET …/shot`), as pure arithmetic over facts the DAEMON observed.
 *
 * The boxes are the browser's, read by field id from `request.observed`; nothing here comes from the ferret's words, and
 * no value is involved.
 */
import type { InputRequest, InputShot } from '../../contract/index.ts';
import type { InputCardField } from './input-card.ts';

/** One field's box on the picture, as percentages of the picture's width and height. */
export interface ShotBox {
  readonly key: string;
  readonly label: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const clamp = (value: number): number => Math.min(100, Math.max(0, value));

/**
 * Where each field the daemon found sits on the picture of the page: its box, relative to the part of the page the
 * picture shows (`clip`), clamped to 0–100 %. A field the daemon did not find, with no size, or wholly outside the
 * picture gets no box, and a card whose target is not a page gets none at all.
 */
export const shotBoxes = (request: InputRequest, fields: readonly InputCardField[], shot: InputShot): ShotBox[] => {
  const facts = request.observed;
  if (facts?.kind !== 'page' || !(shot.clip.w > 0) || !(shot.clip.h > 0)) return [];
  const boxes: ShotBox[] = [];
  for (const field of fields) {
    const seen = facts.fields.find(each => each.fieldId === field.key);
    if (seen === undefined || !(seen.box.w > 0) || !(seen.box.h > 0)) continue;
    const left = clamp(((seen.box.x - shot.clip.x) / shot.clip.w) * 100);
    const top = clamp(((seen.box.y - shot.clip.y) / shot.clip.h) * 100);
    const right = clamp(((seen.box.x + seen.box.w - shot.clip.x) / shot.clip.w) * 100);
    const bottom = clamp(((seen.box.y + seen.box.h - shot.clip.y) / shot.clip.h) * 100);
    if (right <= left || bottom <= top) continue;
    boxes.push({ key: field.key, label: field.label, left, top, width: right - left, height: bottom - top });
  }
  return boxes;
};
