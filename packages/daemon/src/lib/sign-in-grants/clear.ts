import { createHash, randomBytes } from 'node:crypto';
import type { InputTargetFacts } from '@ferretry/protocol';

/**
 * EMPTYING A PASSWORD LEFT IN A FIELD (docs/input-requests.md, "Task plan fills"). A grant fill that typed a password
 * into a page asks, when the page hold ends, whether the password is STILL sitting in the field it went into: same
 * document, node still there, value unchanged. If it is, the field is emptied and the line stops (`did-not-move-on`):
 * the page didn't move on, so the sign-in didn't go as the owner approved it. `unknown` fails closed the same way.
 *
 * The test is value-based, not navigation-based: a single-page app that swaps the form without a new document has moved
 * on once the field no longer holds the value.
 *
 * THE VALUE IS NOT KEPT FOR THE CHECK. The daemon keeps only a salted SHA-256 of what it typed, made at the write; the
 * browser hashes the field's value with the same salt in an isolated world and compares there. The answer is one word,
 * so nothing about the value comes back.
 */

/** What came of the check: the field still held the value and was emptied; nothing holds it; or it could not be told. */
export type ClearOutcome = 'cleared' | 'moved' | 'unknown';

/** One password field a fill typed into, and a salted hash of what it typed. Never the value. */
export interface ClearField {
  readonly frameId: string;
  readonly backendNodeId: number;
  /** 32 hex characters, random per field. */
  readonly salt: string;
  /** `sha256hex(salt + value)`, UTF-8. */
  readonly digest: string;
}

/** What the browser is asked to check and empty when the hold ends. */
export interface ClearJob {
  /** The document the values went into: another one has moved on. */
  readonly navigationId: string;
  readonly fields: readonly ClearField[];
}

/** The salted hash a field's value is checked against. Exported for the browser side's own test. */
export const clearDigest = (salt: string, value: string): string =>
  createHash('sha256').update(`${salt}${value}`, 'utf8').digest('hex');

/**
 * The clear job for the password fields of a page write: each typed `secret` field's node and a salted hash of its
 * value. `undefined` when it is not a page, or no password was typed.
 */
export function clearJobOf(
  facts: InputTargetFacts,
  typed: readonly { readonly field: string; readonly text: string; readonly secret: boolean }[],
  salt: () => string = () => randomBytes(16).toString('hex'),
): ClearJob | undefined {
  if (facts.kind !== 'browser') return undefined;
  const fields: ClearField[] = [];
  for (const each of typed) {
    if (!each.secret) continue;
    const found = facts.fields.find(field => field.fieldId === each.field);
    if (found === undefined) continue;
    const pepper = salt();
    fields.push({
      frameId: found.frameId,
      backendNodeId: found.backendNodeId,
      salt: pepper,
      digest: clearDigest(pepper, each.text),
    });
  }
  return fields.length === 0 ? undefined : { navigationId: facts.navigationId, fields };
}
