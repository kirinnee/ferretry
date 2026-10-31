import { describe, it } from 'bun:test';
import type { InputRequestField, InputTargetFacts, LoginObserved } from '@ferretry/protocol';
import should from 'should';
import {
  lockFor,
  longerLock,
  pageFieldsQualify,
  probeable,
  provenByFacts,
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

const terminal = (echo: 'off' | 'on', recognised: boolean): InputTargetFacts => ({
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 1 },
  foreground: { pid: 2, pgid: 2, comm: 'sudo', argv: 'sudo -v' },
  echo,
  cursorRow: 0,
  promptLine: '',
  promptLineDigest: 'a'.repeat(64),
  recognisedConsumer: recognised,
});

const field = (id: string, sensitivity: InputRequestField['sensitivity']): InputRequestField =>
  ({ id, sensitivity }) as unknown as InputRequestField;
const SECRET = [field('password', 'secret')];
const flag = { value: true, observedAt: '2026-10-31T09:00:00.000Z', count: 2 };

const proven = (facts: InputTargetFacts, extra: Partial<LoginObserved> = {}): LoginObserved => ({
  at: 'accounts.example.test',
  surface: 'page',
  identity: identityOf(facts, 'accounts.example.test') as string,
  since: '2026-10-31T09:00:00.000Z',
  masked: flag,
  noEchoAfterSubmit: flag,
  navigatedAway: flag,
  ...extra,
});

describe('the lock a delivery earns', () => {
  it('should be short for a terminal that hides typing for a recognised program, and long otherwise', () => {
    should(lockFor(terminal('off', true), SECRET, [], false)).deepEqual({ seconds: 10, reason: 'hidden-terminal' });
    should(lockFor(terminal('on', true), SECRET, [], false)).deepEqual({ seconds: 120, reason: 'not-proven' });
    should(lockFor(terminal('off', false), SECRET, [], false)).deepEqual({ seconds: 120, reason: 'not-proven' });
  });

  it('should be long for a one-time code, wherever it goes', () => {
    should(lockFor(terminal('off', true), [field('code', 'private')], [], true).reason).equal('code');
    should(lockFor(page(), [...SECRET, field('code', 'private')], [proven(page())], true).seconds).equal(120);
  });

  it("should be short for a page field proven by a saved login's facts about that very field", () => {
    const facts = page();
    should(lockFor(facts, SECRET, [proven(facts)], false)).deepEqual({ seconds: 10, reason: 'proven-field' });
    should(provenByFacts(facts, [proven(facts, { noEchoAfterSubmit: { ...flag, value: false } })])).be.false();
    should(provenByFacts(facts, [proven(facts, { navigatedAway: undefined })])).be.false();
    should(provenByFacts(facts, [proven(facts, { surface: 'terminal' })])).be.false();
    should(provenByFacts(facts, [proven(facts, { at: 'other.example.test' })])).be.false();
    const renamed = page([pageField({}, { name: 'pass2' })]);
    should(provenByFacts(renamed, [proven(facts)])).be.false();
    should(provenByFacts({ ...facts, origin: 'null' } as InputTargetFacts, [proven(facts)])).be.false();
  });

  it('should be short for a clean probe, and long when it did not run cleanly', () => {
    should(lockFor(page(), SECRET, [], true)).deepEqual({ seconds: 10, reason: 'probed-field' });
    should(lockFor(page(), SECRET, [], false)).deepEqual({ seconds: 120, reason: 'not-proven' });
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
      should(lockFor(facts, SECRET, [proven(facts)], true).seconds).equal(120);
    }
    should(pageFieldsQualify(terminal('off', true), SECRET)).be.false();
  });

  it('should keep the longer of two locks', () => {
    const short = { seconds: 10, reason: 'probed-field' } as const;
    const long = { seconds: 120, reason: 'not-proven' } as const;
    should(longerLock(short, long)).equal(long);
    should(longerLock(long, short)).equal(long);
  });
});

describe('when the dummy probe may run', () => {
  it('should run only on a qualifying page not already proven', () => {
    should(probeable(page(), SECRET, [])).be.true();
    should(probeable(page(), SECRET, [proven(page())])).be.false();
    should(probeable(terminal('off', true), SECRET, [])).be.false();
    should(probeable(page([pageField({}, { type: 'text' })]), SECRET, [])).be.false();
  });

  it('should never run on a card with a one-time code, or on a field that looks like one', () => {
    should(probeable(page(), [...SECRET, field('code', 'private')], [])).be.false();
    for (const attributes of [
      { autocomplete: 'one-time-code' },
      { inputmode: 'numeric' },
      { inputmode: 'tel' },
      { inputmode: 'decimal' },
    ])
      should(probeable(page([pageField({}, attributes)]), SECRET, [])).be.false();
    should(
      probeable(page([pageField({}, { autocomplete: 'current-password', inputmode: 'text' })]), SECRET, []),
    ).be.true();
  });
});
