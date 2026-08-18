import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import {
  FLEET_PROPOSALS_PATH,
  FLEET_SHARING_PATH,
  fleetAuthorizePath,
  ProtocolFleetAuthorizationGateway,
  ProtocolFleetSharingGateway,
  ProtocolRecommendationGateway,
  RECOMMEND_PATH,
  RECOMMEND_TIMEOUT_MS,
} from '../../../src/lib/fleet/gateway';
import type { FleetApiClient } from '../../../src/lib/fleet/ports';
import { approvalMint, PROPOSAL_ID, recommendation, sharingReport } from './fixtures';

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

describe('protocol fleet authorization gateway', () => {
  it('should post the proposal id in the path, with no body and no extended deadline', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolFleetAuthorizationGateway(fakeClient(approvalMint(), calls));

    // Act
    const actual = await gateway.authorize(PROPOSAL_ID);

    // Assert
    should(calls).have.length(1);
    should(calls[0]?.path).equal(`${FLEET_PROPOSALS_PATH}/${PROPOSAL_ID}/authorize`);
    should(calls[0]?.init?.method).equal('POST');
    // The daemon reads no body, so sending one would be a shape nothing validates.
    should(calls[0]?.init?.body).be.undefined();
    // A memory-only mint has no claim on the recommender's provider-probe deadline.
    should(calls[0]?.timeoutMs).be.undefined();
    should(actual.code).equal('7F3K-M9QW');
  });

  it('should never put the approval code in the URL it requests', async () => {
    // Arrange — the daemon answers with a code the caller could not have known
    const calls: Call[] = [];
    const gateway = new ProtocolFleetAuthorizationGateway(fakeClient(approvalMint({ code: 'ABCD-2345' }), calls));

    // Act
    const actual = await gateway.authorize(PROPOSAL_ID);

    // Assert — a path is a URL and a URL reaches the daemon's access log
    should(actual.code).equal('ABCD-2345');
    should(calls[0]?.path).not.containEql('ABCD-2345');
    should(calls[0]?.path).not.containEql('ABCD');
  });

  it('should escape a proposal id rather than letting it shape the path', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolFleetAuthorizationGateway(fakeClient(approvalMint(), calls));

    // Act — an id that would otherwise climb out of the proposals collection
    await gateway.authorize('../../v1/fleet/apply');

    // Assert
    should(calls[0]?.path).equal(`${FLEET_PROPOSALS_PATH}/..%2F..%2Fv1%2Ffleet%2Fapply/authorize`);
    should(calls[0]?.path).not.containEql('/v1/fleet/apply');
  });

  it('should refuse a blank proposal id before it reaches the daemon', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolFleetAuthorizationGateway(fakeClient(approvalMint(), calls));

    // Act + Assert — an empty path segment would ask the daemon a question it cannot answer usefully
    await should(gateway.authorize('   ')).be.rejectedWith(/fy fleet authorize <proposal-id>/u);
    should(calls).be.empty();
  });

  it('should send a padded proposal id trimmed', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolFleetAuthorizationGateway(fakeClient(approvalMint(), calls));

    // Act
    await gateway.authorize(`  ${PROPOSAL_ID}\n`);

    // Assert
    should(calls[0]?.path).equal(`${FLEET_PROPOSALS_PATH}/${PROPOSAL_ID}/authorize`);
  });

  it('should build the same path the gateway posts to', () => {
    // Act + Assert — the exported helper is what a caller would reason about
    should(fleetAuthorizePath(PROPOSAL_ID)).equal(`/v1/fleet/proposals/${PROPOSAL_ID}/authorize`);
  });

  it('should fail loudly when the daemon refuses the proposal', async () => {
    // Arrange — the 409 refusal envelope, not a mint
    const gateway = new ProtocolFleetAuthorizationGateway(
      fakeClient({ error: 'no fleet proposal with that id', code: 'fleet_proposal_unknown' }),
    );

    // Act + Assert
    await should(gateway.authorize(PROPOSAL_ID)).be.rejected();
  });

  it('should fail loudly when the daemon answers a mint without its expiry', async () => {
    // Arrange — a contract change must break here with a stated reason, not inside the renderer
    const { expiresAt: _dropped, ...withoutExpiry } = approvalMint();
    const gateway = new ProtocolFleetAuthorizationGateway(fakeClient(withoutExpiry));

    // Act + Assert
    await should(gateway.authorize(PROPOSAL_ID)).be.rejected();
  });
});

describe('protocol fleet sharing gateway', () => {
  it('should read the sharing report on the default deadline', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolFleetSharingGateway(fakeClient(sharingReport(), calls));

    // Act
    const actual = await gateway.sharing();

    // Assert — a plain read: one address, an explicit GET so the route-agreement gate can prove the
    // method, and no timeout of its own because it resolves one document and touches no provider.
    should(calls[0]?.path).equal(FLEET_SHARING_PATH);
    should(calls[0]?.init?.method).equal('GET');
    should(calls[0]?.timeoutMs).be.undefined();
    should(actual.documents[0]?.name).equal('default');
  });

  it('should parse the report against the shared contract rather than trusting it', async () => {
    // Arrange — a daemon answering with a state the wire does not describe.
    const gateway = new ProtocolFleetSharingGateway(
      fakeClient({ documents: [], accounts: [{ accountId: 'not-a-uuid' }] }),
    );

    // Act / Assert
    await should(gateway.sharing()).be.rejected();
  });
});
