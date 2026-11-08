import { describe, expect, it } from 'bun:test';
import type { Question } from '../../../../contract/index.ts';
import {
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
