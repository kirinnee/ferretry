import { afterEach, describe, expect, it } from 'bun:test';
import { deviceStanding, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';
import {
  type AskAnswer,
  type AskComposerState,
  type AskDelivery,
  AskNotTypedError,
  type AskReceipt,
  type AskRef,
  type AskSourceSpec,
  type EntryId,
  type SourceKey,
} from '../../../contract/index.ts';
import { AGENDA_REPLY_RECHECK_MS, AGENDA_REPLY_SETTLE_MS } from '../../../daemon/lib/agenda/index.ts';
import { asksHalf } from '../../support/daemon/asks-half.ts';

const BOARD = 'POST /v1/ferrets/:ferretId/agenda';
const REPLIES = 'POST /v1/ferrets/:ferretId/agenda/replies';
const F1 = { ferretId: 'f1' };
const halves: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(halves.splice(0).map(async half => await half.close()));
});
async function world(providers: Record<string, unknown> = {}) {
  const half = await asksHalf(providers);
  halves.push(half);
  return half;
}
type Half = Awaited<ReturnType<typeof world>>;

const ask = (half: Half, entry: string, source = 'ferret', kind: 'yesno' | 'task' = 'yesno'): Promise<AskRef> =>
  half.asks.raise({
    source: source as SourceKey,
    ref: {},
    entry: entry as EntryId,
    kind,
    subject: 'Ship it?',
    why: 'The release is ready.',
    raisedBy: { kind: 'ferret', ferret: 'f1' },
    ferret: 'f1',
  });
/** A question the ferret raised itself on its own board: the one whose answers are typed back into it. */
const ferretAsk = async (half: Half): Promise<AskRef> => {
  await half.call(
    BOARD,
    F1,
    {
      action: 'add',
      title: 'Release unblock',
      subject: 'Ship it?',
      why: 'The release is ready.',
      premise: 'A ferret needs the owner.',
      context: 'The work waits on this answer.',
      howToResolve: 'Answer yes or no.',
      ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
    },
    ferretStanding('f1' as FerretId),
  );
  return { ferret: 'f1', id: 'A1' as never };
};
const yes = { kind: 'multiple-choice', choice: 'Yes' } as const;
const answer = (half: Half, id: string, extra: Record<string, unknown> = {}, standing = ownerStanding('ui')) =>
  half.call(BOARD, F1, { action: 'resolve', id, response: yes, ...extra }, standing);

/** A conversation that records what it was asked, and behaves as told. */
function conversation(options: { composer?: AskComposerState; receipt?: AskReceipt; send?: Error } = {}) {
  const sent: { ferret: string; message: string; sendId: string }[] = [];
  const delivery: AskDelivery = {
    send: async (ferret, message, sendId) => {
      if (options.send !== undefined) throw options.send;
      sent.push({ ferret, message, sendId });
    },
    ...(options.composer === undefined ? {} : { composer: async () => options.composer as AskComposerState }),
    ...(options.receipt === undefined ? {} : { receipt: async () => options.receipt as AskReceipt }),
  };
  return { sent, delivery };
}
const providers = (delivery: AskDelivery) => ({ 'ask.delivery:ferret': delivery });

