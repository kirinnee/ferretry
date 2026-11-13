import { describe, it } from 'bun:test';
import { ferretActor } from '@ferretry/core-gate/contract';
import { deviceStanding, ferretStanding, ownerStanding, wardenStanding } from '@ferretry/core-gate/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import { FY_REQUEST_ID_HEADER } from '../../../../../daemon/lib/protocol/headers.ts';
import {
  RestartCancelResultSchema,
  RestartResultSchema,
  RestartStatusSchema,
  type LaunchOrigin,
  type RestartRequest,
} from '../../../../../contract/index.ts';
import should from 'should';
import {
  type SessionRestartSubsystem,
  sessionRestartRoutes,
} from '../../../../../daemon/lib/runtime/mounts/session-restart.ts';
import { ferretId } from '../../../../../contract/testing/index.ts';
import { jsonOf, requestOf } from '../../support/requests.ts';
import { refusalOf } from '../../support/calls.ts';

class FakeRestart implements SessionRestartSubsystem {
  readonly calls: Array<readonly [RestartRequest, string | undefined]> = [];
  readonly movers: Array<string | undefined> = [];
  readonly origins: LaunchOrigin[] = [];
  async restart(body: RestartRequest, origin: LaunchOrigin, requestId?: string, requestedBy?: string) {
    this.origins.push(origin);
    this.calls.push([body, requestId]);
    this.movers.push(requestedBy);
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

const human = ownerStanding();

const dispatch = async (
  subsystem: SessionRestartSubsystem,
  method: 'GET' | 'POST' | 'DELETE',
  standing: CallStanding = human,
  body?: string,
  headers: Readonly<Record<string, string>> = {},
) =>
  await sessionRestartRoutes(subsystem)[`${method} /v1/restarts`](
    requestOf({ method, path: '/v1/restarts', headers, standing, ...(body === undefined ? {} : { body }) }),
  );

describe('the restart mount', () => {
  it('should mount the three restart routes', () => {
    const routes = sessionRestartRoutes(new FakeRestart());
    should(Object.keys(routes)).deepEqual(['POST /v1/restarts', 'GET /v1/restarts', 'DELETE /v1/restarts']);
  });

  it('should restart by the parsed request and pass the request id along', async () => {
    const subsystem = new FakeRestart();
    const answer = await dispatch(subsystem, 'POST', human, '{"scope":"outdated"}', {
      [FY_REQUEST_ID_HEADER]: ' r-1 ',
    });
    should(answer.status).equal(200);
    should(RestartResultSchema.parse(jsonOf(answer)).queued).have.length(1);
    should(subsystem.calls).eql([[{ scope: 'outdated' }, 'r-1']]);
  });

  it('should name who asked: the owner from a person, the session from an agent in its pane', async () => {
    const subsystem = new FakeRestart();
    await dispatch(subsystem, 'POST', human, '{"scope":"all"}');
    await dispatch(subsystem, 'POST', ferretStanding(ferretId('s-7')), '{"scope":"all"}');
    should(subsystem.movers).eql(['owner', 'session:s-7']);
  });

  it('should carry the ORIGIN the credential decided, apart from the journal’s words', async () => {
    const subsystem = new FakeRestart();
    const adminForFerret: CallStanding = { ...ownerStanding(), actor: ferretActor(ferretId('s-9')) };
    await dispatch(subsystem, 'POST', human, '{"scope":"all"}');
    await dispatch(subsystem, 'POST', deviceStanding('phone'), '{"scope":"all"}');
    await dispatch(subsystem, 'POST', ferretStanding(ferretId('s-7')), '{"scope":"all"}');
    await dispatch(subsystem, 'POST', adminForFerret, '{"scope":"all"}');
    await dispatch(subsystem, 'POST', wardenStanding(ferretId('w-1')), '{"scope":"all"}');
    should(subsystem.origins).eql([
      { kind: 'person' },
      { kind: 'person' },
      { kind: 'agent', ferret: 's-7' },
      { kind: 'agent', ferret: 's-9' },
      { kind: 'agent' },
    ]);
    // The Warden's token is journalled as the owner (no ferret behind it), yet it is an agent: the words are not authority.
    should(subsystem.movers[4]).equal('owner');
  });

  it('should run without a request id', async () => {
    const subsystem = new FakeRestart();
    await dispatch(subsystem, 'POST', human, '{"scope":"all"}');
    await dispatch(subsystem, 'POST', human, '{"scope":"all"}', { [FY_REQUEST_ID_HEADER]: '  ' });
    should(subsystem.calls.map(call => call[1])).eql([undefined, undefined]);
  });

  it('should refuse a request that does not parse', async () => {
    const refusal = await refusalOf(dispatch(new FakeRestart(), 'POST', human, '{"scope":"ids"}'));
    should(refusal?.status).equal(400);
  });

  it('should read the status and clear the queue', async () => {
    const subsystem = new FakeRestart();
    should(RestartStatusSchema.parse(jsonOf(await dispatch(subsystem, 'GET'))).outdated).have.length(1);
    should(RestartCancelResultSchema.parse(jsonOf(await dispatch(subsystem, 'DELETE'))).cancelled).equal(2);
  });
});
