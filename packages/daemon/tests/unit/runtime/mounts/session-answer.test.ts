import { describe, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  SessionAnswerError,
  type SessionAnswerSubsystem,
  sessionAnswerRoutes,
} from '../../../../src/lib/runtime/mounts/session-answer.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, human, sessionView } from './support.ts';

class FakeAnswers implements SessionAnswerSubsystem {
  readonly calls: Array<readonly [string, Parameters<SessionAnswerSubsystem['answer']>[1]]> = [];

  async answer(id: string, input: Parameters<SessionAnswerSubsystem['answer']>[1]) {
    this.calls.push([id, input]);
    if (id === 'missing') throw new SessionAnswerError('not_found', 'not found');
    if (id === 'refused') throw new SessionAnswerError('refused', 'form changed');
    if (id === 'reused')
      throw new SessionAnswerError(
        'conflict',
        'a different answer was already sent',
        undefined,
        'raw idempotency text',
      );
    if (id === 'answered')
      throw new SessionAnswerError(
        'already_answered',
        'This question was already answered with «Yes».',
        'Yes',
        'request id was already used',
      );
    if (id === 'unconfirmed') throw new SessionAnswerError('unconfirmed', 'an earlier attempt may have landed');
    if (id === 'released') throw new SessionAnswerError('released', 'the form was released; inspect the terminal');
    if (id === 'undelivered')
      throw new SessionAnswerError('unconfirmed', "Couldn't answer automatically.", undefined, 'driver evidence');
    if (id === 'undelivered-released')
      throw new SessionAnswerError('released', "Couldn't answer automatically.", undefined, 'released evidence');
    if (id === 'paused')
      throw new SessionAnswerError('paused', 'Stopped at question 3 of 4.', undefined, 'paused evidence', {
        stoppedAt: 2,
        answered: [true, true, false, false],
      });
    if (id === 'paused-bare') throw new SessionAnswerError('paused', 'Stopped.');
    if (id === 'undelivered-failed')
      throw new SessionAnswerError('failed', "Couldn't answer automatically.", undefined, 'failed evidence');
    return sessionView(id);
  }
}

const headers = { ...human, [FY_REQUEST_ID_HEADER]: 'answer-1' };
const dispatcher = (subsystem = new FakeAnswers()) =>
  new ApiDispatcher(new ApiRouter(sessionAnswerRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

describe('the session answer mount', () => {
  it('passes the lossless structured payload and requires an idempotency key', async () => {
    const answers = new FakeAnswers();
    const response = await dispatcher(answers).dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/answer',
        headers,
        body: JSON.stringify({
          toolUseId: 'tool-1',
          labels: [],
          answers: [
            { kind: 'selection', labels: ['one', 'two'] },
            { kind: 'other', text: 'explain it' },
          ],
        }),
      }),
    );

    should(response.status).equal(200);
    SessionViewSchema.parse(JSON.parse(response.body));
    should(answers.calls[0]?.[0]).equal('s1');
    should(answers.calls[0]?.[1]).match({
      toolUseId: 'tool-1',
      requestId: 'answer-1',
      answers: [
        { kind: 'selection', labels: ['one', 'two'] },
        { kind: 'other', text: 'explain it' },
      ],
    });
  });

  it('refuses malformed payloads and reports a form refusal distinctly', async () => {
    const subject = dispatcher();
    const malformed = await subject.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/answer',
        headers,
        body: JSON.stringify({ toolUseId: 'tool-1' }),
      }),
    );
    const refused = await subject.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/refused/answer',
        headers: { ...headers, [FY_REQUEST_ID_HEADER]: 'answer-2' },
        body: JSON.stringify({ toolUseId: 'tool-1', labels: ['one'] }),
      }),
    );

    should(malformed.status).equal(400);
    should(refused.status).equal(409);
    should((JSON.parse(refused.body) as { code: string }).code).equal('answer_refused');
  });

  it('keeps the idempotency explanation out of the sentence and in detail, and names the delivered answer', async () => {
    const subject = dispatcher();
    const post = async (session: string) =>
      JSON.parse(
        (
          await subject.dispatch(
            request({
              method: 'POST',
              path: `/v1/sessions/${session}/answer`,
              headers,
              body: JSON.stringify({ toolUseId: 'tool-1', labels: ['one'] }),
            }),
          )
        ).body,
      ) as Record<string, unknown>;

    const reused = await post('reused');
    const answered = await post('answered');

    should(reused).match({
      code: 'answer_request_id_reused',
      error: 'a different answer was already sent',
      detail: 'raw idempotency text',
    });
    should(answered).match({
      code: 'question_already_answered',
      error: 'This question was already answered with «Yes».',
      answeredWith: 'Yes',
      detail: 'request id was already used',
    });
  });

  it.each([
    ['undelivered', 409, 'answer_unconfirmed', 'driver evidence'],
    ['undelivered-released', 409, 'answer_released', 'released evidence'],
    ['undelivered-failed', 500, 'session_answer_failed', 'failed evidence'],
  ] as const)(
    'carries the driver evidence for an undelivered answer as detail, never as the sentence (%s)',
    async (session, status, code, detail) => {
      const actual = await dispatcher().dispatch(
        request({
          method: 'POST',
          path: `/v1/sessions/${session}/answer`,
          headers,
          body: JSON.stringify({ toolUseId: 'tool-1', labels: ['one'] }),
        }),
      );

      should(actual.status).equal(status);
      should(JSON.parse(actual.body)).match({ code, error: "Couldn't answer automatically.", detail });
    },
  );

  it('says where a paused drive stopped and which questions are answered, so the app can offer to resume', async () => {
    const answer = async (session: string) =>
      await dispatcher().dispatch(
        request({
          method: 'POST',
          path: `/v1/sessions/${session}/answer`,
          headers,
          body: JSON.stringify({ toolUseId: 'tool-1', labels: ['one'] }),
        }),
      );

    const paused = await answer('paused');
    const bare = await answer('paused-bare');

    should(paused.status).equal(409);
    should(JSON.parse(paused.body)).match({
      code: 'answer_paused',
      error: 'Stopped at question 3 of 4.',
      detail: 'paused evidence',
      stoppedAt: 2,
      answered: [true, true, false, false],
    });
    should(JSON.parse(bare.body)).not.have.properties('stoppedAt', 'answered', 'detail');
  });

  it.each([
    ['reused', 'answer_request_id_reused'],
    ['answered', 'question_already_answered'],
    ['unconfirmed', 'answer_unconfirmed'],
    ['released', 'answer_released'],
  ])('keeps each 409 distinct, because each names a different next action (%s)', async (session, expected) => {
    // Arrange
    const subject = dispatcher();

    // Act
    const actual = await subject.dispatch(
      request({
        method: 'POST',
        path: `/v1/sessions/${session}/answer`,
        headers,
        body: JSON.stringify({ toolUseId: 'tool-1', labels: ['one'] }),
      }),
    );

    // Assert
    should(actual.status).equal(409);
    should((JSON.parse(actual.body) as { code: string }).code).equal(expected);
  });
});