describe('the owner’s answer reaching a ferret through the conversation', () => {
  it('should type the answer into the ferret when the owner sends it now', async () => {
    // Arrange
    const { sent, delivery } = conversation();
    const half = await world(providers(delivery));
    const ref = await ferretAsk(half);
    await answer(half, ref.id);

    // Act
    const response = await half.call(REPLIES, F1, {});

    // Assert
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ ferret: 'f1' });
    expect(sent[0]?.message).toContain('[answer to !A1 «Ship it?»] Yes');
  });

  it('should hold the answer when the conversation says nothing was typed', async () => {
    // Arrange
    const { sent, delivery } = conversation({ send: new AskNotTypedError('the composer holds a draft') });
    const half = await world(providers(delivery));
    const ref = await ferretAsk(half);
    await answer(half, ref.id);

    // Act
    await half.call(REPLIES, F1, {});

    // Assert
    expect(sent).toHaveLength(0);
  });

  it('should type nothing while the composer holds a draft or cannot be read, and type once it is empty', async () => {
    // Arrange
    let composer: AskComposerState = 'occupied';
    const sent: string[] = [];
    const half = await world(
      providers({
        send: async (_ferret, message) => void sent.push(message),
        composer: async () => composer,
      }),
    );
    const ref = await ferretAsk(half);
    await answer(half, ref.id);

    // Act
    await half.clock.advance(AGENDA_REPLY_SETTLE_MS);
    await Bun.sleep(50);
    const whileOccupied = sent.length;
    composer = 'unreadable';
    await half.clock.advance(AGENDA_REPLY_RECHECK_MS);
    await Bun.sleep(50);
    const whileUnreadable = sent.length;
    composer = 'empty';
    await half.clock.advance(AGENDA_REPLY_RECHECK_MS);
    await Bun.sleep(50);

    // Assert
    expect([whileOccupied, whileUnreadable]).toEqual([0, 0]);
    expect(sent).toHaveLength(1);
  });

  it('should keep the answer on its way (held) when nothing can type into a ferret yet', async () => {
    // Arrange
    const half = await world();
    const ref = await ferretAsk(half);
    await answer(half, ref.id);

    // Act
    const response = await half.call(REPLIES, F1, {});

    // Assert
    expect(response.status).toBe(200);
    expect(response.json<{ delivery?: unknown }>().delivery).toEqual({ sending: [ref.id] });
  });

  const proofs: readonly (readonly [string, AskReceipt | undefined, boolean, boolean])[] = [
    ['says it is still pending', { state: 'pending' }, false, true],
    ['says it was delivered', { state: 'delivered' }, false, false],
    ['says it failed', { state: 'failed', reason: 'the ferret was gone' }, false, false],
    ['has no way to say, as long as the conversation is there', undefined, false, false],
    ['cannot be asked because the conversation went away', undefined, true, true],
  ];
  for (const [name, receipt, goneAway, stillSending] of proofs) {
    it(`should ${stillSending ? 'keep counting' : 'stop counting'} the answer as on its way when the transcript ${name}`, async () => {
      // Arrange
      const { delivery } = conversation(receipt === undefined ? {} : { receipt });
      const hooks = providers(delivery);
      const half = await world(hooks);
      const ref = await ferretAsk(half);
      await answer(half, ref.id);
      await half.call(REPLIES, F1, {});
      if (goneAway) delete (hooks as Record<string, unknown>)['ask.delivery:ferret'];

      // Act
      for (let look = 0; look < 4; look += 1) {
        await half.clock.advance(AGENDA_REPLY_RECHECK_MS);
        await Bun.sleep(50);
      }
      const board = (await half.call('GET /v1/ferrets/:ferretId/agenda', F1)).json<{
        delivery?: { sending: string[] };
      }>();

      // Assert
      expect(board.delivery?.sending).toEqual(stillSending ? [ref.id] : undefined);
    });
  }

  it('should hand the answer back to the owner, with the reason, when the send is refused outright', async () => {
    // Arrange
    const { sent, delivery } = conversation({ send: new Error('terminal gone') });
    const half = await world(providers(delivery));
    const ref = await ferretAsk(half);
    await answer(half, ref.id);

    // Act
    await half.call(REPLIES, F1, {});
    await Bun.sleep(50);
    const board = (await half.call('GET /v1/ferrets/:ferretId/agenda', F1)).json<{
      items: { undelivered?: { reason: string } }[];
    }>();

    // Assert
    expect(sent).toHaveLength(0);
    expect(board.items[0]?.undelivered?.reason).toBe('terminal gone');
  });
});

describe('a tell from the Vault joining the ferret’s reply batch', () => {
  it('should go out with the answer as one message, and once per send id', async () => {
    // Arrange
    const { sent, delivery } = conversation();
    const half = await world(providers(delivery));
    const ref = await ferretAsk(half);
    await answer(half, ref.id);

    // Act
    const first = await half.asks.tell?.('f1', 'A3 ended without a value.', 'input-ended');
    const again = await half.asks.tell?.('f1', 'A3 ended without a value.', 'input-ended');
    await half.call(REPLIES, F1, {});

    // Assert
    expect([first, again]).toEqual(['queued', 'known']);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toBe('[answer to !A1 «Ship it?»] Yes\n\nA3 ended without a value.');
  });

  it('should be on the Vault’s view alone', async () => {
    // Arrange
    const half = await world();

    // Assert
    expect(half.asks.tell).toBeDefined();
    expect(half.asksFor('conversation').tell).toBeUndefined();
  });

  it('should refuse a tell for something that is not a ferret, with no text or with a bad send id', async () => {
    // Arrange
    const half = await world();

    // Assert
    await expect(half.asks.tell?.('../escape', 'hi', 'id')).rejects.toThrow('tell: not a ferret id');
    await expect(half.asks.tell?.('f1', '', 'id')).rejects.toThrow('tell: the text is empty or too long');
    await expect(half.asks.tell?.('f1', 'x'.repeat(4_097), 'id')).rejects.toThrow(
      'tell: the text is empty or too long',
    );
    await expect(half.asks.tell?.('f1', 'hi', '')).rejects.toThrow('tell: bad send id');
  });
});

