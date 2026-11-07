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

for (const target of [{ gate: true }, { cardAsk: 'gate:F12:to-test:3' }]) {
  for (const response of [undefined, { kind: 'multiple-choice', choice: 'Yes' }]) {
    it(`refuses a source obligation addressed as ${Object.keys(target)[0]} with ${response === undefined ? 'no' : 'an'} answer`, async () => {
      let applies = 0;
      const half = await asksHalf({
        'ask.sources:card': {
          schema: { parse: (value: unknown) => value },
          title: 'Card',
          form: false,
          apply: async () => {
            applies++;
            return { refused: 'the card must not move' };
          },
        },
      });
      try {
        const ref = await half.asks.raise(draft);
        const body = { action: 'resolve', id: ref.id, ...target, ...(response === undefined ? {} : { response }) };
        const standing = {
          ...deviceStanding('phone'),
          governance: {
            governed: true,
            decide: () => ({ allowed: false as const, refusal: 'device-not-granted' as const }),
          },
        };
        expect((await half.call(POST, { ferretId: 'f1' }, body, standing)).status).toBe(403);
        expect((await half.call(POST, { ferretId: 'f1' }, body)).status).toBe(400);
        expect(applies).toBe(0);
        expect(await half.asks.get(ref)).toMatchObject({ state: 'open' });
        expect(await half.asks.answers({ source: 'card' as never })).toEqual([]);
      } finally {
        await half.close();
      }
    });
  }
}

it('checks the device board grant before dismissing a persisted card-source obligation', async () => {
  const half = await asksHalf({
    'ask.sources:card': { schema: { parse: (value: unknown) => value }, title: 'Card', form: false },
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
    expect((await half.call(POST, { ferretId: 'f1' }, { action: 'dismiss', id: ref.id }, standing)).status).toBe(403);
    expect(await half.asks.get(ref)).toMatchObject({ state: 'open' });
    expect(await half.asks.answers({ source: 'card' as never })).toEqual([]);
    expect((await half.call(POST, { ferretId: 'f1' }, { action: 'dismiss', id: ref.id })).status).toBe(200);
  } finally {
    await half.close();
  }
});
