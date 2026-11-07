import { describe, it } from 'bun:test';
import type { ApiRequest, ApiResponse, CallStanding } from '@ferretry/kernel/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { owner, testArrival } from '@ferretry/kernel/testing';
import should from 'should';
import { type AgendaAgentClearer, agendaClearRoutes } from '../../../../daemon/lib/routes/agenda-clear.ts';
import { agentIn, ferretOwn, human, jsonBody, routeDispatcher } from './support.ts';

function fixture() {
  const calls: string[] = [];
  const clearer: AgendaAgentClearer = {
    preview: async () => {
      calls.push('preview');
      return { cleared: 4, sessions: 2 };
    },
    clear: async actor => {
      calls.push(`clear:${actor.kind}`);
      return { cleared: 4, sessions: 2 };
    },
  };
  const dispatch = routeDispatcher(agendaClearRoutes(clearer));
  const post = async (body: unknown, headers: CallStanding = human): Promise<ApiResponse> =>
    await dispatch({ method: 'POST', path: '/v1/agenda/clear-agents', headers, body: JSON.stringify(body) });
  return { calls, post };
}

describe('POST /v1/agenda/clear-agents', () => {
  it('should clear as the owner and report how many items and sessions went', async () => {
    // Arrange
    const { calls, post } = fixture();

    // Act
    const response = await post({});

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ cleared: 4, sessions: 2 });
    should(calls).deepEqual(['clear:human']);
  });

  it('should only count on a dry run', async () => {
    // Arrange
    const { calls, post } = fixture();

    // Act
    const response = await post({ dryRun: true });

    // Assert
    should(jsonBody(response)).deepEqual({ cleared: 4, sessions: 2 });
    should(calls).deepEqual(['preview']);
  });

  it('should refuse a ferret’s credential and clear nothing', async () => {
    // Arrange
    const { calls, post } = fixture();

    // Act
    const response = await post({}, agentIn('s1'));

    // Assert
    should([response.status, jsonBody(response).code]).deepEqual([403, 'owner_only']);
    should(calls).deepEqual([]);
  });

  it('should refuse a body with unknown fields', async () => {
    // Arrange
    const { calls, post } = fixture();

    // Act
    const response = await post({ everything: true });

    // Assert
    should(response.status).equal(400);
    should(calls).deepEqual([]);
  });

  it('should answer 503 when no clearer is wired, and clear nothing', async () => {
    // Arrange
    const dispatch = routeDispatcher(agendaClearRoutes(undefined));

    // Act
    const response = await dispatch({ method: 'POST', path: '/v1/agenda/clear-agents', headers: human, body: '{}' });

    // Assert
    should([response.status, jsonBody(response).code]).deepEqual([503, 'unavailable']);
  });
});

describe('the handler’s own second line', () => {
  it('should still refuse a ferret’s own credential if the boundary ever let one through', async () => {
    // Arrange — the route is `caller: 'person'`; this proves the handler would refuse a ferret on its own.
    const handle = agendaClearRoutes({
      preview: async () => ({ cleared: 0, sessions: 0 }),
      clear: async () => ({ cleared: 0, sessions: 0 }),
    })['POST /v1/agenda/clear-agents'];
    const request: ApiRequest = {
      method: 'POST',
      path: '/v1/agenda/clear-agents',
      query: new Map(),
      headers: new Map(),
      arrival: testArrival(owner()),
      text: async () => '{}',
    };

    // Act
    const answer = await handle({ request, params: new Map(), ...ferretOwn }).then(
      () => ({ status: 200, code: undefined }),
      (error: ApiError) => ({ status: error.status, code: error.code }),
    );

    // Assert
    should([answer.status, answer.code]).deepEqual([403, 'forbidden']);
  });
});
