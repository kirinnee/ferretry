import type { InputTargetFacts } from '../../../contract/index.ts';
import { digestValue } from './digest.ts';

/**
 * WHEN A CHANGED TARGET IS STILL THE SAME TARGET (docs/input-requests.md, "When the target changes").
 *
 * The card binds to EVERYTHING the daemon saw (`digestFacts`), so any change at all refuses the write. Most
 * changes are not a different target: a 2FA page re-renders its code input as a new node, a countdown moves the
 * box, a toast covers it for a moment, a reload makes a new document; a terminal redraws the same password prompt
 * a row lower. For those the daemon looks again and REDRAWS the card — a new picture, digest and risk — and the
 * owner sends again. Nothing is typed by a re-bind: the owner always approves the target the value goes into.
 *
 * The BINDING is the part of the facts that names the target itself. Two sightings with the same binding are the
 * same target; anything outside it may change:
 *
 * - a page: the same page (its id), origin and transport security, and every field in the same order with the same
 *   frame origin, tag and attributes (`type`, `name`, `id`, `autocomplete`, `inputmode`) — so a password field that
 *   became a text field, a field that moved to another site's frame, or a page on another origin is never re-bound.
 *   Its node, frame id, box, cover, document and challenge may change. Every field must be visible.
 * - a terminal: the same pane, the same program (pid, process group, name and argv), the same echo, the same prompt
 *   line, the same PROVED program (or the same lack of one), whether every process of the group is one known to ask
 *   for a secret and whether every one runs setuid root. Only the cursor row may change.
 * - the secret store: the same name. Whether it already holds a value may change; the card's risk says so.
 *
 * Keyed like every digest here (`digest.ts`): it is compared, never shown.
 */
export function bindingOf(facts: InputTargetFacts): string {
  if (facts.kind === 'page')
    return digestValue({
      kind: facts.kind,
      pageId: facts.pageId,
      origin: facts.origin,
      secure: facts.secure,
      fields: facts.fields.map(field => ({
        fieldId: field.fieldId,
        frameOrigin: field.frameOrigin,
        field: withoutProofFacts(field.field),
      })),
    });
  if (facts.kind === 'terminal')
    return digestValue({
      kind: facts.kind,
      paneProof: facts.paneProof,
      foreground: facts.foreground,
      echo: facts.echo,
      promptLineDigest: facts.promptLineDigest,
      program: facts.program ?? null,
      recognisedConsumer: facts.recognisedConsumer,
      trustedProgram: facts.trustedProgram === true,
    });
  return digestValue({ kind: facts.kind, name: facts.name });
}

type FieldAttributes = Extract<InputTargetFacts, { readonly kind: 'page' }>['fields'][number]['field'];

/**
 * The attributes that NAME a field. Its label and its form (id, name, action) are what it is PROVED by (`replacedAsShown`)
 * and what the card classifies it by, not what names it: a change in them is a redraw for the owner, never a refusal.
 */
function withoutProofFacts(
  field: FieldAttributes,
): Omit<
  FieldAttributes,
  'label' | 'formId' | 'formName' | 'formAction' | 'formActionDigest' | 'formActionOriginDigest'
> {
  const {
    label: _label,
    formId: _id,
    formName: _name,
    formAction: _action,
    formActionDigest: _digest,
    formActionOriginDigest: _originDigest,
    ...named
  } = field;
  return named;
}

/** Where each field of a page sends what is typed, as an origin: what a card must say when it moved after the owner was asked. */
export function actionOriginsOf(facts: InputTargetFacts): string {
  if (facts.kind !== 'page') return '';
  return facts.fields
    .map(({ field }) => {
      if (field.formActionOriginDigest !== undefined) return field.formActionOriginDigest;
      try {
        return field.formAction === undefined ? '' : new URL(field.formAction).origin;
      } catch {
        return field.formAction ?? '';
      }
    })
    .join(' ');
}

/** Every fact of two fields' attributes agrees, one present on one side only included. */
function sameFieldFacts(left: FieldAttributes, right: FieldAttributes): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as (keyof FieldAttributes)[]);
  return [...keys].every(key => left[key] === right[key]);
}

/** What was seen now may take the card's place: the same binding, and on a page every field visible to the owner. */
export function mayRebind(binding: string, facts: InputTargetFacts): boolean {
  if (bindingOf(facts) !== binding) return false;
  return facts.kind !== 'page' || facts.fields.every(field => field.visible);
}

/** How far a field's box may have moved or grown, per axis in pixels, and still be the field the owner was shown. */
export const REPLACED_FIELD_TOLERANCE_PX = 32;

/**
 * Whether a page's field the card showed was re-rendered as ONE element that is provably the same field, so the value is
 * typed into it at once instead of the owner being asked to send again (a React-style page replaces its input as the
 * owner reads the card). It is the strictest reading of "the same target":
 *
 * - the SAME binding (`mayRebind`: page, origin, security, every field's frame origin, tag and attributes, all visible);
 * - the SAME document (a navigation makes another, however alike its fields look) and the same frame for every field;
 * - for every field the SAME DevTools frame and the SAME document in it (a field moved into a same-origin sibling frame, or
 *   a frame whose document was replaced, is another field), and nothing about it unreadable: a fact that was not read is
 *   never proved;
 * - every fact the browser read about the field the same: its attributes, its page label, the form that owns it and where
 *   that form sends what is typed (a form re-pointed at another action receives the value elsewhere);
 * - no challenge that was not there before, and no field that is covered now but was not;
 * - every field NEAR where it was: its box's origin and its size each within {@link REPLACED_FIELD_TOLERANCE_PX}.
 *
 * Look-alikes never get here: the browser's re-find marks them `ambiguous`, which the caller redraws and never types.
 * Anything this refuses is redrawn for the owner, so a wrong guess costs a second send and never a value in the wrong element.
 */
export function replacedAsShown(binding: string, shown: InputTargetFacts | undefined, now: InputTargetFacts): boolean {
  if (shown?.kind !== 'page' || now.kind !== 'page' || !mayRebind(binding, now)) return false;
  if (shown.pageId !== now.pageId || shown.navigationId !== now.navigationId) return false;
  if (JSON.stringify(shown.challenge ?? null) !== JSON.stringify(now.challenge ?? null)) return false;
  if (shown.fields.length !== now.fields.length) return false;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= REPLACED_FIELD_TOLERANCE_PX;
  return shown.fields.every((field, index) => {
    const next = now.fields[index];
    return (
      next !== undefined &&
      next.fieldId === field.fieldId &&
      next.frameId === field.frameId &&
      field.ownerFrame !== undefined &&
      field.ownerLoader !== undefined &&
      next.ownerFrame === field.ownerFrame &&
      next.ownerLoader === field.ownerLoader &&
      field.unread !== true &&
      next.unread !== true &&
      sameFieldFacts(field.field, next.field) &&
      (next.covered !== true || field.covered === true) &&
      near(next.box.x, field.box.x) &&
      near(next.box.y, field.box.y) &&
      near(next.box.w, field.box.w) &&
      near(next.box.h, field.box.h)
    );
  });
}
