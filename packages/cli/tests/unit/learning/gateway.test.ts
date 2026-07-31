import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import {
  LEARNING_CONFIG_PATH,
  LEARNING_RUN_PATH,
  LEARNING_STATUS_PATH,
  learningPatchPath,
  learningProposalPath,
  learningProposalsPath,
  ProtocolLearningGateway,
} from '../../../src/lib/learning/gateway';
import type { LearningApiClient } from '../../../src/lib/learning/ports';
import { learningConfig, learningStatus, patchResponse, proposal, runManifest } from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
}

/** A client that answers with a payload and records the call, so the gateway's parsing is real. */
function fakeClient(payload: unknown, calls: Call[] = []): LearningApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

const body = (init: RequestInit | undefined): unknown => JSON.parse(String(init?.body));

describe('learning routes', () => {
  it('should address the board with and without a state filter', () => {
    // Act + Assert
    should(learningProposalsPath()).equal('/v1/learning/proposals');
    should(learningProposalsPath('accepted')).equal('/v1/learning/proposals?state=accepted');
  });

  it('should escape a proposal id that would otherwise break the route', () => {
    // Act + Assert
    should(learningProposalPath('a/b')).equal('/v1/learning/proposals/a%2Fb');
    should(learningPatchPath('a b')).equal('/v1/learning/proposals/a%20b/patch');
  });
});

describe('protocol learning gateway', () => {
  it('should read the status with a plain GET', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolLearningGateway(fakeClient(learningStatus(), calls));

    // Act
    const actual = await gateway.status();

    // Assert
    should(calls[0]?.path).equal(LEARNING_STATUS_PATH);
    should(calls[0]?.init).be.undefined();
    should(actual.pending.total).equal(3);
  });

  it('should read the config with a plain GET', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolLearningGateway(fakeClient(learningConfig(), calls));

    // Act
    const actual = await gateway.config();

    // Assert
    should(calls[0]?.path).equal(LEARNING_CONFIG_PATH);
    should(actual.agent).equal('miner');
  });

  it('should read the board and parse every row against the protocol schema', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolLearningGateway(fakeClient([proposal('p1'), proposal('p2')], calls));

    // Act
    const actual = await gateway.proposals('pending');

    // Assert
    should(calls[0]?.path).equal('/v1/learning/proposals?state=pending');
    should(actual.map(row => row.id)).eql(['p1', 'p2']);
  });

  it('should post an action as validated protocol JSON', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolLearningGateway(fakeClient(proposal('p1', { state: 'rejected' }), calls));

    // Act
    const actual = await gateway.act('p1', { action: 'reject', note: 'too narrow' });

    // Assert
    should(calls[0]?.path).equal('/v1/learning/proposals/p1');
    should(calls[0]?.init?.method).equal('POST');
    should(body(calls[0]?.init)).eql({ action: 'reject', note: 'too narrow' });
    should(actual.state).equal('rejected');
  });

  it('should refuse an action the protocol does not define', async () => {
    // Arrange
    const gateway = new ProtocolLearningGateway(fakeClient(proposal('p1')));

    // Act + Assert — a bad request never reaches the daemon
    await should(gateway.act('p1', { action: 'edit', ruleText: '' })).be.rejected();
  });

  it('should post a run with the spawn flag defaulted through the protocol schema', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolLearningGateway(fakeClient(runManifest(), calls));

    // Act
    const actual = await gateway.run(true);

    // Assert
    should(calls[0]?.path).equal(LEARNING_RUN_PATH);
    should(body(calls[0]?.init)).eql({ spawn: true });
    should(actual.runId).equal('run-7');
  });

  it('should fetch a patch with a GET, because reading guidance mutates nothing', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolLearningGateway(fakeClient(patchResponse(), calls));

    // Act
    const actual = await gateway.patch('p1');

    // Assert
    should(calls[0]?.path).equal('/v1/learning/proposals/p1/patch');
    should(calls[0]?.init).be.undefined();
    should(actual.path).equal('guidance.md');
  });

  it('should fail loudly when the daemon answers with something else', async () => {
    // Arrange — an error envelope where a status was promised
    const gateway = new ProtocolLearningGateway(fakeClient({ error: 'learning is not wired' }));

    // Act + Assert
    await should(gateway.status()).be.rejected();
  });
});
