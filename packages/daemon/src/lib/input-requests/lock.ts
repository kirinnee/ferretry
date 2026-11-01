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
 * - A TERMINAL is proven only for a local password prompt: echo off in line (canonical) mode, a getpass program
 *   (sudo, su, doas, passwd) running setuid root, which a script or binary the ferret wrote cannot.
 * - A PAGE is proven only when every secret field is a password input on a secure page with no human check showing,
 *   in its own frame's origin, visible and uncovered, AND either a saved login's observed facts for that very field
 *   identity say it hid the value after submit and the page moved on, or the daemon's own dummy probe at raise found
 *   a throwaway value in no read of the page.
 * - A `private` value shows as it is typed: never short.
 * - A `plain` value and a one-time `code` are not held at all ({@link heldFromView}): the ferret may see both, so a
 *   lock would hide nothing it is not allowed to read. A card with a `code` beside a `secret` is locked for the
 *   secret alone, by the rules above.
 */

const SHORT = (reason: InputLock['reason']): InputLock => ({ seconds: INPUT_SHORT_LOCK_SECONDS, reason });
/** A field the target is kept from the ferret for: a `secret` or a `private` value. */
const HELD = (field: Pick<InputRequestField, 'sensitivity'>): boolean =>
  field.sensitivity === 'secret' || field.sensitivity === 'private';

/**
 * Whether a card's target is kept from the ferret after the write at all: only for a `secret` or a `private` value.
 * A card of `plain` values and one-time `code`s gets no lock, no quarantine and no page hold.
 */
export function heldFromView(fields: readonly Pick<InputRequestField, 'sensitivity'>[]): boolean {
  return fields.some(HELD);
}
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

/**
 * A saved login's facts prove this very field hid the value after a submit and the page moved on: at least one record
 * for this place and field identity says all three, and NONE says the other way. Only for a delivery that is
 * submitted: the facts are about what happens after a submit.
 */
export function provenByFacts(
  facts: InputTargetFacts,
  observed: readonly LoginObserved[],
  submitted: boolean,
): boolean {
  if (!submitted) return false;
  const place = placeOf(facts, undefined);
  if (place === undefined) return false;
  const identity = identityOf(facts, place);
  const here = observed.filter(seen => seen.at === place && seen.surface === 'page' && seen.identity === identity);
  const says = (seen: LoginObserved): readonly (boolean | undefined)[] => [
    seen.masked?.value,
    seen.noEchoAfterSubmit?.value,
    seen.navigatedAway?.value,
  ];
  return here.some(seen => says(seen).every(value => value === true)) && !here.some(seen => says(seen).includes(false));
}

/**
 * The programs whose prompt is a local password read (getpass): echo off in line mode, nothing drawn. A relay (ssh,
 * docker, kubectl) or a readline program (psql, mysql) turns echo off and draws what is typed, so it is never one.
 */
const GETPASS_PROGRAMS: ReadonlySet<string> = new Set(['sudo', 'sudoedit', 'su', 'doas', 'passwd']);

/** A prompt line asking for a one-time code, in the words the pane shows (never the ferret's). */
const CODE_PROMPT = /\b(?:verification\s+code|one[\s-]?time|otp|2fa|authenticator)\b|\bcode\s*:/iu;
/**
 * A prompt line that asks for a password, in any of the ways a pane or a fake one says it: always a secret. Ferretry
 * may over-read (a "secret" prompt): the ferret's word "code" may only ever be raised to a secret, never lowered.
 */
const PASSWORD_PROMPT =
  /pass(?:word|phrase|wd|wort)|kennwort|contrase(?:ñ|n)a|mot de passe|credential|secret|\bpw\s*:|\bpin\b/iu;
/** A page field whose name, id or autocomplete says password (or PIN), whatever its type. */
const PASSWORD_FIELD = /pass|pwd|(?:^|[^a-z])pin(?:[^a-z]|$)/iu;
/** Words that make a prompt line something other than a one-time code, whatever else it says. */
const NOT_A_CODE = /\b(?:password|passphrase|pin|token|secret)\b/iu;

/**
 * Whether the DAEMON saw a password where a field goes. A one-time `code` aimed at one is handled as a `secret`
 * (service.ts, `observedAs`): the ferret's word "code" never makes a password visible to it.
 *
 * - A page field that is `type=password`, or whose name, id or autocomplete says pass, pwd or PIN (any type).
 * - A terminal running a getpass program (sudo, sudoedit, su, doas, passwd), or whose prompt line asks for a password
 *   (password, passphrase, passwd, Passwort, Kennwort, contraseña, mot de passe, credential, secret, "pw:", PIN):
 *   always, whatever else the line says.
 * - A terminal reading with echo off, UNLESS the prompt line the daemon read from the pane asks for a code
 *   ("Verification code:", one-time, OTP, 2FA, authenticator, "code:") and says none of password, passphrase, PIN,
 *   token or secret. Whole words, any case. A bare ": " with echo off is a password.
 */
