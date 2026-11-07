import { expect, it } from 'bun:test';
import { cardAnswers, reference } from '../../support/daemon/card-answers.ts';

it('replays an explicit answered card ask by receipt without answering the item itself', async () => {
  const board = await cardAnswers();
  const answer = { cardAsk: reference(), response: { kind: 'multiple-choice', choice: 'Done' } };
  expect((await board.post(answer)).status).toBe(200);
  expect((await board.post(answer)).status).toBe(200);
  expect(board.applied).toHaveLength(1);
  expect((await board.item())?.ownerAnswer).toBeUndefined();
  expect((await board.item())?.cardAsks?.[0]?.answer?.receipt).toBeDefined();
});

it('refuses named missing and already answered asks without falling through to the item', async () => {
  const board = await cardAnswers();
  expect(
    (await board.post({ cardAsk: reference('F99'), response: { kind: 'open-question', answer: 'main' } })).status,
  ).toBe(409);
  expect((await board.item())?.ownerAnswer).toBeUndefined();
  await board.post({ cardAsk: reference(), response: { kind: 'multiple-choice', choice: 'Done' } });
  expect((await board.post({ cardAsk: reference(), response: { kind: 'other', answer: 'Actually no' } })).status).toBe(
    409,
  );
  expect(board.applied).toHaveLength(1);
});
