import { describe, it } from 'bun:test';
import type { InputRequestField, InputTargetFacts, LoginObserved } from '@ferretry/protocol';
import should from 'should';
import {
  type LockContext,
  lockFor,
  longerLock,
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
