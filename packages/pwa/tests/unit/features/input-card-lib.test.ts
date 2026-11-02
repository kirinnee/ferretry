import { describe, expect, it } from 'bun:test';
import { type AccountList, INPUT_ERROR_CODES, unpadInputValue } from '@ferretry/protocol';
import {
  accountTitleWords,
  alwaysUseFor,
  cardAccountWords,
  differentAccountWords,
  editSaveLabel,
  editSaveUsername,
  switchSaveMode,
  updateChoiceWords,
  updateWords,
  usernameLocked,
  CAPTCHA_WARNING,
  chainWords,
  choiceReasonWords,
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
  pickOneOffers,
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
  signInWords,
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
  primaryOffer,
  request,
  requestOf,
  saved,
  savedSignIn,
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

  it('names a secret by its name, since no reference sigil names one', () => {
    const into = (exists: boolean) =>
      request({
        target: { kind: 'secret', key: 'VERCEL_TOKEN' } as never,
        observed: { kind: 'secret', name: 'VERCEL_TOKEN', exists } as never,
      });
    expect(targetRef(into(false))).toBe('the secret VERCEL_TOKEN');
    expect(observedWords(into(false))).toEqual({
      program: 'VERCEL_TOKEN',
      verb: 'in the secret store',
      echo: 'a new secret',
      recognised: true,
    });
    expect(observedWords(into(true))?.echo).toBe('replaces its value');
  });

  it('names a terminal by the PROVED program, and calls one only ps names unverified', () => {
    const terminal = (observed: Record<string, unknown>) =>
      request({
        target: { kind: 'terminal', key: 'dev' },
        observed: {
          kind: 'terminal',
          paneProof: { paneId: '%3', pid: 1 },
          foreground: { pid: 2, pgid: 2, comm: 'sudo', argv: 'sudo -v' },
          echo: 'off',
          cursorRow: 0,
          promptLine: '',
          promptLineDigest: 'a'.repeat(64),
          ...observed,
        } as never,
      });
    expect(observedWords(terminal({ program: 'sudo', recognisedConsumer: true }))).toMatchObject({
      program: 'sudo',
      recognised: true,
    });
    expect(observedWords(terminal({ program: 'sudo', recognisedConsumer: true }))?.verb).toBeUndefined();
    expect(observedWords(terminal({ recognisedConsumer: false }))).toMatchObject({
      program: 'sudo',
      verb: 'is asking · unverified',
      recognised: false,
    });
  });

  it('counts down and says expired', () => {
    expect(expiryWords('2026-08-05T10:04:05.000Z', NOW)).toBe('4m 05s left');
    expect(expiryWords('2026-08-05T09:59:00.000Z', NOW)).toBe('expired');
  });
});

