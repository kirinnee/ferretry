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
 *   a throwaway value in no read of the page. The facts prove only a delivery Ferretry SUBMITS: one it does not
 *   submit sits on the page, which they never looked at, so it is held while the page shows that document instead,
 *   at most the full window (`until-moved-on`, {@link pageHistory}).
 * - What the ferret did is judged PER PAGE ({@link PageSteer}, login-observer.ts `pageSteer`): a script on this page
 *   or this site, or an act on this page (or on a tab sharing its storage on its site) since the card was raised.
 * - Every long lock says its own cause (`InputLockReason`), so the owner reads why.
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
 * What the saved logins' facts say about this very field (its place and identity):
 *
 * - `contrary`: some record says it was not masked, showed the value after a submit, or did not move on.
 * - `none`: no record says all three (masked, no echo after submit, moved on).
 * - `proven`: one does and none says otherwise, for a delivery Ferretry SUBMITS.
 * - `unsubmitted`: the facts hold, but Ferretry does not submit this one. They say what the page does AFTER a submit,
 *   never how it shows a value that sits in the field (secrev-1333 M1): only the dummy probe reads that, so the value
 *   is held while the page shows that document (`until-moved-on`).
 */
export function pageHistory(
  facts: InputTargetFacts,
  observed: readonly LoginObserved[],
  submitted: boolean,
): 'proven' | 'contrary' | 'none' | 'unsubmitted' {
  const place = placeOf(facts, undefined);
  if (place === undefined) return 'none';
  const identity = identityOf(facts, place);
  const here = observed.filter(seen => seen.at === place && seen.surface === 'page' && seen.identity === identity);
  const says = (seen: LoginObserved): readonly (boolean | undefined)[] => [
    seen.masked?.value,
    seen.noEchoAfterSubmit?.value,
    seen.navigatedAway?.value,
  ];
  if (here.some(seen => says(seen).includes(false))) return 'contrary';
  const held = here.filter(seen => says(seen).every(value => value === true));
  if (held.length === 0) return 'none';
  return submitted ? 'proven' : 'unsubmitted';
}

/** A saved login's facts prove this very field ({@link pageHistory}). */
export function provenByFacts(
  facts: InputTargetFacts,
  observed: readonly LoginObserved[],
  submitted: boolean,
): boolean {
  return pageHistory(facts, observed, submitted) === 'proven';
}

/**
 * The programs whose prompt is a local password read (getpass): echo off in line mode, nothing drawn. A relay (ssh,
 * docker, kubectl) or a readline program (psql, mysql) turns echo off and draws what is typed, so it is never one.
 */
export const GETPASS_PROGRAMS: ReadonlySet<string> = new Set(['sudo', 'sudoedit', 'su', 'doas', 'passwd']);

/**
 * The programs whose echo-off prompt may be a one-time code: remote shells and cloud CLIs that ask for a 2FA code. A
 * bare shell's `read -s` is never one, whatever its line says. Matched against the REAL executable a process runs, and
 * only one this account cannot replace (`CodeProgramPort`): a name in `ps` can be rewritten or copied.
 */
export const CODE_PROGRAMS: ReadonlySet<string> = new Set([
  'ssh',
  'scp',
  'sftp',
  'mosh-client',
  'aws',
  'gcloud',
  'az',
  'vault',
]);

/**
 * Text as it is matched: compatibility-normalised (NFKC), with combining marks and invisible format characters taken
 * out, so "pàss​word" or a fullwidth "ｐａｓｓｗｏｒｄ" reads "password". Applied to the pane's line and to the ferret's own words.
 */
export function matchable(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\p{Mn}\p{Me}\p{Cf}]/gu, '')
    .normalize('NFKC');
}

/**
 * Whether a word mixes ASCII letters with any other letter ("Pаssword" with a Cyrillic а, "Pɑssword", "ᴘᴀssword",
 * Armenian "Passwօrd"): a look-alike spelling, read as a password word. It can only make a code a secret, so a false
 * hit ("Straße") costs nothing but visibility.
 */
export function lookAlike(text: string): boolean {
  return matchable(text)
    .split(/[^\p{L}]+/u)
    .some(word => /[A-Za-z]/u.test(word) && /[^A-Za-z]/u.test(word));
}

/** A password word with its letters run together: what {@link spellsPassword} looks for once separators are gone. */
const RUN_TOGETHER = /pass(?:word|phrase|wd|wort)|kennwort|contrasena|motdepasse|credential/iu;

/**
 * Whether the text spells a password word with spaces, dots, dashes or underscores between its letters ("Pass-word",
 * "Pass word", "P a s s w o r d"). Long words only: a short one ("pin") would match across ordinary words.
 */
