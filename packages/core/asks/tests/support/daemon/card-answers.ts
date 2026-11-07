import type { AskAnswer } from '../../../contract/index.ts';
import { cardAskAnswers } from '../../../daemon/adapters/card-ask-answers.ts';
import { agendaRoutes } from '../../../daemon/lib/routes/agenda.ts';
import { cardAskReference } from '../../../daemon/lib/protocol/agenda-card-asks.ts';
import { agendaService, routeDispatcher, NO_HELD_REPLIES } from '../../unit/daemon/routes/support.ts';

const gate = (cardId = 'F12') => ({
  cardId,
  laneId: 'to-test',
  laneName: 'To test',
  entry: 3,
  projectId: 'p1',
  options: [
    { id: 'done', label: 'Done', outcome: 'next' as const },
    { id: 'reopen', label: 'Not good', outcome: 'reopen-with-agenda' as const },
  ],
});
export const reference = (cardId = 'F12') => cardAskReference({ gate: gate(cardId) });

export async function cardAnswers() {
  const agenda = agendaService();
  await agenda.raise(
    's1',
    {
      source: 'agent-raised',
      sourceRef: null,
      title: 'Release choice',
      subject: 'Which base branch?',
      context: 'The release waits.',
      premise: 'Choose a base.',
      why: 'There are two options.',
      howToResolve: 'Name one.',
      ask: { kind: 'open-question' },
    },
    { kind: 'agent', sessionId: 's1', name: null },
  );
  await agenda.cardAsk('s1', 'A1', { kind: 'attach', ask: { gate: gate() } });
  const applied: AskAnswer[] = [];
  const source = {
    schema: undefined as never,
    title: 'Card',
    form: false,
    apply: async (answer: AskAnswer) => {
      applied.push(answer);
      return 'applied' as const;
    },
  };
  const dispatch = routeDispatcher(
    agendaRoutes(
      agenda,
      NO_HELD_REPLIES,
      undefined,
      undefined,
      cardAskAnswers(
        agenda,
        () => source,
        () => '2026-11-07T10:00:00.000Z',
      ),
    ),
  );
  return {
    agenda,
    applied,
    post: (extra: object) =>
      dispatch({
        method: 'POST',
        path: '/v1/ferrets/s1/agenda',
        body: JSON.stringify({ action: 'resolve', id: 'A1', ...extra }),
      }),
    item: async () => {
      const result = await agenda.list('s1');
      if (!result.ok) throw new Error(result.error.message);
      return result.value.items[0];
    },
  };
}