describe('offers ordering', () => {
  it('makes the offer the DAEMON marked primary the primary and leaves the daemon order for the rest', () => {
    const first = offer({ id: 'A_ONE', label: 'one', matched: false });
    const second = offer({ id: 'B_TWO', label: 'two', matched: true });
    const third = primaryOffer({ id: 'C_THREE', label: 'three' });

    const { primary, others } = splitOffers(saved({ offers: [first, second, third] }));

    expect(primary?.id).toBe('C_THREE');
    expect(others.map(entry => entry.id)).toEqual(['A_ONE', 'B_TWO']);
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

  it('names the sign-in and the 2FA key the owner tapped, and only those', () => {
    const built = savedBody(request(), 'GITHUB', false, DELIVERY, {
      signIn: 'si_0123456789abcdef',
      factor: 'tf_000000000002',
    });

    expect(built).toEqual({
      ok: true,
      body: {
        deliveryId: DELIVERY,
        observedDigest: 'a'.repeat(64),
        entry: 'GITHUB',
        signIn: 'si_0123456789abcdef',
        factor: 'tf_000000000002',
        submit: false,
      },
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

  it('asks the owner to check a redrawn card and send again, naming the page or the terminal (#B100)', () => {
    const page = inputFailure({ status: 409, code: INPUT_ERROR_CODES.targetRebound }, 'browser');
    const terminal = inputFailure({ status: 409, code: INPUT_ERROR_CODES.targetRebound }, 'terminal');

    expect(page).toEqual({
      kind: 'changed',
      definitive: true,
      text: 'The page changed. Check the picture and send again.',
    });
    expect(terminal.text).toBe('The terminal redrew its prompt. Check it and send again.');
    expect(inputFailure({ status: 409, code: INPUT_ERROR_CODES.targetRebound }, 'secret').text).toBe(
      'The secret store changed. Check the card and send again.',
    );
    expect(inputFailure({ status: 409, code: INPUT_ERROR_CODES.targetRebound }).text).toBe(
      'The page changed. Check the picture and send again.',
    );
  });

  it('says in plain words why a request that kept changing ended, never "check failures" (#B100)', () => {
    const ended = inputFailure({ status: 410, code: INPUT_ERROR_CODES.targetUnsettled }, 'browser');
    const changed = inputFailure({ status: 409, code: INPUT_ERROR_CODES.targetChanged }, 'browser');

    expect(ended.kind).toBe('gone');
    expect(ended.text).toBe(
      'The page kept changing, so nothing was typed and this request ended. Ask the ferret to request again.',
    );
    expect(ended.text).not.toContain('check failures');
    expect(changed.text).toBe(
      'The page is no longer what this card showed, so nothing was typed. Check the card before you send again.',
    );
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
    expect(titleWords(requestOf('private'), 'Hadi')).toBe('!A7 · Hadi needs a private value');
    expect(titleWords(requestOf('code'), 'Hadi')).toBe('!A7 · Hadi needs a code');
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

  it('says when something covers a field or it is off screen', () => {
    const card = page();
    const facts = card.observed;
    if (facts?.kind !== 'browser') throw new Error('a page card');
    const covered = {
      ...card,
      observed: { ...facts, fields: facts.fields.map(field => ({ ...field, covered: true as const })) },
    };

    expect(observedWords(covered)?.fields?.[1]?.words).toBe('password field, covered or off screen');
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
    expect(saveDraftProblem(draft({ label: ' ' }))).toBe('Give the account a name.');
    expect(saveDraftProblem(draft({ label: 'x'.repeat(81) }))).toBe('A name is at most 80 characters.');
    expect(saveDraftProblem(draft({ id: 'sudo kirin box' }))).toContain('capital letters, digits');
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

describe('signInWords', () => {
  it('is the sign-in sentence of a provider login, and nothing for a password one', () => {
    expect(signInWords(savedSignIn())).toBe("Sign in with Google via 'Google (kirin@…)'");
    expect(signInWords(saved())).toBeUndefined();
    expect(signInWords(undefined)).toBeUndefined();
    expect(signInWords(saved({ signIn: { id: 'ACME', label: 'Acme', method: { kind: 'sso', name: 'Okta' } } }))).toBe(
      'Sign in with Okta (SSO)',
    );
  });
});

describe("the one-tap choice is the daemon's", () => {
  it('never falls back to the first matched offer', () => {
    expect(splitOffers(saved({ offers: [offer({ matched: true })] })).primary).toBeUndefined();
  });
});

describe('the reason, Pick one and Always use words', () => {
  it("says why in the daemon's words", () => {
    const at = saved({ match: 'app.clickup.com' });
    expect(choiceReasonWords(at, primaryOffer({ why: 'ferret' }))).toBe('Ferret chose this');
    expect(choiceReasonWords(at, primaryOffer({ why: 'project', project: 'ferretry' }))).toBe('Default for ferretry');
    expect(choiceReasonWords(at, primaryOffer({ why: 'folder' }))).toBe('Default for this folder');
    expect(choiceReasonWords(at, primaryOffer({ why: 'site' }))).toBe('Default for app.clickup.com');
    expect(choiceReasonWords(at, primaryOffer({ why: 'only' }))).toBe('Only account here');
    expect(choiceReasonWords(at, undefined)).toBeUndefined();
  });

  it('asks the owner to pick only when two or more signed-in accounts match and none is primary', () => {
    const a = offer({ id: 'A_ONE', signIn: 'si_0123456789abcdef' });
    const b = offer({ id: 'B_TWO', signIn: 'si_fedcba9876543210' });
    expect(pickOneOffers(saved({ offers: [a, b] })).map(each => each.id)).toEqual(['A_ONE', 'B_TWO']);
    expect(pickOneOffers(saved({ offers: [a] }))).toEqual([]);
    expect(pickOneOffers(saved({ offers: [primaryOffer({ id: 'A_ONE' }), b] }))).toEqual([]);
    expect(pickOneOffers(saved({ offers: [offer({ id: 'A_ONE' }), offer({ id: 'B_TWO' })] }))).toEqual([]);
  });

  it("offers Always use only for a hand-tapped matched account, in the daemon's project, at a place key", () => {
    const project = { id: 'p_ferretry', name: 'ferretry' };
    const at = saved({ match: 'app.clickup.com', project });
    const tapped = offer({ id: 'HOME', label: 'Home', signIn: 'si_fedcba9876543210' });
    expect(alwaysUseFor(at, tapped)?.body).toEqual({
      scope: 'projects',
      within: 'p_ferretry',
      key: 'app.clickup.com',
      account: 'HOME',
    });
    expect(alwaysUseFor(saved({ match: 'app.clickup.com' }), tapped)).toBeUndefined();
    expect(alwaysUseFor(at, { ...tapped, matched: false })).toBeUndefined();
    expect(alwaysUseFor(at, offer({ id: 'HOME' }))).toBeUndefined();
    expect(alwaysUseFor(at, primaryOffer({ why: 'project', project: 'ferretry' }))).toBeUndefined();
    expect(alwaysUseFor(saved({ match: 'NOT A KEY', project }), tapped)).toBeUndefined();
  });
});

/**
 * &B137, THE OWNER'S SCENARIO: kirinnee97@gmail.com's Google password is saved; the page is signing in ernest@atomi.tech
 * (the ferret typed it). The daemon took the one-tap away; Save as must start on a NEW account for ernest, never
 * update kirinnee97, and the title names ernest only from the secrets-gated accounts listing.
 */
describe('a second person on one site', () => {
  const KIRIN = { id: 'ACCOUNTS_GOOGLE_COM', label: 'accounts.google.com', username: 'kirinnee97@gmail.com' };
  const ernestCard = () =>
    saved({
      match: 'accounts.google.com',
      suggest: { id: 'GOOGLE_ERNEST', label: 'Google · ernest@atomi.tech' },
      newAccount: { id: 'GOOGLE_ERNEST', label: 'Google · ernest@atomi.tech' },
      typedUsername: 'ernest@atomi.tech',
      differentFrom: KIRIN,
      offers: [offer({ ...KIRIN, signIn: 'si_0123456789abcdef' })],
    });
  const listing = (): AccountList =>
    ({
      v: 1,
      accounts: [
        {
          id: KIRIN.id,
          label: KIRIN.label,
          username: KIRIN.username,
          fields: { password: true, totp: false },
          factors: [],
          signIns: [],
          createdAt: '2026-11-02T00:00:00.000Z',
          updatedAt: '2026-11-02T00:00:00.000Z',
        },
      ],
      signIns: [],
    }) as unknown as AccountList;

  it('should start Save as on a NEW account for ernest, with his username, never on kirinnee97', () => {
    const draft = initialSaveDraft(ernestCard());

    expect(draft).toMatchObject({
      mode: 'new',
      label: 'Google · ernest@atomi.tech',
      id: 'GOOGLE_ERNEST',
      username: 'ernest@atomi.tech',
    });
    expect(differentAccountWords(ernestCard())).toBe(
      'This looks like a different account. The page is signing in ernest@atomi.tech, not accounts.google.com (kirinnee97@gmail.com).',
    );
  });

  it('should send a new account with its username, and name the account in the app title only from the accounts listing', () => {
    const value = withSaved(ernestCard(), { target: { kind: 'browser', key: 'gper2' } });
    const built = typedBody({
      request: value,
      field: must(fieldsOf(value)[0], 'the field'),
      value: 'ernest-UNIQUE-pw-2',
      submit: false,
      save: { ...initialSaveDraft(ernestCard()), enabled: true },
      deliveryId: 'd1',
    });

    expect(built.ok && built.body.save).toEqual({
      entry: 'GOOGLE_ERNEST',
      label: 'Google · ernest@atomi.tech',
      mode: 'new',
      username: 'ernest@atomi.tech',
    });
    // Without the secrets-gated listing (a device without secrets.use): the place-only title, no person.
    expect(accountTitleWords(value, 'Hadi', undefined)).toBeUndefined();
    // With it: never the demoted kirinnee97 as the card's account; the page's person, said as the ferret's word.
    expect(cardAccountWords(ernestCard(), listing())).toBeUndefined();
    expect(accountTitleWords(value, 'Hadi', listing())).toBe(
      '!A7 · Hadi needs a password, signing in ernest@atomi.tech as typed on the page',
    );
  });

  it('should start on UPDATE only when the username is the account’s own, and name that account in the title', () => {
    const same = saved({
      match: 'accounts.google.com',
      update: KIRIN,
      newAccount: { id: 'GOOGLE_KIRINNEE97', label: 'Google · kirinnee97@gmail.com' },
      typedUsername: 'kirinnee97@gmail.com',
      offers: [primaryOffer({ ...KIRIN })],
    });

    expect(initialSaveDraft(same)).toMatchObject({ mode: 'update', id: KIRIN.id, username: KIRIN.username });
    expect(usernameLocked(same, initialSaveDraft(same))).toBe(true);
    expect(updateChoiceWords(same)).toBe('Update accounts.google.com (same username, kirinnee97@gmail.com)');
    expect(cardAccountWords(same, listing())).toBe('accounts.google.com (kirinnee97@gmail.com)');
    expect(accountTitleWords(withSaved(same), 'Hadi', listing())).toBe(
      '!A7 · Hadi needs a password for accounts.google.com (kirinnee97@gmail.com)',
    );
    // Pressing "Type a different one" over the one-tap starts a NEW account, whatever was saved.
    expect(initialSaveDraft(same, { typedInstead: true }).mode).toBe('new');
  });

  it('should never carry another username on an update: Update takes the account’s own', () => {
    const card = saved({
      match: 'accounts.google.com',
      update: KIRIN,
      newAccount: { id: 'GOOGLE_ERNEST', label: 'Google · ernest@atomi.tech' },
      offers: [primaryOffer({ ...KIRIN })],
    });
    // The owner typed instead of the one-tap, then changed the Username, then chose Update after all.
    const typedOver = editSaveUsername(
      card,
      { ...initialSaveDraft(card, { typedInstead: true }), enabled: true },
      'ernest@atomi.tech',
    );
    expect(typedOver.mode).toBe('new');
    const updating = switchSaveMode(card, typedOver, 'update');
    const value = withSaved(card);
    const built = typedBody({
      request: value,
      field: must(fieldsOf(value)[0], 'the field'),
      value: 'ernest-UNIQUE-pw-2',
      submit: false,
      save: updating,
      deliveryId: 'd1',
    });

    expect(updating.username).toBe('kirinnee97@gmail.com');
    expect(built.ok && built.body.save).toEqual({ entry: KIRIN.id, label: KIRIN.label, mode: 'update' });
    expect(switchSaveMode(card, updating, 'new')).toMatchObject({ mode: 'new', username: '' });
    // An account with no username saved takes the one the owner confirms.
    const bare = saved({ match: 'x.com', update: { id: 'X', label: 'x' }, newAccount: { id: 'X_2', label: 'x.com' } });
    const filled = switchSaveMode(
      bare,
      editSaveUsername(bare, { ...initialSaveDraft(bare), enabled: true }, 'e@x.com'),
      'update',
    );
    const sent = typedBody({
      request: withSaved(bare),
      field: must(fieldsOf(withSaved(bare))[0], 'the field'),
      value: 'ernest-UNIQUE-pw-2',
      submit: false,
      save: filled,
      deliveryId: 'd2',
    });
    expect(sent.ok && sent.body.save).toEqual({ entry: 'X', label: 'x', mode: 'update', username: 'e@x.com' });
  });

  it('should name a new account after its username until the owner names it, and its terminal name after its name', () => {
    const card = ernestCard();
    const typed = editSaveUsername(card, initialSaveDraft(card), 'e.ng@atomi.tech');
    expect(typed).toMatchObject({ label: 'Google · e.ng@atomi.tech', id: 'GOOGLE_E_NG_ATOMI_TECH' });

    const named = editSaveLabel(card, typed, 'Work Google');
    expect(named).toMatchObject({ label: 'Work Google', id: 'WORK_GOOGLE' });
    expect(editSaveUsername(card, named, 'x@y.z')).toMatchObject({ label: 'Work Google', username: 'x@y.z' });
    // A name in the terminal another account has is never suggested.
    expect(editSaveLabel(card, typed, 'accounts google com').id).toBe('ACCOUNTS_GOOGLE_COM_2');
  });

  it('should never start on Update when who the page signs in is unknown, whatever the account holds (M4)', () => {
    const unknown = saved({
      match: 'accounts.google.com',
      update: KIRIN,
      newAccount: { id: 'GOOGLE', label: 'Google' },
      offers: [primaryOffer({ ...KIRIN })],
    });
    const sudo = saved({
      update: { id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box' },
      newAccount: { id: 'SUDO_KIRIN_BOX_2', label: 'sudo on kirin-box' },
    });

    expect(initialSaveDraft(unknown)).toMatchObject({ mode: 'new', username: '' });
    // Update, chosen by hand, takes that account's own username.
    expect(switchSaveMode(unknown, initialSaveDraft(unknown), 'update').username).toBe(KIRIN.username);
    expect(initialSaveDraft(sudo).mode).toBe('new');
  });

  it('should keep a terminal name the owner edited when the username changes, and change nothing it cannot switch to', () => {
    const card = ernestCard();
    const edited = { ...initialSaveDraft(card), id: 'MINE', idEdited: true };
    expect(editSaveUsername(card, edited, 'x@y.z')).toMatchObject({ id: 'MINE', label: 'Google · x@y.z' });
    // No account to update (the daemon sent none): Update changes nothing.
    expect(switchSaveMode(card, edited, 'update')).toBe(edited);
    // On Update of an account with no username, the box is the owner's: it changes the username and names nothing.
    const updating = { ...edited, mode: 'update' as const, label: 'google', id: 'G' };
    expect(editSaveUsername(card, updating, 'e@x.com')).toEqual({ ...updating, username: 'e@x.com' });
  });

  it('should word an account plainly, with or without a username saved', () => {
    expect(updateChoiceWords(saved({ update: { id: 'G', label: 'google' } }))).toBe('Update google');
    const labelled = { id: 'G', label: 'Google · a@x.com', username: 'a@x.com' };
    expect(updateChoiceWords(saved({ update: labelled, typedUsername: 'A@x.com' }))).toBe(
      'Update Google · a@x.com (same username)',
    );
    // Who the page signs in is unknown: no sameness is claimed, the username is said plainly.
    expect(updateChoiceWords(saved({ update: { ...labelled, label: 'google' } }))).toBe('Update google (a@x.com)');
    expect(updateChoiceWords(saved())).toBeUndefined();
    expect(updateWords({ id: 'G', label: 'google' })).toBe('Replaces the saved password of google.');
    expect(
      differentAccountWords(
        saved({ typedUsername: 'b@x.com', differentFrom: { id: 'G', label: 'google' }, offers: [] }),
      ),
    ).toBe(
      'This looks like a different account. The page is signing in b@x.com, and google has no username saved, so pick it only if it is the same one.',
    );
  });

  it('should say what is wrong with a username, or a new terminal name another account has', () => {
    const card = ernestCard();
    const draft = { ...initialSaveDraft(card), enabled: true };
    expect(saveDraftProblem({ ...draft, username: 'a\nb' }, card)).toBe(
      'That username cannot be kept: one line, at most 256 characters.',
    );
    expect(saveDraftProblem({ ...draft, id: KIRIN.id }, card)).toBe(
      'Another account is already called ACCOUNTS_GOOGLE_COM in the terminal: change it under More.',
    );
  });
});
