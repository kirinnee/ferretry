import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import { ProtocolRecommendationGateway, RECOMMEND_PATH, RECOMMEND_TIMEOUT_MS } from '../../../src/lib/fleet/gateway';
import type { FleetApiClient } from '../../../src/lib/fleet/ports';
import { recommendation } from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
  timeoutMs: number | undefined;
}

function fakeClient(payload: unknown, calls: Call[] = []): FleetApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T> => {
      calls.push({ path, init, timeoutMs });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

describe('protocol recommendation gateway', () => {
  it('should post the task with a timeout that survives a live quota probe', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolRecommendationGateway(fakeClient(recommendation(), calls));

    // Act
    const actual = await gateway.recommend({ task: 'port the CLI groups', usage: true });

    // Assert
    should(calls[0]?.path).equal(RECOMMEND_PATH);
    should(calls[0]?.timeoutMs).equal(RECOMMEND_TIMEOUT_MS);
    should(JSON.parse(String(calls[0]?.init?.body))).eql({ task: 'port the CLI groups', usage: true });
    should(actual.roles[0]?.primary.agent).equal('sol');
  });

  it('should refuse an empty task before it reaches the daemon', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolRecommendationGateway(fakeClient(recommendation(), calls));

    // Act + Assert
    await should(gateway.recommend({ task: '', usage: true })).be.rejected();
    should(calls).be.empty();
  });

  it('should default the optional collections rather than leaving them undefined', async () => {
    // Arrange — a daemon that omits alternatives, exclusions and warnings entirely
    const payload = {
      task: 'do the thing',
      classification: 'implementation',
      reasoning: 'because',
      roles: [
        {
          role: 'implementer',
          why: 'it needs writing',
          primary: { agent: 'sol', accountId: 'a', model: 'm', tradeoff: '', score: 1 },
        },
      ],
    };
    const gateway = new ProtocolRecommendationGateway(fakeClient(payload));

    // Act
    const actual = await gateway.recommend({ task: 'do the thing', usage: false });

    // Assert
    should(actual.roles[0]?.alternatives).eql([]);
    should(actual.exclusions).eql([]);
    should(actual.warnings).eql([]);
  });

  it('should fail loudly when the daemon answers with an error envelope', async () => {
    // Arrange
    const gateway = new ProtocolRecommendationGateway(fakeClient({ error: 'no routing catalog' }));

    // Act + Assert
    await should(gateway.recommend({ task: 'anything', usage: false })).be.rejected();
  });
});
