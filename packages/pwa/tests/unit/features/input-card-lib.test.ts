import { describe, expect, it } from 'bun:test';
import { INPUT_ERROR_CODES, unpadInputValue } from '@ferretry/protocol';
import {
  CAPTCHA_WARNING,
  chainWords,
  defaultSubmit,
  expiryWords,
  fieldProblem,
  fieldRiskLine,
  fieldsOf,
  initialSaveDraft,
  inputFailure,
  observedWords,
  offersPressEnter,
  PLAIN_NOTICE,
  plainFlagWords,
  REOBSERVING,
  SAVE_TOO_SHORT,
  saveBlock,
  saveDraftProblem,
  savedBody,
  savedOutcomeWords,
  sendBlock,
  shotBoxes,
  showsHeaderRisk,
  splitOffers,
  targetRef,
  titleWords,
  typedBody,
  typedFieldsBody,
  typedReady,
} from '../../../src/lib/input-card.ts';
import { must } from '../../support/dom.ts';
import {
  browserField,
  field as cardField,
  NOW,
  offer,
  request,
  requestOf,
  saved,
  withSaved,
} from '../../support/input-fixtures.ts';

const DELIVERY = '11111111-1111-4111-8111-111111111111';
const draft = (overrides: Partial<ReturnType<typeof initialSaveDraft>> = {}) => ({
  ...initialSaveDraft(saved()),
  enabled: true,
  ...overrides,
});

describe('the card words', () => {
  it('names the card by its agenda reference and the target by its reference', () => {
    expect(titleWords(request(), 'Hadi')).toBe('!A7 · Hadi needs a password');
    expect(targetRef(request())).toBe('%terminal:deploy');
  });

  it('counts down and says expired', () => {
    expect(expiryWords('2026-08-05T10:04:05.000Z', NOW)).toBe('4m 05s left');
    expect(expiryWords('2026-08-05T09:59:00.000Z', NOW)).toBe('expired');
  });
});

describe('offers ordering', () => {
  it('makes the first MATCHED offer the primary and leaves the daemon order for the rest', () => {
    const first = offer({ id: 'A_ONE', label: 'one', matched: false });
    const second = offer({ id: 'B_TWO', label: 'two', matched: true });
    const third = offer({ id: 'C_THREE', label: 'three', matched: true });

    const { primary, others } = splitOffers(saved({ offers: [first, second, third] }));

    expect(primary?.id).toBe('B_TWO');
    expect(others.map(entry => entry.id)).toEqual(['A_ONE', 'C_THREE']);
  });

  it('never promotes a hinted offer that the daemon did not match', () => {
    const hinted = offer({ id: 'HINTED', label: 'hinted', matched: false, hinted: true });

    const { primary, others } = splitOffers(saved({ offers: [hinted] }));

    expect(primary).toBeUndefined();
    expect(others).toEqual([hinted]);
  });

  it('has no primary and no others when nothing is saved', () => {
    expect(splitOffers(undefined)).toEqual({ primary: undefined, others: [] });
  });
});

describe('what Send does and does not wait for', () => {
  it('is blocked while the daemon is looking at the target again', () => {
    expect(sendBlock(request({ observed: undefined }), NOW)).toBe(REOBSERVING);
  });

  it('is NOT blocked by the risk flag: the flag warns, it does not refuse', () => {
    const red = request({ risk: { level: 'red', reason: 'This looks like a web page asking for a password.' } });
    expect(sendBlock(red, NOW)).toBeUndefined();
  });

  it('is blocked once expired or settled', () => {
    expect(sendBlock(request({ expiresAt: '2026-08-05T09:00:00.000Z' }), NOW)).toContain('expired');
    expect(sendBlock(request({ state: 'delivered' }), NOW)).toContain('no longer waiting');
  });
});

describe('press Enter', () => {
  it('defaults on for a terminal secret and is not offered when the agent presses it', () => {
    expect(defaultSubmit(request())).toBe(true);
    expect(defaultSubmit(requestOf('plain'))).toBe(false);
    expect(offersPressEnter(request({ submit: 'agent' }))).toBe(false);
  });
});

