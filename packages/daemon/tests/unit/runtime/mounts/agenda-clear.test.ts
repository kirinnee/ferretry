import { describe, it } from 'bun:test';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import { AgendaAgentClearer } from '../../../../src/lib/agenda/index.ts';
import { agendaClearRoutes } from '../../../../src/lib/runtime/mounts/agenda-clear.ts';
import should from 'should';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, human } from './support.ts';

function fixture() {
  const calls: string[] = [];
  const clearer = new AgendaAgentClearer(
    { agentSessionIds: async () => ['w1'] },
    { read: async () => null },
    { dismiss: async () => ({ ok: true, changed: true }) as never },
  );
  clearer.preview = async () => {
    calls.push('preview');
    return { cleared: 4, sessions: 2 };
  };
  clearer.clear = async actor => {
    calls.push(`clear:${actor.kind}`);
    return { cleared: 4, sessions: 2 };
  };
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...agendaClearRoutes(clearer)]),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
  const post = async (body: unknown, headers: Readonly<Record<string, string>> = human): Promise<ApiResponse> =>
    await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/agenda/clear-agents', headers, body: JSON.stringify(body) }),
    );
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
    should(response.status).equal(403);
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
});
