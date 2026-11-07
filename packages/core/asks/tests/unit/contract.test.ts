import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AskAnswerSchema, AskDraftSchema, AskIdSchema, AskSourceSchema } from '../../contract/index.ts';
import { askSourceConformance, asksConformance, FakeAsks } from '../../contract/testing/index.ts';

asksConformance('FakeAsks', () => {
  const asks = new FakeAsks();
  return {
    asks: {
      raise: asks.raise.bind(asks),
      notify: asks.notify.bind(asks),
      answers: asks.answers.bind(asks),
      close: asks.close.bind(asks),
      open: asks.open.bind(asks),
      get: asks.get.bind(asks),
    },
    answer: (id, effect) => asks.answerAs(id, effect),
  };
});

const CardRefSchema = z.strictObject({ card: z.string().regex(/^F[1-9][0-9]*$/u), lane: z.string().min(1) });

askSourceConformance(
  'a card-shaped source',
  { schema: CardRefSchema, title: 'Card {card}', form: false },
  {
    valid: [{ card: 'F12', lane: 'try' }],
    invalid: [{ card: 'nope', lane: 'try' }, 'string'],
  },
);

describe('the envelope', () => {
  test('ask ids are today’s A-numbers', () => {
    expect(AskIdSchema.safeParse('A12').success).toBe(true);
    expect(AskIdSchema.safeParse('A0').success).toBe(false);
  });
  test('the generic envelope carries an opaque ref', () => {
    expect(
      AskSourceSchema.safeParse({ source: 'card', ref: { card: 'F12', lane: 'try' }, entry: 'gate:F12:try:3' }).success,
    ).toBe(true);
  });
  test('a choice names its options and only a choice does', () => {
    const base = {
      source: 'card',
      ref: {},
      entry: 'e1',
      subject: 'Pick',
      why: 'Because',
      raisedBy: { kind: 'daemon' },
    };
    expect(
      AskDraftSchema.safeParse({ ...base, kind: 'choice', options: [{ label: 'A' }, { label: 'B' }] }).success,
    ).toBe(true);
    expect(
      AskDraftSchema.safeParse({ ...base, kind: 'yesno', options: [{ label: 'A' }, { label: 'B' }] }).success,
    ).toBe(false);
    expect(
      AskDraftSchema.safeParse({ ...base, kind: 'choice', options: [{ label: 'A' }, { label: 'A' }] }).success,
    ).toBe(false);
  });
  test('only the owner answers: a ferret is not an answerer', () => {
    const answer = {
      id: 'an_0123456789abcdef01234567',
      ask: 'A1',
      source: 'card',
      entry: 'e1',
      effect: 'approve',
      at: '2026-11-07T12:00:00.000Z',
    };
    expect(AskAnswerSchema.safeParse({ ...answer, by: { kind: 'host' } }).success).toBe(true);
    expect(AskAnswerSchema.safeParse({ ...answer, by: { kind: 'ferret', ferret: 'f1' } }).success).toBe(false);
  });
});
