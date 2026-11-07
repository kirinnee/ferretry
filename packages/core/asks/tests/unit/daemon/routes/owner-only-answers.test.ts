/**
 * Who may answer an ask (lead decision, 2026-11-07: today's rule kept). A ferret may answer an ORDINARY ask on its own
 * board. An owner-only ask — an input card, a held configuration change, a task plan, a 2FA seed, a phone approval —
 * is never a ferret's to answer, its own included. No ferret answers an ask on another ferret's board.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { RaiseAgendaRequest } from '../../../../daemon/lib/agenda/index.ts';
import { agendaRoutes } from '../../../../daemon/lib/routes/agenda.ts';
import { agendaService, agentIn, device, jsonBody, NO_HELD_REPLIES, routeDispatcher } from './support.ts';

const ORDINARY = {
  action: 'add',
  title: 'Release unblock',
  subject: 'which base branch?',
  context: 'The work waits on this answer.',
  why: 'the ticket names two',
  premise: 'A ferret needs the owner.',
  howToResolve: 'name the branch to target',
  ask: { kind: 'multiple-choice', options: [{ label: 'main' }, { label: 'develop' }] },
} as const;

const choose = (id: string, choice: string) => ({
  action: 'resolve',
  id,
  response: { kind: 'multiple-choice', choice },
});

/** One board (`s1`) the daemon and the ferret raise on, and the agenda route in front of it. */
function world() {
  const agenda = agendaService();
  const dispatch = routeDispatcher(agendaRoutes(agenda, NO_HELD_REPLIES));
  const post = async (body: unknown, as = agentIn('s1')) =>
    await dispatch({ method: 'POST', path: '/v1/ferrets/s1/agenda', headers: as, body: JSON.stringify(body) });
  return { agenda, post };
}

describe('who answers an ask', () => {
  it("should let a ferret answer an ordinary ask on its own board, as today", async () => {
    // Arrange
    const { post } = world();
    await post(ORDINARY);

    // Act
    const answered = await post(choose('A1', 'main'));

    // Assert
    should(answered.status).equal(200);
  });

  it("should refuse a ferret answering an ask on another ferret's board, and leave it open", async () => {
    // Arrange
    const { agenda, post } = world();
    await post(ORDINARY);

    // Act
    const answered = await post(choose('A1', 'main'), agentIn('ferret-own'));
    const board = await agenda.list('s1');

    // Assert
    should(answered.status).equal(403);
    should(board.ok && board.value.items.map(item => [item.id, item.response])).deepEqual([['A1', undefined]]);
  });

  it('I14 should never let a ferret answer an owner-only input card, its own board included', async () => {
    // Arrange — only the daemon raises an input card (the ferret's own input request).
    const { agenda, post } = world();
    const { ask: _ask, ...plain } = ORDINARY;
    const { action: _action, ...fields } = plain;
    const raised = await agenda.raise(
      's1',
      {
        ...fields,
        source: 'question',
        sourceRef: 'a'.repeat(32),
        kind: 'input',
        title: 'Needs a secret',
        input: { requestId: 'a'.repeat(32) },
      } as RaiseAgendaRequest,
      { kind: 'daemon', cause: 'input-request' },
    );
    should(raised.ok).be.true();

    // Act
    const byFerret = await post({ action: 'resolve', id: 'A1', response: { kind: 'open-question', answer: 'pw' } });
    const byOwner = await post(
      { action: 'resolve', id: 'A1', response: { kind: 'open-question', answer: 'pw' } },
      device('phone'),
    );

    // Assert — never the ferret's; and the owner answers it in its input form, so the value never travels as an
    // agenda answer.
    should([byFerret.status, jsonBody(byFerret).code]).deepEqual([403, 'forbidden']);
    should([byOwner.status, jsonBody(byOwner).code]).deepEqual([400, 'use_input_form']);
  });
});