describe('an answer to a question another plugin raised', () => {
  const source = (apply?: AskSourceSpec['apply']): AskSourceSpec => ({
    schema: z.strictObject({}),
    title: 'Question',
    form: false,
    ...(apply === undefined ? {} : { apply }),
  });

  it('should be applied by its source before it is recorded, under the durable answer id', async () => {
    // Arrange
    const applied: AskAnswer[] = [];
    const half = await world({
      'ask.sources:question': source(async answered => {
        applied.push(answered);
        return 'applied';
      }),
    });
    const ref = await ask(half, 'e1', 'question');

    // Act
    const response = await answer(half, ref.id, { note: 'go' }, deviceStanding('phone'));
    const [recorded] = await half.asks.answers({ source: 'question' as SourceKey });

    // Assert
    expect(response.status).toBe(200);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      ferret: 'f1',
      ask: ref.id,
      source: 'question',
      effect: 'choose',
      choice: 'Yes',
    });
    expect(applied[0]?.by).toEqual({ kind: 'device', holder: 'phone' });
    expect(recorded?.id).toBe(applied[0]?.id);
  });

  it('should name the owner at the machine as the host when no device answered', async () => {
    // Arrange
    const applied: AskAnswer[] = [];
    const half = await world({
      'ask.sources:question': source(async answered => {
        applied.push(answered);
        return 'applied';
      }),
    });
    const ref = await ask(half, 'e1', 'question');

    // Act
    await answer(half, ref.id);

    // Assert
    expect(applied[0]?.by).toEqual({ kind: 'host' });
  });

  it('should leave the question open with the source’s sentence when the source refuses', async () => {
    // Arrange
    const half = await world({ 'ask.sources:question': source(async () => ({ refused: 'the board moved on' })) });
    const ref = await ask(half, 'e1', 'question');

    // Act
    const response = await answer(half, ref.id);

    // Assert
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'source_refused', error: 'the board moved on' });
    expect((await half.asks.get(ref))?.state).toBe('open');
  });

  it('should leave the question open when its source is off', async () => {
    // Arrange
    const on = await world({ 'ask.sources:question': source() });
    const ref = await ask(on, 'e1', 'question');
    const off = await asksHalf({}, { home: on.home });
    halves.push(off);

    // Act
    const response = await answer(off, ref.id);

    // Assert
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'source_unavailable' });
    expect((await off.asks.get(ref))?.state).toBe('open');
  });

  it('should record the answer for a source that applies nothing and reconciles later', async () => {
    // Arrange
    const half = await world({ 'ask.sources:question': source() });
    const ref = await ask(half, 'e1', 'question');

    // Act
    const response = await answer(half, ref.id);

    // Assert
    expect(response.status).toBe(200);
    expect((await half.asks.get(ref))?.state).toBe('answered');
  });

  it('should leave a card question open when the board cannot move the card', async () => {
    // Arrange
    const half = await world({ 'ask.sources:card': { ...source(), schema: z.strictObject({}) } });
    const ref = await ask(half, 'e1', 'card');

    // Act
    const response = await answer(half, ref.id);

    // Assert
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'source_unavailable' });
    expect((await half.asks.get(ref))?.state).toBe('open');
  });

  it('should be the owner’s alone to answer, and refuse a card target attached to a source question', async () => {
    // Arrange
    const half = await world({ 'ask.sources:question': source(async () => 'applied') });
    const ref = await ask(half, 'e1', 'question');

    // Act
    const byFerret = await half.call(
      BOARD,
      F1,
      { action: 'resolve', id: ref.id, response: yes },
      ferretStanding('f1' as FerretId),
    );
    const attached = await answer(half, ref.id, { gate: true });
    const named = await answer(half, ref.id, { cardAsk: 'gate:F1:tested:1' });

    // Assert
    expect(byFerret.status).toBe(403);
    expect(attached.status).toBe(400);
    expect(named.status).toBe(400);
    expect((await half.asks.get(ref))?.state).toBe('open');
  });

  it('should leave a ferret’s own questions to the ordinary answer', async () => {
    // Arrange
    const half = await world();
    const ref = await ask(half, 'e1');

    // Act
    const response = await answer(half, ref.id);

    // Assert
    expect(response.status).toBe(200);
    expect((await half.asks.get(ref))?.state).toBe('answered');
  });
});
