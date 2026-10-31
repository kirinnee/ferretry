import type { InputTargetFacts } from '@ferretry/protocol';
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
 *   line and whether the program is one known to ask for a secret. Only the cursor row may change.
 * - the secret store: the same name. Whether it already holds a value may change; the card's risk says so.
 *
 * Keyed like every digest here (`digest.ts`): it is compared, never shown.
 */
export function bindingOf(facts: InputTargetFacts): string {
  if (facts.kind === 'browser')
    return digestValue({
      kind: facts.kind,
      pageId: facts.pageId,
      origin: facts.origin,
      secure: facts.secure,
      fields: facts.fields.map(field => ({
        fieldId: field.fieldId,
        frameOrigin: field.frameOrigin,
        field: field.field,
      })),
    });
  if (facts.kind === 'terminal')
    return digestValue({
      kind: facts.kind,
      paneProof: facts.paneProof,
      foreground: facts.foreground,
      echo: facts.echo,
      promptLineDigest: facts.promptLineDigest,
      recognisedConsumer: facts.recognisedConsumer,
    });
  return digestValue({ kind: facts.kind, name: facts.name });
}

/** What was seen now may take the card's place: the same binding, and on a page every field visible to the owner. */
export function mayRebind(binding: string, facts: InputTargetFacts): boolean {
  if (bindingOf(facts) !== binding) return false;
  return facts.kind !== 'browser' || facts.fields.every(field => field.visible);
}
