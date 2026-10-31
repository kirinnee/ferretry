import { describe, expect, it } from 'bun:test';
import { INPUT_ERROR_CODES, unpadInputValue } from '@ferretry/protocol';
import {
  defaultSubmit,
  expiryWords,
  fieldsOf,
  initialSaveDraft,
  inputFailure,
  observedWords,
  offersPressEnter,
  REOBSERVING,
  SAVE_TOO_SHORT,
  saveBlock,
  saveDraftProblem,
  savedBody,
  savedOutcomeWords,
  sendBlock,
  splitOffers,
  targetRef,
  titleWords,
  typedBody,
} from '../../../src/lib/input-card.ts';
import { must } from '../../support/dom.ts';
import { NOW, offer, request, saved, withSaved } from '../../support/input-fixtures.ts';

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
    expect(defaultSubmit(request({ sensitivity: 'plain' }))).toBe(false);
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

describe('what the daemon saw in a browser', () => {
  const facts = (type: string | undefined) =>
    request({
      target: { kind: 'browser', key: 'app', selector: '#password' },
      observed: {
        kind: 'browser',
        pageId: 'page-1',
        origin: 'https://github.com',
        secure: true,
        frameOrigin: 'https://github.com',
        navigationId: 'nav-1',
        backendNodeId: 7,
        field: { tag: 'input', ...(type === undefined ? {} : { type }) },
        box: { x: 0, y: 0, w: 100, h: 20 },
        visible: true,
      },
    });

  it('names the origin, and says whether the field is a password field', () => {
    expect(observedWords(facts('password'))).toEqual({
      program: 'https://github.com',
      echo: 'password field',
      recognised: true,
    });
    expect(observedWords(facts('text'))?.echo).toBe('field');
    expect(observedWords(facts(undefined))?.echo).toBe('field');
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
