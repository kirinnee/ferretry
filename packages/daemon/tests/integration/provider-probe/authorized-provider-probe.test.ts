/**
 * The login Test's adapter (docs/provider-presets.md): a plan with a key goes through the outbound
 * holder and nowhere else; a plan without one reads a server on this machine, and is refused here if
 * it names anywhere else — whatever the plan says. Both ports are fakes: CI never touches a network.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { AuthorizedProviderProbe } from '../../../src/adapters/provider-probe/authorized-provider-probe.ts';
import type { ProviderProbePlan } from '../../../src/lib/index.ts';
import { RecordingTransport, ScriptedAuthorizer } from '../../unit/speedups/fakes.ts';

const REQUEST = {
  method: 'GET' as const,
  headers: { accept: 'application/json' },
  timeoutMs: 1_000,
  maxResponseBytes: 1_024,
};

describe('AuthorizedProviderProbe', () => {
  it('should hand a keyed plan to the outbound holder exactly as planned, and the transport nothing', async () => {
    // Arrange
    const authorizer = new ScriptedAuthorizer({ kind: 'completion', payload: { data: [] } });
    const transport = new RecordingTransport();
    const plan: ProviderProbePlan = {
      kind: 'authorized',
      secretName: 'MOONSHOT_API_KEY',
      hosts: ['api.moonshot.ai'],
      spends: 'nothing',
      placement: { header: 'authorization', scheme: 'Bearer' },
      request: { ...REQUEST, url: 'https://api.moonshot.ai/v1/models' },
    };

    // Act
    const actual = await new AuthorizedProviderProbe(authorizer, transport).probe(plan);

    // Assert
    should(actual).deepEqual({ kind: 'completion', payload: { data: [] } });
    should(authorizer.calls).deepEqual([
      { secretName: 'MOONSHOT_API_KEY', hosts: ['api.moonshot.ai'], request: plan.request, placement: plan.placement },
    ]);
    should(transport.sent).be.empty();
  });

  it('should read a keyless plan on this machine through the plain transport', async () => {
    // Arrange
    const authorizer = new ScriptedAuthorizer({ kind: 'refused' });
    const transport = new RecordingTransport({ kind: 'completion', payload: { models: [] } });

    // Act
    const actual = await new AuthorizedProviderProbe(authorizer, transport).probe({
      kind: 'local',
      spends: 'nothing',
      request: { ...REQUEST, url: 'http://localhost:11434/api/tags' },
    });

    // Assert
    should(actual).deepEqual({ kind: 'completion', payload: { models: [] } });
    should(transport.sent.map(request => request.url)).deepEqual(['http://localhost:11434/api/tags']);
    should(authorizer.calls).be.empty();
  });

  it.each(['https://localhost:11434/api/tags', 'http://models.example/api/tags'])(
    'should refuse a keyless plan for %s without sending anything',
    async url => {
      // Arrange
      const transport = new RecordingTransport();

      // Act
      const actual = await new AuthorizedProviderProbe(new ScriptedAuthorizer({ kind: 'refused' }), transport).probe({
        kind: 'local',
        spends: 'nothing',
        request: { ...REQUEST, url },
      });

      // Assert
      should(actual).deepEqual({ kind: 'refused' });
      should(transport.sent).be.empty();
    },
  );
});