export function passwordTarget(facts: InputTargetFacts, fieldId: string): boolean {
  // (The ferret's own words are checked in service.ts: they may only raise a code to a secret.)
  if (facts.kind === 'terminal') {
    const line = facts.promptLine;
    if (GETPASS_PROGRAMS.has(facts.foreground.comm) || PASSWORD_PROMPT.test(line)) return true;
    if (facts.echo !== 'off') return false;
    return !(CODE_PROMPT.test(line) && !NOT_A_CODE.test(line));
  }
  if (facts.kind !== 'browser') return false;
  const found = facts.fields.find(field => field.fieldId === fieldId);
  if (found === undefined) return false;
  return (
    found.field.type?.toLowerCase() === 'password' ||
    [found.field.name, found.field.id, found.field.autocomplete].some(
      word => word !== undefined && PASSWORD_FIELD.test(word),
    )
  );
}

/** A terminal proven to hide typing: a local password prompt, from a setuid-root program the ferret could not have placed. */
export function terminalHides(facts: InputTargetFacts): boolean {
  return (
    facts.kind === 'terminal' &&
    facts.echo === 'off' &&
    facts.canonical === true &&
    facts.trustedProgram === true &&
    GETPASS_PROGRAMS.has(facts.foreground.comm)
  );
}

/** What else the decision needs: whether the value is submitted, and whether the ferret could have steered the page. */
export interface LockContext {
  /** Every saved login's observed facts. */
  readonly observed: readonly LoginObserved[];
  /** The daemon's dummy probe of this page found the throwaway value nowhere. */
  readonly probed: boolean;
  /** Enter is pressed after the value (or may be, on the card). */
  readonly submitted: boolean;
  /** The ferret ran a page script in this session, or acted on a page since the card was raised. */
  readonly steered: boolean;
}

/** The lock a delivery earns from what the daemon saw. Asked only of a card {@link heldFromView}. */
export function lockFor(
  facts: InputTargetFacts,
  fields: readonly InputRequestField[],
  context: LockContext,
): InputLock {
  if (fields.some(field => field.sensitivity === 'private')) return FULL('code');
  if (facts.kind === 'terminal') return terminalHides(facts) ? SHORT('hidden-terminal') : FULL('not-proven');
  if (context.steered || !pageFieldsQualify(facts, fields)) return FULL('not-proven');
  if (provenByFacts(facts, context.observed, context.submitted)) return SHORT('proven-field');
  return context.probed ? SHORT('probed-field') : FULL('not-proven');
}

/**
 * Attributes that say a field takes a code or a PIN, where a wrong attempt can count: never probed. The agent picks a
 * field's sensitivity, so a `type=password` PIN it called `secret` is caught here, by what the page says it is.
 */
const CODE_WORDS = /otp|totp|mfa|2fa|pin|passcode|one.?time|verif|code|cvv|cvc|token|security/iu;
const CODE_LIKE = (field: {
  readonly autocomplete?: string;
  readonly inputmode?: string;
  readonly name?: string;
  readonly id?: string;
}): boolean =>
  /^(?:numeric|tel|decimal)$/iu.test(field.inputmode ?? '') ||
  [field.autocomplete, field.name, field.id].some(word => word !== undefined && CODE_WORDS.test(word));

/**
 * Whether the daemon may run its dummy probe on a page card: exactly ONE secret field (typing into a second would blur
 * the first while it holds the test value), qualifying, not already proven, no `private` value or one-time `code` on
 * the card (a code field beside the password is typed in the same write, and a wrong code can count), nothing that
 * looks like a code or a PIN, and a session whose ferret never ran a page script. A terminal is never probed.
 */
export function probeable(
  facts: InputTargetFacts,
  fields: readonly InputRequestField[],
  context: Omit<LockContext, 'probed'>,
): boolean {
  if (
    facts.kind !== 'browser' ||
    context.steered ||
    fields.some(field => field.sensitivity === 'private' || field.sensitivity === 'code')
  )
    return false;
  const secret = fields.filter(field => field.sensitivity === 'secret').map(field => field.id);
  if (secret.length !== 1 || !pageFieldsQualify(facts, fields)) return false;
  if (provenByFacts(facts, context.observed, context.submitted)) return false;
  return facts.fields.filter(field => secret.includes(field.fieldId)).every(field => !CODE_LIKE(field.field));
}

/** The longer of two locks: a card that said two minutes is never shortened at the write. */
export function longerLock(left: InputLock, right: InputLock): InputLock {
  return right.seconds > left.seconds ? right : left;
}
