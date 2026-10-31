import { describe, it } from 'bun:test';
import type { InputRequestField, InputTargetFacts, LoginObserved } from '@ferretry/protocol';
import should from 'should';
import {
  heldFromView,
  type LockContext,
  lockFor,
  longerLock,
  lookAlike,
  matchable,
  passwordTarget,
  pageFieldsQualify,
  probeable,
  provenByFacts,
  terminalHides,
} from '../../../src/lib/input-requests/lock.ts';
import { identityOf } from '../../../src/lib/input-requests/login-observer.ts';

/** How long the target is kept from the ferret after the write (!A149): only what the daemon saw decides. */

const ORIGIN = 'https://accounts.example.test';
type PageField = Extract<InputTargetFacts, { kind: 'browser' }>['fields'][number];

const pageField = (extra: Partial<PageField> = {}, attributes: Partial<PageField['field']> = {}): PageField => ({
  fieldId: 'password',
  frameOrigin: ORIGIN,
  frameId: 'f',
  backendNodeId: 1,
  field: { tag: 'input', type: 'password', name: 'Passwd', ...attributes },
  box: { x: 0, y: 0, w: 10, h: 10 },
  visible: true,
  ...extra,
});

const page = (fields: PageField[] = [pageField()], extra: Partial<InputTargetFacts> = {}): InputTargetFacts =>
  ({
    kind: 'browser',
    pageId: 'p',
    origin: ORIGIN,
    secure: true,
    navigationId: 'n',
    fields,
    ...extra,
  }) as InputTargetFacts;

/** A local sudo prompt, as the daemon sees it when it hides typing. */
const sudo = (
  extra: Partial<Extract<InputTargetFacts, { kind: 'terminal' }>> = {},
  comm = 'sudo',
): InputTargetFacts => ({
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 1 },
  foreground: { pid: 2, pgid: 2, comm, argv: `${comm} -v` },
  echo: 'off',
  cursorRow: 0,
  promptLine: '',
  promptLineDigest: 'a'.repeat(64),
  recognisedConsumer: true,
  canonical: true,
  trustedProgram: true,
  ...extra,
});

const field = (id: string, sensitivity: InputRequestField['sensitivity']): InputRequestField =>
  ({ id, sensitivity }) as unknown as InputRequestField;
const SECRET = [field('password', 'secret')];
const flag = (value = true) => ({ value, observedAt: '2026-10-31T09:00:00.000Z', count: 2 });
const QUIET: LockContext = { observed: [], probed: false, submitted: true, steered: false };

const proven = (facts: InputTargetFacts, extra: Partial<LoginObserved> = {}): LoginObserved => ({
  at: 'accounts.example.test',
  surface: 'page',
  identity: identityOf(facts, 'accounts.example.test') as string,
  since: '2026-10-31T09:00:00.000Z',
  masked: flag(),
  noEchoAfterSubmit: flag(),
  navigatedAway: flag(),
  ...extra,
});

describe('a terminal', () => {
  it('should be short only for a local password prompt from a root-owned password program', () => {
    should(lockFor(sudo(), SECRET, QUIET)).deepEqual({ seconds: 10, reason: 'hidden-terminal' });
    for (const comm of ['su', 'doas', 'passwd', 'sudoedit']) should(terminalHides(sudo({}, comm))).be.true();
  });

  it('should be long for raw or readline mode, an echoing or unread tty, a relay, or a program anyone could place', () => {
    for (const facts of [
      sudo({ canonical: false }),
      sudo({ canonical: undefined }),
      sudo({ echo: 'on' }),
      sudo({ echo: 'unknown' }),
      sudo({ trustedProgram: undefined }),
      sudo({}, 'ssh'),
      sudo({}, 'docker'),
      sudo({}, 'psql'),
      sudo({}, 'gpg'),
    ])
      should(lockFor(facts, SECRET, QUIET)).deepEqual({ seconds: 120, reason: 'not-proven' });
    should(terminalHides(page())).be.false();
  });
});

describe('a one-time code', () => {
  it('should be long wherever it goes', () => {
    should(lockFor(sudo(), [field('code', 'private')], QUIET).reason).equal('code');
    should(
      lockFor(page(), [...SECRET, field('code', 'private')], { ...QUIET, observed: [proven(page())], probed: true })
        .seconds,
    ).equal(120);
  });
});

