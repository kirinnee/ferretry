import { expect, it } from 'bun:test';
import { cardAnswers, reference } from '../../support/daemon/card-answers.ts';

it('keeps an unnamed plain reply on the item and leaves its attached card ask open', async () => {
  const board = await cardAnswers();
  expect((await board.post({ response: { kind: 'open-question', answer: 'Use main please' } })).status).toBe(200);
  expect(board.applied).toEqual([]);
  expect((await board.item())?.ownerAnswer?.response).toEqual({ kind: 'open-question', answer: 'Use main please' });
  expect((await board.item())?.cardAsks?.[0]?.answer).toBeUndefined();
});

it('preserves typed card-answer text and refuses a reopen without words', async () => {
  const board = await cardAnswers();
  expect(
    (await board.post({ cardAsk: reference(), response: { kind: 'multiple-choice', choice: 'Not good' } })).status,
  ).toBe(400);
  expect(board.applied).toEqual([]);
  expect(
    (
      await board.post({
        cardAsk: reference(),
        response: { kind: 'other', answer: 'The badge is still blue' },
        note: 'On mobile',
      })
    ).status,
  ).toBe(200);
  expect(board.applied).toMatchObject([{ text: 'The badge is still blue\n\nOn mobile' }]);
  expect((await board.item())?.ownerAnswer).toBeUndefined();
});

it('routes an explicitly marked unnamed button to the displayed card ask', async () => {
  const board = await cardAnswers();
  expect((await board.post({ gate: true, response: { kind: 'multiple-choice', choice: 'Done' } })).status).toBe(200);
  expect(board.applied).toMatchObject([{ entry: reference() }]);
});

for (const target of [{ gate: true }, { cardAsk: reference() }]) {
  it(`refuses an attached ${Object.keys(target)[0]} target without a response`, async () => {
    const board = await cardAnswers();
    expect((await board.post(target)).status).toBe(400);
    expect(board.applied).toEqual([]);
    expect((await board.item())?.cardAsks?.[0]?.answer).toBeUndefined();
    expect((await board.item())?.ownerAnswer).toBeUndefined();
  });
}

for (const [choice, from] of [
  ['Done', 's1'],
  ['Not good', 'another'],
  ['Not good', 's1'],
]) {
  it(`refuses attached card files for ${choice} from ${from} before applying or recording`, async () => {
    const board = await cardAnswers();
    expect(
      (
        await board.post({
          cardAsk: reference(),
          response: { kind: 'multiple-choice', choice },
          note: 'The badge needs fixing',
          attachments: { from, ids: [`att_${'a'.repeat(64)}`] },
        })
      ).status,
    ).toBe(400);
    expect(board.applied).toEqual([]);
    expect((await board.item())?.cardAsks?.[0]?.answer).toBeUndefined();
  });
}

it('refuses new files on a replay of an attached card answer', async () => {
  const board = await cardAnswers();
  const answer = {
    cardAsk: reference(),
    response: { kind: 'multiple-choice', choice: 'Not good' },
    note: 'Fix the badge',
  };
  expect((await board.post(answer)).status).toBe(200);
  expect((await board.post({ ...answer, attachments: { from: 's1', ids: [`att_${'a'.repeat(64)}`] } })).status).toBe(
    400,
  );
  expect(board.applied).toHaveLength(1);
});
