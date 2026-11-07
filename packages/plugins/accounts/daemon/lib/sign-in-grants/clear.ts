import type { InputTargetFacts } from '@ferretry/protocol';

/**
 * EMPTYING A PASSWORD LEFT IN A FIELD (docs/input-requests.md, "Task plan fills"). A grant fill that typed a password
 * into a page asks, while the page is still held from the ferret, whether the field it typed into still holds ANYTHING:
 * same document, the node still connected, its value not empty. If it does, the field is emptied and the line stops
 * (`did-not-move-on`): the page didn't move on, so the sign-in didn't go as the owner approved it. `unknown` fails
 * closed the same way.
 *
 * Whatever the field holds, not only what was typed: a ferret that appends one character during the hold must not
 * keep the password in it. A single-page app that swapped the form has moved on once the node is gone. NOTHING about
 * the value is sent: only which nodes to look at, and the answer is one word.
 */

/** What came of the check: a field still held something and was emptied; nothing holds it; or it could not be told. */
export type ClearOutcome = 'cleared' | 'moved' | 'unknown';

/** One password field a fill typed into, by node. Never the value. */
export interface ClearField {
  readonly frameId: string;
  readonly backendNodeId: number;
}

/** What the browser is asked to check and empty before the hold ends. */
export interface ClearJob {
  /** The document the values went into: another one has moved on. */
  readonly navigationId: string;
  readonly fields: readonly ClearField[];
}

/** The clear job for the password fields of a page write: each typed `secret` field's node. `undefined` when there is none. */
export function clearJobOf(facts: InputTargetFacts, secretFields: readonly string[]): ClearJob | undefined {
  if (facts.kind !== 'browser') return undefined;
  const fields = facts.fields
    .filter(field => secretFields.includes(field.fieldId))
    .map(field => ({ frameId: field.frameId, backendNodeId: field.backendNodeId }));
  return fields.length === 0 ? undefined : { navigationId: facts.navigationId, fields };
}