describe('a page field', () => {
  it('should be short when a saved login proves that very field, for a submitted value', () => {
    const facts = page();
    should(lockFor(facts, SECRET, { ...QUIET, observed: [proven(facts)] })).deepEqual({
      seconds: 10,
      reason: 'proven-field',
    });
    should(provenByFacts(facts, [proven(facts)], false)).be.false();
  });

  it('should not be proven by a record that says otherwise, a partial record, or another place or field', () => {
    const facts = page();
    should(provenByFacts(facts, [proven(facts), proven(facts, { noEchoAfterSubmit: flag(false) })], true)).be.false();
    should(provenByFacts(facts, [proven(facts, { navigatedAway: undefined })], true)).be.false();
    should(provenByFacts(facts, [proven(facts, { surface: 'terminal' })], true)).be.false();
    should(provenByFacts(facts, [proven(facts, { at: 'other.example.test' })], true)).be.false();
    should(provenByFacts(page([pageField({}, { name: 'pass2' })]), [proven(facts)], true)).be.false();
    should(provenByFacts({ ...facts, origin: 'null' } as InputTargetFacts, [proven(facts)], true)).be.false();
  });

  it('should be short for a clean probe, and long when it did not run cleanly', () => {
    should(lockFor(page(), SECRET, { ...QUIET, probed: true })).deepEqual({ seconds: 10, reason: 'probed-field' });
    should(lockFor(page(), SECRET, QUIET)).deepEqual({ seconds: 120, reason: 'not-proven' });
  });

  it('should be long, whatever proves it, when the ferret could have steered the page', () => {
    const facts = page();
    should(lockFor(facts, SECRET, { ...QUIET, observed: [proven(facts)], probed: true, steered: true }).seconds).equal(
      120,
    );
  });

  it('should be long for any page field the card would not draw green', () => {
    const cases: InputTargetFacts[] = [
      page([pageField({}, { type: 'text' })]),
      page([pageField({}, { tag: 'textarea' })]),
      page([pageField({ frameOrigin: 'https://evil.test' })]),
      page([pageField({ visible: false })]),
      page([pageField({ covered: true })]),
      page(undefined, { secure: false } as never),
      page(undefined, { challenge: { provider: 'recaptcha' } } as never),
      page([pageField({ fieldId: 'other' })]),
    ];
    for (const facts of cases) {
      should(pageFieldsQualify(facts, SECRET)).be.false();
      should(lockFor(facts, SECRET, { ...QUIET, observed: [proven(facts)], probed: true }).seconds).equal(120);
    }
    should(pageFieldsQualify(sudo(), SECRET)).be.false();
  });

  it('should keep the longer of two locks', () => {
    const short = { seconds: 10, reason: 'probed-field' } as const;
    const long = { seconds: 120, reason: 'not-proven' } as const;
    should(longerLock(short, long)).equal(long);
    should(longerLock(long, short)).equal(long);
  });
});

describe('when the dummy probe may run', () => {
  it('should run only on one qualifying password field not already proven, in a session that ran no page script', () => {
    should(probeable(page(), SECRET, QUIET)).be.true();
    should(probeable(page(), SECRET, { ...QUIET, observed: [proven(page())] })).be.false();
    should(probeable(page(), SECRET, { ...QUIET, steered: true })).be.false();
    should(probeable(sudo(), SECRET, QUIET)).be.false();
    should(probeable(page([pageField({}, { type: 'text' })]), SECRET, QUIET)).be.false();
    const two = page([pageField(), pageField({ fieldId: 'confirm', backendNodeId: 2 }, { name: 'confirm' })]);
    should(probeable(two, [...SECRET, field('confirm', 'secret')], QUIET)).be.false();
  });

  it('should never run on a card with a one-time code, or on a field that says it takes a code or a PIN', () => {
    should(probeable(page(), [...SECRET, field('code', 'private')], QUIET)).be.false();
    for (const attributes of [
      { autocomplete: 'one-time-code' },
      { inputmode: 'numeric' },
      { inputmode: 'tel' },
      { inputmode: 'decimal' },
      { name: 'pin' },
      { name: 'otp_code' },
      { id: 'mfa-input' },
      { name: 'verificationCode' },
      { id: 'cvv' },
      { autocomplete: 'cc-csc', name: 'security' },
    ])
      should(probeable(page([pageField({}, attributes)]), SECRET, QUIET)).be.false();
    should(
      probeable(page([pageField({}, { autocomplete: 'current-password', inputmode: 'text' })]), SECRET, QUIET),
    ).be.true();
  });
});

describe('a one-time code (`code`)', () => {
  const CODE = [field('code', 'code')];

  it('should hold nothing for a card of codes and plain values, and hold a private value or a secret', () => {
    // Act / Assert — the ferret may see a code, so no lock would hide anything it is not allowed to read.
    should(heldFromView(CODE)).be.false();
    should(heldFromView([field('email', 'plain'), field('code', 'code')])).be.false();
    should(heldFromView([field('code', 'private')])).be.true();
    should(heldFromView([field('password', 'secret'), field('code', 'code')])).be.true();
  });

  it('should lock a password beside a code by the password alone, and still never probe such a card', () => {
    // Arrange — a sign-in page with a password and a code field, the password proven by a saved login's facts.
    const facts = page([pageField(), pageField({ fieldId: 'code' }, { type: 'text', name: 'otp' })]);
    const fields = [field('password', 'secret'), field('code', 'code')];
    const observed = [proven(facts)];

    // Act / Assert
    should(lockFor(facts, fields, { ...QUIET, observed })).deepEqual({ seconds: 10, reason: 'proven-field' });
    should(lockFor(facts, fields, QUIET)).deepEqual({ seconds: 120, reason: 'not-proven' });
    should(probeable(facts, fields, QUIET)).be.false();
    // A private value on the card keeps today's full lock, as before.
    should(lockFor(facts, [field('password', 'secret'), field('code', 'private')], { ...QUIET, observed })).deepEqual({
      seconds: 120,
      reason: 'code',
    });
  });
});