describe('typedBody', () => {
  const field = (value = saved()) => must(fieldsOf(withSaved(value))[0], 'the field');

  it('pads the value and carries the digest of what the card showed', () => {
    const built = typedBody({
      request: request(),
      field: field(),
      value: 'correct horse battery',
      submit: true,
      save: draft({ enabled: false }),
      deliveryId: DELIVERY,
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(unpadInputValue(built.body.padded ?? '')).toBe('correct horse battery');
    expect(built.body.observedDigest).toBe('a'.repeat(64));
    expect(built.body.entry).toBeUndefined();
    expect(built.body.save).toBeUndefined();
  });

  it('adds save only when ticked, saves is defined, and the password is long enough', () => {
    const long = typedBody({
      request: request(),
      field: field(),
      value: 'longenough1',
      submit: false,
      save: draft(),
      deliveryId: DELIVERY,
    });
    const short = typedBody({
      request: request(),
      field: field(),
      value: 'short',
      submit: false,
      save: draft(),
      deliveryId: DELIVERY,
    });
    const unticked = typedBody({
      request: request(),
      field: field(),
      value: 'longenough1',
      submit: false,
      save: draft({ enabled: false }),
      deliveryId: DELIVERY,
    });
    const never = typedBody({
      request: request(),
      field: field(saved({ saves: undefined })),
      value: 'longenough1',
      submit: false,
      save: draft(),
      deliveryId: DELIVERY,
    });

    expect(long.ok && long.body.save).toEqual({ entry: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box' });
    expect(short.ok && short.body.save).toBeUndefined();
    expect(unticked.ok && unticked.body.save).toBeUndefined();
    expect(never.ok && never.body.save).toBeUndefined();
  });

  it('says why a short secret cannot be saved, but still sends it', () => {
    expect(saveBlock(field(), 'short')).toBe(SAVE_TOO_SHORT);
    expect(saveBlock(field(), 'longenough1')).toBeUndefined();
    expect(saveBlock(field(saved({ saves: 'username' })), 'ab')).toBeUndefined();
  });

  it('never presses Enter when the agent does', () => {
    const built = typedBody({
      request: request({ submit: 'agent' }),
      field: field(),
      value: 'longenough1',
      submit: true,
      save: draft({ enabled: false }),
      deliveryId: DELIVERY,
    });
    expect(built.ok && built.body.submit).toBe(false);
  });
});

describe('savedBody', () => {
  it('sends the handle and no value, no padding and no save', () => {
    const built = savedBody(request(), 'SUDO_KIRIN_BOX', true, DELIVERY);

    expect(built).toEqual({
      ok: true,
      body: { deliveryId: DELIVERY, observedDigest: 'a'.repeat(64), entry: 'SUDO_KIRIN_BOX', submit: true },
    });
  });

  it('refuses while re-observing', () => {
    expect(savedBody(request({ observedDigest: undefined }), 'X', true, DELIVERY)).toEqual({
      ok: false,
      problem: REOBSERVING,
    });
  });
});

describe('inputFailure', () => {
  it('tells each refusal apart', () => {
    expect(inputFailure({ status: 409, code: INPUT_ERROR_CODES.targetChanged }).kind).toBe('changed');
    expect(inputFailure({ status: 409, code: INPUT_ERROR_CODES.alreadyDelivered }).kind).toBe('already');
    expect(inputFailure({ status: 410 }).kind).toBe('gone');
    expect(inputFailure({ status: 400, message: 'a value with a line break' }).text).toBe('a value with a line break');
  });

  it('keeps the delivery id after an unanswered send, so a second press cannot type twice', () => {
    const lost = inputFailure(new TypeError('network down'));
    expect(lost.definitive).toBe(false);
    expect(lost.text).toContain('will not type twice');
  });
});

describe('savedOutcomeWords', () => {
  const result = { id: 'ab'.repeat(16), deliveryId: DELIVERY, state: 'delivered', submitted: true } as const;

  it('says Saved as, or the problem, or nothing', () => {
    expect(savedOutcomeWords(result, 'x')).toBeUndefined();
    expect(savedOutcomeWords({ ...result, saved: { entry: 'X', ok: true } }, 'GitHub')).toBe('Saved as GitHub.');
    expect(
      savedOutcomeWords({ ...result, saved: { entry: 'X', ok: false, problem: 'the vault is full' } }, 'GitHub'),
    ).toContain('the vault is full');
  });
});

const email = cardField('plain', { id: 'email', label: 'Email' });
const password = cardField('secret', { id: 'password', label: 'Password' });
const login = (overrides: Partial<Parameters<typeof request>[0]> = {}) =>
  request({
    target: { kind: 'browser', key: 'app' },
    fields: [email, password],
    risk: email.risk,
    ...overrides,
  });

describe('a card of several fields', () => {
  it('keeps each field by its id, label and sensitivity, and offers Save to none of them', () => {
    const fields = fieldsOf(login({ saved: saved() }));

    expect(fields.map(each => [each.key, each.label, each.sensitivity])).toEqual([
      ['email', 'Email', 'plain'],
      ['password', 'Password', 'secret'],
    ]);
    expect(fields.every(each => each.saved === undefined)).toBe(true);
    expect(fields[0]?.risk?.level).toBe('red');
  });

  it('hands a lone field the saved logins, so Save as still has its suggestion', () => {
    expect(fieldsOf(withSaved(saved()))[0]?.saved?.saves).toBe('password');
  });

  it('reads "needs a login" for a secret AND a plain field, and keeps the old words otherwise', () => {
    expect(titleWords(login(), 'Hadi')).toBe('!A7 · Hadi needs a login');
    expect(titleWords(requestOf('plain'), 'Hadi')).toBe('!A7 · Hadi needs an answer');
    expect(titleWords(requestOf('private'), 'Hadi')).toBe('!A7 · Hadi needs a code');
    const codes = request({
      sensitivity: 'secret',
      fields: [cardField('secret', { id: 'password' }), cardField('private', { id: 'code' })],
    });
    expect(titleWords(codes, 'Hadi')).toBe('!A7 · Hadi needs a password');
  });

  it('says which step a chained card is, two when the daemon did not count', () => {
    expect(chainWords(request())).toBeUndefined();
    expect(chainWords(request({ chain: 'A7' }))).toBe('Step 2 · after !A7');
    expect(chainWords(request({ chain: 'A7', step: 3 }))).toBe('Step 3 · after !A7');
  });

  it('flags a plain field in the daemon words when it gave some, and says so itself otherwise', () => {
    const [plain] = fieldsOf(login());
    const [bare] = fieldsOf(login({ fields: [cardField('plain', { id: 'email', risk: undefined })] }));

    expect(plainFlagWords(must(plain, 'the field'))).toBe(PLAIN_NOTICE);
    expect(plainFlagWords(must(bare, 'the field'))).toBe(PLAIN_NOTICE);
    const worded = cardField('plain', { id: 'email', risk: { level: 'red', reason: 'Anyone can read an email.' } });
    expect(plainFlagWords(must(fieldsOf(login({ fields: [worded] }))[0], 'the field'))).toBe(
      'Anyone can read an email.',
    );
  });

  it("draws a secret field's own risk line only when it differs from the header", () => {
    const same = login({ fields: [password], risk: password.risk });
    const amber = { level: 'amber', reason: 'This field may show what is typed.' } as const;
    const differs = login({ fields: [email, cardField('secret', { id: 'password', risk: amber })] });

    expect(fieldRiskLine(same, must(fieldsOf(same)[0], 'the field'))).toBeUndefined();
    expect(fieldRiskLine(differs, must(fieldsOf(differs)[1], 'the field'))).toEqual(amber);
    expect(fieldRiskLine(differs, must(fieldsOf(differs)[0], 'the field'))).toBeUndefined();
  });

  it('flags each field of a larger card where it is, and never says the worst one twice on top', () => {
    const amber = { level: 'amber', reason: 'This field may show what is typed.' } as const;
    const card = login({ fields: [email, cardField('secret', { id: 'password', risk: amber })], risk: amber });

    expect(showsHeaderRisk(card)).toBe(false);
    expect(showsHeaderRisk(login({ fields: [password], risk: password.risk }))).toBe(true);
    expect(fieldRiskLine(card, must(fieldsOf(card)[1], 'the field'))).toEqual(amber);
  });

  it('is ready to send only when every field is typed and fine', () => {
    const fields = fieldsOf(login());

    expect(typedReady(fields, {})).toBe(false);
    expect(typedReady(fields, { email: 'a@b.test' })).toBe(false);
    expect(typedReady(fields, { email: 'a@b.test', password: 'pass\tword' })).toBe(false);
    expect(typedReady(fields, { email: 'a@b.test', password: 'longenough1' })).toBe(true);
    expect(typedReady(fieldsOf(request()), { value: 'x' })).toBe(true);
    expect(fieldProblem(must(fields[1], 'the field'), 'pass\tword')).toContain('would press keys');
    expect(fieldProblem(must(fields[1], 'the field'), '')).toBeUndefined();
  });
});

describe('typedFieldsBody', () => {
  const send = (values: Record<string, string>, overrides: Partial<Parameters<typeof request>[0]> = {}) => {
    const value = login(overrides);
    return typedFieldsBody({ request: value, fields: fieldsOf(value), values, submit: true, deliveryId: DELIVERY });
  };

  it('sends each typed value padded on its own, named by its field, and nothing else about them', () => {
    const built = send({ email: 'kirin@example.test', password: 'longenough1' });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.padded).toBeUndefined();
    expect(built.body.entry).toBeUndefined();
    expect(built.body.save).toBeUndefined();
    expect(built.body.observedDigest).toBe('a'.repeat(64));
    expect(built.body.submit).toBe(true);
    expect(built.body.fields?.map(typed => typed.field)).toEqual(['email', 'password']);
    expect(built.body.fields?.map(typed => unpadInputValue(typed.padded))).toEqual([
      'kirin@example.test',
      'longenough1',
    ]);
  });

  it('says which field is missing or refused, and sends nothing', () => {
    expect(send({ email: 'kirin@example.test' })).toEqual({ ok: false, problem: 'Type Password too.' });
    const refused = send({ email: 'kirin@example.test', password: 'pass\tword' });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.problem).toContain('Password: ');
    expect(send({ email: 'a', password: 'b' }, { observedDigest: undefined })).toEqual({
      ok: false,
      problem: REOBSERVING,
    });
  });

  it('never presses Enter when the agent does', () => {
    const built = send({ email: 'a@b.test', password: 'longenough1' }, { submit: 'agent' });
    expect(built.ok && built.body.submit).toBe(false);
  });
});

describe('what the daemon saw in a browser', () => {
  const page = (
    overrides: { origin?: string; secure?: boolean; frameOrigin?: string; type?: string; challenge?: boolean } = {},
  ) => {
    const origin = overrides.origin ?? 'https://accounts.google.com';
    return login({
      observed: {
        kind: 'browser',
        pageId: 'page-1',
        origin,
        secure: overrides.secure ?? true,
        navigationId: 'nav-1',
        fields: [
          browserField('email', { frameOrigin: origin, field: { tag: 'input', type: 'email' } }),
          browserField('password', {
            frameOrigin: overrides.frameOrigin ?? origin,
            field: { tag: 'input', type: overrides.type ?? 'password' },
          }),
        ],
        ...(overrides.challenge === true ? { challenge: { provider: 'recaptcha' } } : {}),
      },
    });
  };

  it('names the host and says https, then each field by its label: a password field, or its type', () => {
    expect(observedWords(page())).toEqual({
      program: 'accounts.google.com',
      echo: 'https',
      recognised: true,
      fields: [
        { key: 'email', label: 'Email', words: 'email field' },
        { key: 'password', label: 'Password', words: 'password field' },
      ],
    });
  });

  it('falls back to the tag when a field has no type', () => {
    const value = page();
    const facts = value.observed;
    if (facts?.kind !== 'browser') throw new Error('a browser request');
    const bare = {
      ...value,
      observed: { ...facts, fields: [browserField('email', { field: { tag: 'textarea' } }), ...facts.fields.slice(1)] },
    };
    expect(observedWords(bare)?.fields?.[0]?.words).toBe('textarea field');
  });

  it('says a plain http page is not secure, and a page on this machine is not called https', () => {
    expect(observedWords(page({ origin: 'http://example.test', secure: false }))?.echo).toBe('not secure (http)');
    expect(observedWords(page({ origin: 'http://localhost:3000', secure: true }))?.echo).toBe('http on this machine');
    expect(observedWords(page({ origin: 'http://localhost:3000', secure: true }))?.program).toBe('localhost:3000');
  });

  it('flags a field that sits in a frame from another origin', () => {
    const words = observedWords(page({ frameOrigin: 'https://ads.example.test' }));

    expect(words?.fields?.[0]?.words).toBe('email field');
    expect(words?.fields?.[1]?.words).toBe('password field in a frame from ads.example.test');
  });

  it('carries the captcha warning only when the page shows one', () => {
    expect(observedWords(page())?.challenge).toBeUndefined();
    expect(observedWords(page({ challenge: true }))?.challenge).toBe(CAPTCHA_WARNING);
    expect(CAPTCHA_WARNING).toBe(
      'This page is showing a captcha. Take over the browser and complete it yourself; Ferretry never solves one.',
    );
  });

  it('names a terminal by its program, with no field list', () => {
    expect(observedWords(request())).toEqual({
      program: 'sudo',
      echo: 'typing hidden',
      promptLine: '[sudo] password for kirin:',
      recognised: true,
    });
  });
});

describe('the save fields', () => {
  it('say what is wrong with a label or a handle, and nothing when saving is off', () => {
    expect(saveDraftProblem(draft({ enabled: false, label: '' }))).toBeUndefined();
    expect(saveDraftProblem(draft({ label: ' ' }))).toBe('Give it a label.');
    expect(saveDraftProblem(draft({ label: 'x'.repeat(81) }))).toBe('A label is at most 80 characters.');
    expect(saveDraftProblem(draft({ id: 'sudo kirin box' }))).toContain('uppercase letters, digits');
    expect(saveDraftProblem(draft())).toBeUndefined();
  });
});

describe('a send the grants refuse', () => {
  it('says what the grant guidance says, with the daemon words after it when it gave some', () => {
    const bare = inputFailure({ status: 403, code: 'grant_not_granted' });
    const worded = inputFailure({ status: 403, code: 'grant_not_granted', message: 'terminal use is off' });

    expect(bare.kind).toBe('refused');
    expect(bare.definitive).toBe(true);
    expect(worded.text).toBe(`${bare.text} terminal use is off`);
  });
});

describe('the boxes drawn on a page shot', () => {
  const page = (fields: ReturnType<typeof browserField>[]) =>
    request({
      target: { kind: 'browser', key: 'app' },
      fields: [
        cardField('plain', { id: 'email', label: 'Email' }),
        cardField('secret', { id: 'password', label: 'Password' }),
      ],
      observed: {
        kind: 'browser',
        pageId: 'page-1',
        origin: 'https://accounts.google.com',
        secure: true,
        navigationId: 'nav-1',
        fields,
      },
    });
  const shot = { pngBase64: 'iVBORw0KGgo=', clip: { x: 100, y: 200, w: 400, h: 200 } };

  it('places each field where the browser saw it, in percent of the picture, cut to the picture', () => {
    const card = page([
      browserField('email', { box: { x: 150, y: 220, w: 200, h: 40 } }),
      browserField('password', { box: { x: 450, y: 380, w: 200, h: 40 } }),
    ]);

    expect(shotBoxes(card, fieldsOf(card), shot)).toEqual([
      { key: 'email', label: 'Email', left: 12.5, top: 10, width: 50, height: 20 },
      { key: 'password', label: 'Password', left: 87.5, top: 90, width: 12.5, height: 10 },
    ]);
  });

  it('draws nothing for a field with no size, one outside the picture, a terminal, or an empty picture', () => {
    const card = page([
      browserField('email', { box: { x: 150, y: 220, w: 0, h: 40 } }),
      browserField('password', { box: { x: 900, y: 900, w: 10, h: 10 } }),
    ]);

    expect(shotBoxes(card, fieldsOf(card), shot)).toEqual([]);
    expect(shotBoxes(request(), fieldsOf(request()), shot)).toEqual([]);
    expect(shotBoxes(card, fieldsOf(card), { ...shot, clip: { x: 0, y: 0, w: 0, h: 10 } })).toEqual([]);
  });
});
