import { describe, expect, it } from 'bun:test';
import type { Question } from '../../../../contract/index.ts';
import {
  SessionAnswerError,
  type SessionAnswerSubsystem,
  sessionAnswerRoutes,
} from '../../../../daemon/questions/lib/mounts/session-answer.ts';
import { answerOf, refusalOf } from '../../../support/mount-call.ts';

const QUESTION = '/v1/ferrets/:ferretId/question';
const ANSWER = '/v1/ferrets/:ferretId/answer';
const ID = { ferretId: 'f1' };

const build = (question?: Question) => {
  const answered: unknown[][] = [];
  const subsystem: SessionAnswerSubsystem = {
    question: async () => question,
    answer: async (...args) => {
      answered.push(args);
      return { id: 'f1' } as never;
    },
  };
  return { routes: sessionAnswerRoutes(subsystem), answered };
};

describe('GET question', () => {
  it('answers the question the ferret is waiting on, or null', async () => {
    const question = {
      format: 1,
      toolUseId: 't1',
      text: 'Which?',
      options: [{ label: 'A' }],
      multiple: false,
      askedAt: '2026-11-07T12:00:00.000Z',
    } as unknown as Question;
    expect((await answerOf(build(question).routes, 'GET', QUESTION, { params: ID })).json).toEqual({ question });
    expect((await answerOf(build().routes, 'GET', QUESTION, { params: ID })).json).toEqual({ question: null });
  });

  it('refuses a path that is not a usable session id', async () => {
    const refusal = await refusalOf(build().routes, 'GET', QUESTION, { params: { ferretId: '' } });
    expect(refusal.status).toBe(400);
    expect(refusal.code).toBe('invalid_session_id');
  });
});

describe('POST answer', () => {
  it('hands the answer over with the caller’s own request id, and answers the session’s view', async () => {
    const { routes, answered } = build();
    const answer = await answerOf(routes, 'POST', ANSWER, {
      params: ID,
      headers: { 'x-fy-request-id': ' req-1 ' },
      body: {
        toolUseId: 't1',
        labels: ['A'],
        other: 'more',
        responses: ['r'],
        answers: [{ kind: 'selection', labels: ['A'] }],
      },
    });
    expect(answer).toEqual({ status: 200, json: { id: 'f1' } });
    expect(answered[0]?.[0]).toBe('f1');
    expect(answered[0]?.[1]).toMatchObject({
      toolUseId: 't1',
      labels: ['A'],
      other: 'more',
      responses: ['r'],
      requestId: 'req-1',
    });
  });

  it('sends only the fields the caller gave', async () => {
    const { routes, answered } = build();
    await answerOf(routes, 'POST', ANSWER, {
      params: ID,
      headers: { 'x-fy-request-id': 'req-1' },
      body: { toolUseId: 't1', labels: ['A'] },
    });
    expect(answered[0]?.[1]).toEqual({ toolUseId: 't1', labels: ['A'], requestId: 'req-1' });
  });

  it('refuses an answer without a request id, and a bad body', async () => {
    const { routes } = build();
    const missing = await refusalOf(routes, 'POST', ANSWER, { params: ID, body: { toolUseId: 't1', labels: [] } });
    expect(missing.code).toBe('missing_request_id');
    const bad = await refusalOf(routes, 'POST', ANSWER, {
      params: ID,
      headers: { 'x-fy-request-id': 'r' },
      body: { labels: [] },
    });
    expect(bad.status).toBe(400);
  });
});

describe('POST answer, when it cannot be served', () => {
  const failing = (error: unknown) =>
    sessionAnswerRoutes({
      question: async () => undefined,
      answer: async () => {
        throw error;
      },
    });
  const post = (routes: ReturnType<typeof failing>, extra: { actor?: string } = {}) =>
    refusalOf(routes, 'POST', ANSWER, {
      params: ID,
      headers: { 'x-fy-request-id': 'req-1' },
      body: { toolUseId: 't1', labels: ['A'] },
      ...extra,
    });

  it.each([
    ['invalid', 400, 'invalid_request'],
    ['not_found', 404, 'not-found'],
    ['refused', 409, 'answer_refused'],
    ['conflict', 409, 'answer_request_id_reused'],
    ['already_answered', 409, 'question_already_answered'],
    ['unconfirmed', 409, 'answer_unconfirmed'],
    ['released', 409, 'answer_released'],
    ['paused', 409, 'answer_paused'],
    ['failed', 500, 'session_answer_failed'],
  ] as const)('answers %s as %i %s', async (failure, status, code) => {
    const refusal = await post(failing(new SessionAnswerError(failure, 'words')));
    expect(refusal.status).toBe(status);
    expect(refusal.code).toBe(code);
    expect(refusal.message).toBe('words');
  });

  it('keeps the detail apart from the sentence, and says what was answered and how far a pause got', async () => {
    const answered = await post(failing(new SessionAnswerError('already_answered', 'done', 'Yes', 'tech')));
    expect(answered.extra).toEqual({ detail: 'tech', answeredWith: 'Yes' });
    const paused = await post(
      failing(
        new SessionAnswerError('paused', 'stopped', undefined, 'tech', { stoppedAt: 1, answered: [true, false] }),
      ),
    );
    expect(paused.extra).toEqual({ detail: 'tech', stoppedAt: 1, answered: [true, false] });
  });

  it('lets any other error through untouched', async () => {
    const boom = new Error('boom');
    expect((await post(failing(boom))) as unknown).toBe(boom);
  });
});
