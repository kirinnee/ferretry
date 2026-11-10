/**
 * The input card's decisions as pure functions (`app/lib/input-card.ts`, `app/lib/input-wire.ts`): the expiry words,
 * the field attributes, the sentence a refused field becomes, and the sentence every failed Send becomes. Only obvious
 * fakes appear here.
 */
import { describe, expect, it } from 'bun:test';
import {
  expiryWords,
  fieldAttributes,
  fieldsOf,
  inputFailure,
  type InputFailure,
  typedBody,
} from '../../../app/lib/input-card.ts';
import { InputRequestViewSchema } from '../../../app/lib/input-wire.ts';
import { FAKE_VALUE, terminalRequest } from '../../support/app/input-fixtures.ts';

const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const at = (seconds: number): string => new Date(NOW + seconds * 1_000).toISOString();

describe('how long a request has left', () => {
  it('counts minutes and seconds under an hour', () => {
    expect(expiryWords(at(8 * 60 + 5), NOW)).toBe('8m 05s left');
  });

  it('counts hours and minutes from an hour up', () => {
    expect(expiryWords(at(2 * 3_600 + 5 * 60 + 30), NOW)).toBe('2h 05m left');
  });

  it('says expired at zero and after', () => {
    expect(expiryWords(at(0), NOW)).toBe('expired');
    expect(expiryWords(at(-30), NOW)).toBe('expired');
  });
});

describe('the attributes of a value field', () => {
  it('hides a private value behind a Show toggle with a numeric pad', () => {
    expect(fieldAttributes('private', false)).toEqual({
      type: 'password',
      autoComplete: 'one-time-code',
      inputMode: 'numeric',
    });
    expect(fieldAttributes('private', true).type).toBe('text');
  });

  it('shows a code and a plain value as they are typed', () => {
    expect(fieldAttributes('code', false)).toEqual({ type: 'text', autoComplete: 'one-time-code' });
    expect(fieldAttributes('plain', false)).toEqual({ type: 'text', autoComplete: 'off' });
  });
});

describe('what a card of several fields says about a refused one', () => {
  const login = terminalRequest({
    fields: [
      { id: 'user', label: 'Username', sensitivity: 'plain' },
      { id: 'pass', label: 'Password', sensitivity: 'secret' },
    ],
  });

  it('names the field a refused value belongs to', () => {
    const built = typedBody({
      request: login,
      fields: fieldsOf(login),
      values: { user: 'fake-user', pass: 'fake\u0007bell' },
      submit: false,
      deliveryId: 'delivery-1',
    });
    expect(built).toEqual({
      ok: false,
      problem: 'Password: this would press keys: remove the control characters or line breaks',
    });
  });

  it('gives the bare sentence on a card of one field', () => {
    const one = terminalRequest();
    const built = typedBody({
      request: one,
      fields: fieldsOf(one),
      values: { value: 'fake\u0007bell' },
      submit: false,
      deliveryId: 'delivery-1',
    });
    expect(built).toEqual({
      ok: false,
      problem: 'this would press keys: remove the control characters or line breaks',
    });
  });
});

describe('a risk level this build does not know', () => {
  const read = (level: string, onRequest = false) => {
    const risk = { level, reason: 'Seen from a newer daemon.' };
    return InputRequestViewSchema.parse(
      terminalRequest({
        fields: [{ id: 'value', label: 'Password', sensitivity: 'secret', ...(onRequest ? {} : { risk }) }],
        ...(onRequest ? { risk } : {}),
      }),
    );
  };

  it('reads as amber on a field: a warning, never a pass', () => {
    expect(read('cosmic').fields[0]?.risk).toEqual({ level: 'amber', reason: 'Seen from a newer daemon.' });
  });

  it('reads as amber on the request too', () => {
    expect(read('cosmic', true).risk?.level).toBe('amber');
  });

  it('keeps a level it knows', () => {
    expect(read('red').fields[0]?.risk?.level).toBe('red');
  });
});

describe('a failed Send, in words', () => {
  const refusal = (status: number, code?: string, message?: string) =>
    Object.assign(new Error(message ?? 'x'), { status, ...(code === undefined ? {} : { code }) });
  const text = (failure: InputFailure): string => failure.text;

  it('says the terminal redrew its prompt when its prompt moved', () => {
    const failure = inputFailure(refusal(409, 'target_rebound'), 'terminal');
    expect(failure).toEqual({
      kind: 'changed',
      definitive: true,
      text: 'The terminal redrew its prompt. Check it and send again.',
    });
  });

  it('says the secret store changed when a secret target moved', () => {
    expect(text(inputFailure(refusal(409, 'target_rebound'), 'secret'))).toBe(
      'The secret store changed. Check the card and send again.',
    );
  });

  it('says the page changed for a page target and for a target it was not told', () => {
    const page = 'The page changed. Check the card and send again.';
    expect(text(inputFailure(refusal(409, 'target_rebound'), 'page'))).toBe(page);
    expect(text(inputFailure(refusal(409, 'target_rebound')))).toBe(page);
  });

  it('names the surface a changed target is on, and nothing was typed', () => {
    expect(inputFailure(refusal(409, 'target_changed'), 'page')).toMatchObject({ kind: 'changed', definitive: true });
    expect(text(inputFailure(refusal(409, 'target_changed'), 'terminal'))).toContain('The terminal is no longer');
    expect(text(inputFailure(refusal(409, 'target_changed')))).toContain('The target is no longer');
    expect(text(inputFailure(refusal(409, 'target_changed'), 'secret'))).toContain('nothing was typed');
  });

  it('ends the request when its target kept changing', () => {
    const failure = inputFailure(refusal(410, 'target_unsettled'), 'terminal');
    expect(failure).toMatchObject({ kind: 'gone', definitive: true });
    expect(failure.text).toBe(
      'The terminal kept changing, so nothing was typed and this request ended. Ask the ferret to request again.',
    );
  });

  it('says it was already sent when the daemon already has the delivery', () => {
    expect(inputFailure(refusal(409, 'already_delivered'), 'terminal')).toEqual({
      kind: 'already',
      definitive: true,
      text: 'This was already sent.',
    });
  });

  it('says an expired or cancelled request typed nothing', () => {
    expect(inputFailure(refusal(410, 'expired'), 'terminal')).toEqual({
      kind: 'gone',
      definitive: true,
      text: 'This request expired or was cancelled. Nothing was typed.',
    });
  });

  it('shows the daemon’s own sentence for any other refusal it answered', () => {
    expect(inputFailure(refusal(422, undefined, 'That value is not allowed here.'))).toEqual({
      kind: 'refused',
      definitive: true,
      text: 'That value is not allowed here.',
    });
  });

  it('falls back to a plain sentence when the refusal carries no message', () => {
    expect(inputFailure({ status: 500, message: '' })).toEqual({
      kind: 'refused',
      definitive: true,
      text: 'The daemon refused this.',
    });
    expect(text(inputFailure({ status: 500 }))).toBe('The daemon refused this.');
  });

  it('treats an answer that never came as unknown, and says a second press will not type twice', () => {
    const unknown: InputFailure = {
      kind: 'unknown',
      definitive: false,
      text: 'Could not reach the machine. If you press Send again it will not type twice.',
    };
    expect(inputFailure(new Error('network down'))).toEqual(unknown);
    expect(inputFailure(null)).toEqual(unknown);
    expect(inputFailure('boom')).toEqual(unknown);
  });

  it('never carries the typed value, even when the error did', () => {
    const failure = inputFailure(new Error(`could not type ${FAKE_VALUE}`));
    expect(failure.text).not.toContain(FAKE_VALUE);
  });
});