export function spellsPassword(text: string): boolean {
  return RUN_TOGETHER.test(matchable(text).replace(/[\s._-]+/gu, ''));
}

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
 * - A terminal reading with echo off, UNLESS its program is one that asks for 2FA codes (ssh, scp, sftp, mosh, the
 *   aws, gcloud, az and vault CLIs) AND the prompt line the daemon read from the pane asks for a code ("Verification
 *   code:", one-time, OTP, 2FA, authenticator, "code:") and says none of password, passphrase, PIN, token or secret.
 *   Whole words, any case. A bare ": " with echo off, or a shell's `read -s`, is a password.
 * - Every line and word is matched as {@link matchable} text, and a look-alike spelling ({@link lookAlike}) counts as a
 *   password word.
 */
export function passwordTarget(
  facts: InputTargetFacts,
  fieldId: string,
  /** The foreground runs a code program this account cannot replace (`CodeProgramPort`); never the name in ps. */
  codeProgram = false,
): boolean {
  // (The ferret's own words are checked in service.ts: they may only raise a code to a secret.)
  if (facts.kind === 'terminal') {
    const line = matchable(facts.promptLine);
    // A getpass NAME is enough here: faking one only makes the card stricter.
    if (
      GETPASS_PROGRAMS.has(facts.foreground.comm) ||
      (facts.program !== undefined && GETPASS_PROGRAMS.has(facts.program)) ||
      PASSWORD_PROMPT.test(line) ||
      spellsPassword(facts.promptLine) ||
      lookAlike(facts.promptLine)
    )
      return true;
    if (facts.echo !== 'off') return false;
    return !(codeProgram && CODE_PROMPT.test(line) && !NOT_A_CODE.test(line));
  }
  if (facts.kind !== 'browser') return false;
  const found = facts.fields.find(field => field.fieldId === fieldId);
  if (found === undefined) return false;
  return (
    found.field.type?.toLowerCase() === 'password' ||
    [found.field.name, found.field.id, found.field.autocomplete].some(
      word => word !== undefined && (PASSWORD_FIELD.test(matchable(word)) || spellsPassword(word) || lookAlike(word)),
    )
  );
}

/**
 * A terminal proven to hide typing: a local password prompt, from a setuid-root program the ferret could not have
 * placed. EVERY process of the foreground group runs setuid root and the kernel names the group's program a getpass one
 * (`program`, never `foreground.comm`, which a shell can rewrite to `sudo`). Anything less keeps the full lock.
 */
export function terminalHides(facts: InputTargetFacts): boolean {
  return (
    facts.kind === 'terminal' &&
    facts.echo === 'off' &&
    facts.canonical === true &&
    facts.trustedProgram === true &&
    facts.program !== undefined &&
    GETPASS_PROGRAMS.has(facts.program)
  );
}

/**
 * Why the ferret could have steered what a page shows (login-observer.ts `pageSteer`): a page script ran on this page
 * or its site (`scripted`), it acted on this page, or on a tab sharing its storage at its site, in the window asked
 * about (`acted`), or nothing can tell (`unknown`: no observer is wired).
 */
export type PageSteer = 'scripted' | 'acted' | 'unknown';

/** The full lock a steered page gets, with the reason the card says. */
export function steeredLock(steer: PageSteer): InputLock {
  return FULL(steer === 'scripted' ? 'scripted' : steer === 'acted' ? 'steered' : 'not-proven');
}

/** What else the decision needs: whether the value is submitted, and whether the ferret could have steered the page. */
export interface LockContext {
  /** Every saved login's observed facts. */
  readonly observed: readonly LoginObserved[];
  /** The saved logins could not be read: no facts are known, which is not the same as none. */
  readonly unread?: boolean;
  /** The daemon's dummy probe of this page found the throwaway value nowhere. */
  readonly probed: boolean;
  /** How the probe came out when it ran and did not find the value hidden: only what the card says. */
  readonly probe?: 'shown' | 'aborted';
  /** Enter is pressed after the value (or may be, on the card). */
  readonly submitted: boolean;
  /** Why the ferret could have steered this page ({@link PageSteer}); absent: it could not have. */
  readonly steered?: PageSteer;
}

/** The lock a delivery earns from what the daemon saw. Asked only of a card {@link heldFromView}. */
export function lockFor(
  facts: InputTargetFacts,
  fields: readonly InputRequestField[],
  context: LockContext,
): InputLock {
  if (fields.some(field => field.sensitivity === 'private')) return FULL('code');
  if (facts.kind === 'terminal') return terminalHides(facts) ? SHORT('hidden-terminal') : FULL('terminal-shows');
  if (facts.kind !== 'browser') return FULL('not-proven');
  if (context.steered !== undefined) return steeredLock(context.steered);
  if (!pageFieldsQualify(facts, fields)) return FULL('not-password-field');
  const history = pageHistory(facts, context.observed, context.submitted);
  if (history === 'proven') return SHORT('proven-field');
  if (context.probed) return SHORT('probed-field');
  if (context.unread === true) return FULL('not-proven');
  if (history === 'contrary') return FULL('did-not-move-on');
  if (history === 'unsubmitted') return FULL('until-moved-on');
  if (context.probe === 'shown') return FULL('probe-shown');
  if (context.probe === 'aborted') return FULL('probe-stopped');
  return FULL('first-time');
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
 * looks like a code or a PIN, and a page no script ran on, nor on its site (`steered`). A terminal is never probed.
 */
export function probeable(
  facts: InputTargetFacts,
  fields: readonly InputRequestField[],
  context: Omit<LockContext, 'probed'>,
): boolean {
  if (
    facts.kind !== 'browser' ||
    context.steered !== undefined ||
    fields.some(field => field.sensitivity === 'private' || field.sensitivity === 'code')
  )
    return false;
  const secret = fields.filter(field => field.sensitivity === 'secret').map(field => field.id);
  if (secret.length !== 1 || !pageFieldsQualify(facts, fields)) return false;
  if (provenByFacts(facts, context.observed, context.submitted)) return false;
  return facts.fields.filter(field => secret.includes(field.fieldId)).every(field => !CODE_LIKE(field.field));
}

/**
 * The longer of two locks: a card that said two minutes is never shortened at the write. Of two as long, the later
 * (`right`) is kept, so the reason is the one seen at the write.
 */
export function longerLock(left: InputLock, right: InputLock): InputLock {
  return right.seconds >= left.seconds ? right : left;
}
