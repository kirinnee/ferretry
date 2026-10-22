import { describe, it } from 'bun:test';
import {
  type IFyApiClient,
  PACK_GUIDE_ACCEPT_PATH,
  PACK_GUIDE_DESCRIBE_PATH,
  PACK_GUIDE_SUGGEST_PATH,
  PACK_GUIDE_UNDO_PATH,
  PACK_INVENTORY_PATH,
  PACK_NEW_PATH,
  PACK_PATH,
  PACK_RECOMMEND_PATH,
  PackGuideJobResultSchema,
  PackGuideSuggestStartSchema,
  PackGuideWriteResultSchema,
  PackInventorySchema,
  PackNewOutcomeSchema,
  PackRecommendationSchema,
  PackViewSchema,
  SessionResultSchema,
} from '@ferretry/protocol';
import should from 'should';
import { PACK_NEW_TIMEOUT_MS, ProtocolPackGateway } from '../../../src/lib/pack/gateway.ts';
import { packView, recommendation, started } from './fixtures.ts';

type Client = Pick<IFyApiClient, 'request' | 'stop'>;

function build(answer: unknown) {
  const requests: Array<{ path: string; schema: unknown; init?: RequestInit; timeoutMs?: number }> = [];
  const stops: Array<{ id: string; reason: string }> = [];
  const client = {
    request: async (path: string, schema: unknown, init?: RequestInit, timeoutMs?: number) => {
      requests.push({
        path,
        schema,
        ...(init === undefined ? {} : { init }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      return answer;
    },
    stop: async (id: string, reason: string) => void stops.push({ id, reason }),
  } as unknown as Client;
  return { gateway: new ProtocolPackGateway(client), requests, stops };
}

describe('ProtocolPackGateway guide generator', () => {
  it('should read the inventory and a run, and post a suggest (waiting like a start), an accept, an undo and a description', async () => {
    // Arrange
    const { gateway, requests } = build({});
    const suggested = { by: 'opus', via: 'claude-work', at: '2026-10-22T12:00:00.000Z' };

    // Act
    await gateway.inventory();
    await gateway.suggest({ runtime: 'claude-work' });
    await gateway.job('run 1');
    await gateway.accept({ useCases: [], suggested });
    await gateway.undo();
    await gateway.describe({ model: 'glm-5', description: null });

    // Assert
    should(requests.map(entry => [entry.path, entry.schema, entry.init?.body, entry.timeoutMs])).eql([
      [PACK_INVENTORY_PATH, PackInventorySchema, undefined, undefined],
      [
        PACK_GUIDE_SUGGEST_PATH,
        PackGuideSuggestStartSchema,
        JSON.stringify({ runtime: 'claude-work' }),
        PACK_NEW_TIMEOUT_MS,
      ],
      ['/v1/pack/guide/jobs/run%201', PackGuideJobResultSchema, undefined, undefined],
      [PACK_GUIDE_ACCEPT_PATH, PackGuideWriteResultSchema, JSON.stringify({ useCases: [], suggested }), undefined],
      [PACK_GUIDE_UNDO_PATH, PackGuideWriteResultSchema, '{}', undefined],
      [
        PACK_GUIDE_DESCRIBE_PATH,
        PackGuideWriteResultSchema,
        JSON.stringify({ model: 'glm-5', description: null }),
        undefined,
      ],
    ]);
  });
});

describe('ProtocolPackGateway', () => {
  it('should GET the Pack view and parse it with the view schema', async () => {
    // Arrange
    const { gateway, requests } = build(packView());

    // Act
    const answer = await gateway.view();

    // Assert
    should(answer).eql(packView());
    should(requests[0]?.path).equal(PACK_PATH);
    should(requests[0]?.schema).equal(PackViewSchema);
    should(requests[0]?.init).be.undefined();
  });

  it('should POST the recommend request as JSON and parse the answer with the recommendation schema', async () => {
    // Arrange
    const { gateway, requests } = build(recommendation());

    // Act
    const answer = await gateway.recommend({ task: 'rename', useCase: 'bulk' });

    // Assert
    should(answer).eql(recommendation());
    should(requests).have.length(1);
    should(requests[0]?.path).equal(PACK_RECOMMEND_PATH);
    should(requests[0]?.schema).equal(PackRecommendationSchema);
    should(requests[0]?.init).eql({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'rename', useCase: 'bulk' }),
    });
    should(requests[0]?.timeoutMs).be.undefined();
  });

  it('should POST a start with the long timeout, because it probes before it launches', async () => {
    // Arrange
    const outcome = started();
    const { gateway, requests } = build(outcome);

    // Act
    const answer = await gateway.newChild({ task: 'x', runtime: 'claude-work' });

    // Assert
    should(answer).equal(outcome);
    should(requests[0]?.path).equal(PACK_NEW_PATH);
    should(requests[0]?.schema).equal(PackNewOutcomeSchema);
    should(requests[0]?.init?.body).equal(JSON.stringify({ task: 'x', runtime: 'claude-work' }));
    should(requests[0]?.timeoutMs).equal(PACK_NEW_TIMEOUT_MS);
    should(PACK_NEW_TIMEOUT_MS).equal(600_000);
  });

  it('should GET a result at an encoded session path', async () => {
    // Arrange
    const result = { id: 'a/b', status: 'completed', finished: true };
    const { gateway, requests } = build(result);

    // Act
    const answer = await gateway.result('a/b');

    // Assert
    should(answer).equal(result);
    should(requests[0]?.path).equal('/v1/sessions/a%2Fb/result');
    should(requests[0]?.schema).equal(SessionResultSchema);
    should(requests[0]?.init).be.undefined();
  });

  it('should stop a session through the client with the reason', async () => {
    // Arrange
    const { gateway, stops } = build(undefined);

    // Act
    await gateway.stop('child-1', 'its result was collected');

    // Assert
    should(stops).eql([{ id: 'child-1', reason: 'its result was collected' }]);
  });
});
