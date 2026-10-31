import {
  INPUT_QUARANTINE_SECONDS,
  INPUT_SHORT_LOCK_SECONDS,
  type InputLock,
  type InputRequestField,
  type InputTargetFacts,
  type LoginObserved,
} from '@ferretry/protocol';
import { identityOf, placeOf } from './login-observer.ts';

/**
 * HOW LONG THE LOCK LASTS (docs/input-requests.md, "How long the lock lasts"; the owner chose ADAPTIVE, !A149).
 *
 * After a value is typed, the target is kept from the ferret (the quarantine). It is SHORT ({@link
 * INPUT_SHORT_LOCK_SECONDS}) only when the daemon has PROVEN the target does not show what is typed, and the full
 * {@link INPUT_QUARANTINE_SECONDS} otherwise. Masking keeps its whole redaction window either way, and the owner can
 * still end a lock early or reveal. Nothing the agent says is an input to this: only facts the daemon observed.
 *
 * - A TERMINAL is proven when it has echo off and a recognised program is reading it (the facts on the card).
 * - A PAGE is proven only when every secret field is a password input on a secure page with no human check showing,
 *   in its own frame's origin, visible and uncovered, AND either a saved login's observed facts for that very field
 *   identity say it hid the value after submit and the page moved on, or the daemon's own dummy probe at raise found
 *   a throwaway value in no read of the page.
 * - A one-time code (`private`) shows as it is typed: never short. A `plain` value is not held at all.
 */

const SHORT = (reason: InputLock['reason']): InputLock => ({ seconds: INPUT_SHORT_LOCK_SECONDS, reason });
const FULL = (reason: InputLock['reason']): InputLock => ({ seconds: INPUT_QUARANTINE_SECONDS, reason });

/** Every secret field of a page goes into a password input the card would flag green. */
export function pageFieldsQualify(facts: InputTargetFacts, fields: readonly InputRequestField[]): boolean {
  if (facts.kind !== 'browser' || !facts.secure || facts.challenge !== undefined) return false;
  const secret = fields.filter(field => field.sensitivity === 'secret').map(field => field.id);
  const typed = facts.fields.filter(field => secret.includes(field.fieldId));
  return (
    typed.length > 0 &&
    typed.length === secret.length &&
    typed.every(
      field =>
        field.field.tag === 'input' &&
        field.field.type === 'password' &&
        field.frameOrigin === facts.origin &&
        field.visible &&
        field.covered !== true,
    )
  );
}

/** A saved login's facts prove this very field hid the value after submit and the page moved on. */
export function provenByFacts(facts: InputTargetFacts, observed: readonly LoginObserved[]): boolean {
  const place = placeOf(facts, undefined);
  if (place === undefined) return false;
  const identity = identityOf(facts, place);
  return observed.some(
    seen =>
      seen.at === place &&
      seen.surface === 'page' &&
      seen.identity === identity &&
      seen.masked?.value === true &&
      seen.noEchoAfterSubmit?.value === true &&
      seen.navigatedAway?.value === true,
  );
}

/**
 * The lock a delivery earns from what the daemon saw. `observed` is every saved login's facts; `probed` says the
 * daemon's own dummy probe of this page found the throwaway value nowhere.
 */
export function lockFor(
  facts: InputTargetFacts,
  fields: readonly InputRequestField[],
  observed: readonly LoginObserved[],
  probed: boolean,
): InputLock {
  if (fields.some(field => field.sensitivity === 'private')) return FULL('code');
  if (facts.kind === 'terminal')
    return facts.echo === 'off' && facts.recognisedConsumer ? SHORT('hidden-terminal') : FULL('not-proven');
  if (!pageFieldsQualify(facts, fields)) return FULL('not-proven');
  if (provenByFacts(facts, observed)) return SHORT('proven-field');
  return probed ? SHORT('probed-field') : FULL('not-proven');
}

/** autocomplete or inputmode that says a field takes a one-time code: never probed (a wrong code can count). */
const CODE_LIKE = (field: { readonly autocomplete?: string; readonly inputmode?: string }): boolean =>
  /one-time-code/iu.test(field.autocomplete ?? '') || /^(?:numeric|tel|decimal)$/iu.test(field.inputmode ?? '');

/**
 * Whether the daemon may run its dummy probe on a page card: only a page whose secret fields all qualify, not already
 * proven by a saved login's facts, with no one-time code on the card and no field that looks like one. A terminal is
 * never probed: a wrong password there can lock an account.
 */
export function probeable(
  facts: InputTargetFacts,
  fields: readonly InputRequestField[],
  observed: readonly LoginObserved[],
): boolean {
  if (facts.kind !== 'browser' || fields.some(field => field.sensitivity === 'private')) return false;
  if (!pageFieldsQualify(facts, fields) || provenByFacts(facts, observed)) return false;
  const secret = new Set(fields.filter(field => field.sensitivity === 'secret').map(field => field.id));
  return facts.fields.filter(field => secret.has(field.fieldId)).every(field => !CODE_LIKE(field.field));
}

/** The longer of two locks: a card that said two minutes is never shortened at the write. */
export function longerLock(left: InputLock, right: InputLock): InputLock {
  return right.seconds > left.seconds ? right : left;
}
