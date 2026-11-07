import { expect, it } from 'bun:test';
import { deviceStanding } from '@ferretry/core-gate/contract/testing';
import type { AskDraft } from '../../../contract/index.ts';
import { asksHalf } from '../../support/daemon/asks-half.ts';

const POST = 'POST /v1/ferrets/:ferretId/agenda';
const draft: AskDraft = {
  source: 'card',
  entry: 'release1',
  ref: {},
  kind: 'yesno',
  subject: 'Release?',
  why: 'Ready',
  raisedBy: { kind: 'daemon' },
  ferret: 'f1',
};

it('checks the device board grant before applying a generic card-source answer', async () => {
  let applies = 0;
  const half = await asksHalf({
    'ask.sources:card': {
      schema: { parse: (value: unknown) => value },
      title: 'Card',
      form: false,
      apply: async () => {
        applies++;
        return 'applied';
      },
    },
  });
  try {
    const ref = await half.asks.raise(draft);
    const standing = {
      ...deviceStanding('phone'),
      governance: {
        governed: true,
        decide: () => ({ allowed: false as const, refusal: 'device-not-granted' as const }),
      },
    };
    const answered = await half.call(
      POST,
      { ferretId: 'f1' },
      { action: 'resolve', id: ref.id, response: { kind: 'multiple-choice', choice: 'Yes' } },
      standing,
    );
    expect(answered.status).toBe(403);
    expect(applies).toBe(0);
    expect(await half.asks.get(ref)).toMatchObject({ state: 'open' });
  } finally {
    await half.close();
  }
});

it('rejects an invalid attachment target before the source or ledger can change', async () => {
  let applies = 0;
  const half = await asksHalf({
    'ask.sources:card': {
      schema: { parse: (value: unknown) => value },
      title: 'Card',
      form: false,
      apply: async () => {
        applies++;
        return 'applied';
      },
    },
  });
  try {
    const ref = await half.asks.raise(draft);
    const answered = await half.call(
      POST,
      { ferretId: 'f1' },
      {
        action: 'resolve',
        id: ref.id,
        response: { kind: 'multiple-choice', choice: 'Yes' },
        attachments: { from: 'f1', ids: [`att_${'a'.repeat(64)}`] },
      },
    );
    expect(answered.status).toBe(400);
    expect(applies).toBe(0);
    expect(await half.asks.get(ref)).toMatchObject({ state: 'open' });
  } finally {
    await half.close();
  }
});
