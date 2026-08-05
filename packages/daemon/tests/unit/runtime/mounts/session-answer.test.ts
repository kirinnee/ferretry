import { describe, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
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
    return sessionView(id);
  }
}

const headers = { ...human, [FY_REQUEST_ID_HEADER]: 'answer-1' };
const dispatcher = (subsystem = new FakeAnswers()) =>
  new ApiDispatcher(new ApiRouter(sessionAnswerRoutes(subsystem)), CREDENTIALS);

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
});