describe('a password target (a `code` aimed at one is handled as a secret)', () => {
  it('should see a password field by its type or its autocomplete, and not a code field', () => {
    // Act / Assert
    should(passwordTarget(page(), 'password')).be.true();
    should(
      passwordTarget(page([pageField({}, { type: 'text', autocomplete: 'current-password' })]), 'password'),
    ).be.true();
    should(
      passwordTarget(page([pageField({}, { type: 'text', autocomplete: 'section-a new-password' })]), 'password'),
    ).be.true();
    should(
      passwordTarget(page([pageField({}, { type: 'text', name: 'otp', autocomplete: 'one-time-code' })]), 'password'),
    ).be.false();
    should(passwordTarget(page(), 'missing')).be.false();
    // A text field named or id'd for a password or PIN is one, whatever its type.
    for (const attributes of [{ name: 'password' }, { name: 'user_pwd' }, { id: 'passwd' }, { name: 'card-pin' }])
      should(
        passwordTarget(page([pageField({}, { type: 'text', name: undefined, ...attributes })]), 'password'),
      ).be.true();
    should(passwordTarget(page([pageField({}, { type: 'text', name: 'shipping', id: 'otp' })]), 'password')).be.false();
  });

  it('should see a password prompt by its program, hidden typing or wording, and not an echoing code prompt', () => {
    // Arrange
    const otp = sudo({ echo: 'on', promptLine: 'Verification code:' }, 'ssh');

    // Act / Assert
    should(passwordTarget(sudo(), 'value')).be.true();
    should(passwordTarget(sudo({ echo: 'on', promptLine: '[sudo] password for kirin:' }, 'bash'), 'value')).be.true();
    should(passwordTarget(otp, 'value')).be.false();
  });

  it('should keep an echo-off prompt a code only when the pane asks for a code and names nothing secret', () => {
    // Arrange — ssh's keyboard-interactive prompts, typing hidden.
    const hidden = (promptLine: string, comm = 'ssh') =>
      passwordTarget(sudo({ echo: 'off', promptLine }, comm), 'value');

    // Act / Assert — a code prompt stays a code.
    for (const line of ['Verification code:', 'Enter your one-time code:', 'Authenticator CODE:', '2FA: ', 'code:'])
      should(hidden(line)).be.false();
    // Anything else with typing hidden is a password.
    for (const line of [
      'Password:',
      'Enter PIN:',
      "Enter passphrase for key '/home/k/.ssh/id_ed25519':",
      ': ',
      'OTP token:',
    ])
      should(hidden(line)).be.true();
    // A prompt that asks for a password in other words is one, typing shown or not.
    for (const line of ['[sudo] passwd for kirin:', 'Passwort:', 'pw:', 'PIN:', 'Kennwort:', 'Enter credentials:'])
      should(passwordTarget(sudo({ echo: 'on', promptLine: line }, 'bash'), 'value')).be.true();
    // Only a program that asks for 2FA codes keeps an echo-off code prompt a code: a shell's `read -s` does not.
    should(hidden('Verification code:', 'bash')).be.true();
    should(hidden('Verification code:', 'aws')).be.false();
    // A getpass program is always a password, whatever its prompt says.
    should(hidden('Verification code:', 'sudo')).be.true();
    should(passwordTarget(sudo({ echo: 'on', promptLine: 'Verification code:' }, 'su'), 'value')).be.true();
  });
});

describe('look-alike and hidden spellings (the pane and the ferret are untrusted text)', () => {
  it('should read accented, fullwidth, zero-width and mixed-script spellings of password as password', () => {
    // Arrange
    const shown = (promptLine: string) => passwordTarget(sudo({ echo: 'on', promptLine }, 'bash'), 'value');

    // Act / Assert
    for (const line of ['Pàssword:', 'ｐａｓｓｗｏｒｄ:', 'pass\u200bword:', 'P\u0430ssword:', 'Enter Р\u0406N:'])
      should(shown(line)).be.true();
    should(
      passwordTarget(sudo({ echo: 'off', promptLine: 'Verification code (p\u0430ssword):' }, 'ssh'), 'value'),
    ).be.true();
    should(passwordTarget(page([pageField({}, { type: 'text', name: 'p\u0430ss' })]), 'password')).be.true();
    should(shown('Verification code:')).be.false();
    should(lookAlike('Verification code:')).be.false();
    should(matchable('pa\u0301ss\u200bword')).equal('password');
  });
});
