import { describe, it } from 'bun:test';
import {
  FY_REQUEST_ID_HEADER,
  RestartCancelResultSchema,
  RestartResultSchema,
  RestartStatusSchema,
  type RestartRequest,
} from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  type SessionRestartSubsystem,
  sessionRestartRoutes,
} from '../../../../src/lib/runtime/mounts/session-restart.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, human } from './support.ts';

class FakeRestart implements SessionRestartSubsystem {
  readonly calls: Array<readonly [RestartRequest, string | undefined]> = [];
  async restart(body: RestartRequest, requestId?: string) {
    this.calls.push([body, requestId]);
    return { restarted: [{ id: 'a' }], queued: [{ id: 'b', reason: 'mid-turn' as const }], skipped: [], failed: [] };
  }
  async status() {
    return { outdated: [{ id: 'a', sections: ['pack' as const] }], queued: [] };
  }
  async cancel() {
    return { cancelled: 2 };
  }
  async drain() {}
}

const dispatch = (
  subsystem: SessionRestartSubsystem,
  method: 'GET' | 'POST' | 'DELETE',
  headers: Record<string, string> = human,
  body?: string,
) =>
  new ApiDispatcher(new ApiRouter(sessionRestartRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD).dispatch(
    request({ method, path: '/v1/restarts', headers, ...(body === undefined ? {} : { body }) }),
  );

describe('the restart mount', () => {
  it('should mount three operator-only, uncached routes', () => {
    const routes = sessionRestartRoutes(new FakeRestart());
    should(routes.map(route => route.method)).deepEqual(['POST', 'GET', 'DELETE']);
    should(routes.every(route => route.minimum === 'operator' && route.noStore === true)).be.true();
  });

  it('should restart by the parsed request and pass the request id along', async () => {
    const subsystem = new FakeRestart();
    const answer = await dispatch(
      subsystem,
      'POST',
      { ...human, [FY_REQUEST_ID_HEADER]: ' r-1 ' },
      '{"scope":"outdated"}',
    );
    should(answer.status).equal(200);
    should(RestartResultSchema.parse(JSON.parse(answer.body)).queued).have.length(1);
    should(subsystem.calls).eql([[{ scope: 'outdated' }, 'r-1']]);
  });

  it('should run without a request id', async () => {
    const subsystem = new FakeRestart();
    await dispatch(subsystem, 'POST', human, '{"scope":"all"}');
    await dispatch(subsystem, 'POST', { ...human, [FY_REQUEST_ID_HEADER]: '  ' }, '{"scope":"all"}');
    should(subsystem.calls.map(call => call[1])).eql([undefined, undefined]);
  });

  it('should refuse a request that does not parse', async () => {
    const answer = await dispatch(new FakeRestart(), 'POST', human, '{"scope":"ids"}');
    should(answer.status).equal(400);
  });

  it('should read the status and clear the queue', async () => {
    const subsystem = new FakeRestart();
    should(RestartStatusSchema.parse(JSON.parse((await dispatch(subsystem, 'GET')).body)).outdated).have.length(1);
    should(RestartCancelResultSchema.parse(JSON.parse((await dispatch(subsystem, 'DELETE')).body)).cancelled).equal(2);
  });
});
