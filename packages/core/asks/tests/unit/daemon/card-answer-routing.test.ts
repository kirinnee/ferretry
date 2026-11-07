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
