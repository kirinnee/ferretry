import { describe, expect, it } from 'bun:test';
import { asksHalf } from '../../support/daemon/asks-half.ts';
import type { AskAnswer, AskDraft } from '../../../contract/index.ts';

const POST = 'POST /v1/ferrets/:ferretId/agenda';
const draft: AskDraft = {
  source: 'card',
  entry: 'entry1',
  ref: { card: 'F12' },
  kind: 'yesno',
  subject: 'Approve this?',
  why: 'Ready',
  raisedBy: { kind: 'daemon' },
  ferret: 'f1',
};
const response = { kind: 'multiple-choice', choice: 'Yes' };

describe('source-raised answers', () => {
  it('requires source application for an unflagged bare resolve too', async () => {
    let applies = 0;
    const half = await asksHalf({
      'ask.sources:card': {
        schema: { parse: (value: unknown) => value },
        title: 'Card',
        form: false,
        apply: async () => {
          applies++;
          return { refused: 'card must not move' };
        },
      },
    });
    try {
      const ref = await half.asks.raise(draft);
      expect((await half.call(POST, { ferretId: 'f1' }, { action: 'resolve', id: ref.id })).status).toBe(409);
      expect(applies).toBe(1);
      expect(await half.asks.get(ref)).toMatchObject({ state: 'open' });
      expect(await half.asks.answers({ source: 'card' as never })).toEqual([]);
    } finally {
      await half.close();
    }
  });

  it('retains deferred reconciliation for non-card sources without apply', async () => {
    const half = await asksHalf({
      'ask.sources:example': { schema: { parse: (value: unknown) => value }, title: 'Example', form: false },
    });
    try {
      const ref = await half.asks.raise({ ...draft, source: 'example' });
      expect((await half.call(POST, { ferretId: 'f1' }, { action: 'resolve', id: ref.id, response })).status).toBe(200);
      expect(await half.asks.answers({ source: 'example' as never })).toHaveLength(1);
    } finally {
      await half.close();
    }
  });

  it('leaves card obligations open when the source has no apply', async () => {
    const half = await asksHalf({
      'ask.sources:card': { schema: { parse: (value: unknown) => value }, title: 'Card', form: false },
    });
    try {
      const ref = await half.asks.raise(draft);
      expect((await half.call(POST, { ferretId: 'f1' }, { action: 'resolve', id: ref.id, response })).status).toBe(409);
      expect(await half.asks.get(ref)).toMatchObject({ state: 'open' });
      expect(await half.asks.answers({ source: 'card' as never })).toEqual([]);
    } finally {
      await half.close();
    }
  });

  it('applies the generic source before recording, using the durable answer id', async () => {
    const applied: AskAnswer[] = [];
    let half: Awaited<ReturnType<typeof asksHalf>>;
    half = await asksHalf({
      'ask.sources:card': {
        schema: { parse: (value: unknown) => value },
        title: 'Card',
        form: false,
        apply: async (answer: AskAnswer) => {
          expect(await half.asks.answers({ source: 'card' as never })).toEqual([]);
          applied.push(answer);
          return 'applied';
        },
      },
    });
    try {
      const ref = await half.asks.raise(draft);
      expect((await half.call(POST, { ferretId: 'f1' }, { action: 'resolve', id: ref.id, response })).status).toBe(200);
      expect(applied).toHaveLength(1);
      expect(await half.asks.answers({ source: 'card' as never })).toMatchObject([{ id: applied[0]?.id }]);
      expect(half.events.find(event => event.name === 'asks.answered')?.payload).toMatchObject({
        answerId: applied[0]?.id,
        source: 'card',
        entry: 'entry1',
      });
    } finally {
      await half.close();
    }
  });

  it('leaves source asks open on refusal or unavailable providers', async () => {
    const providers: Record<string, unknown> = {
      'ask.sources:card': {
        schema: { parse: (value: unknown) => value },
        title: 'Card',
        form: false,
        apply: async () => ({ refused: 'the card cannot move' }),
      },
    };
    const half = await asksHalf(providers);
    try {
      const ref = await half.asks.raise(draft);
      for (const unavailable of [false, true]) {
        if (unavailable) delete providers['ask.sources:card'];
        expect((await half.call(POST, { ferretId: 'f1' }, { action: 'resolve', id: ref.id, response })).status).toBe(
          409,
        );
        expect(await half.asks.get(ref)).toMatchObject({ state: 'open' });
        expect(await half.asks.answers({ source: 'card' as never })).toEqual([]);
      }
    } finally {
      await half.close();
    }
  });
});
