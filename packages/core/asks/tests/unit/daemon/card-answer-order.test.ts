import { expect, it } from 'bun:test';
import { cardAnswers, reference } from '../../support/daemon/card-answers.ts';
import { askedCardAsks } from '../../../daemon/lib/protocol/agenda-card-asks.ts';

it('sends an unnamed marked answer to askedCardAsks order after Not yet', async () => {
  const board = await cardAnswers();
  const first = (await board.item())?.cardAsks?.[0];
  if (first === undefined) throw new Error('missing fixture ask');
  await board.agenda.cardAsk('s1', 'A1', { kind: 'attach', ask: { gate: { ...first.gate, cardId: 'F13' } } });
  await board.agenda.cardAsk('s1', 'A1', { kind: 'not-yet', reference: reference() });
  const item = await board.item();
  expect(askedCardAsks(item ?? {}).map(ask => ask.gate.cardId)).toEqual(['F13', 'F12']);
  expect((await board.post({ gate: true, response: { kind: 'multiple-choice', choice: 'Done' } })).status).toBe(200);
  expect(board.applied).toMatchObject([{ entry: reference('F13') }]);
});
