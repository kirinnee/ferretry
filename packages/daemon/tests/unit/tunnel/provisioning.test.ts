/**
 * Asking for this daemon's tunnel: challenge, then a signature the service verifies over ITS OWN host,
 * and a daemon that refuses to sign any host it did not discover (`docs/relay-protocol.md` §15).
 */

import { beforeAll, describe, it } from 'bun:test';
import type { DaemonIdentity } from '@ferretry/relay';
import should from 'should';
import {
  classifyProvisionerAnswer,
  PROVISION_RETRY_BACKOFF,
  provisionRetryDelayMs,
  TunnelProvisioningClient,
} from '../../../src/lib/tunnel/provisioning.ts';
import { FakeProvisioner, newDaemonIdentity, provisionOf, testCrypto } from './support.ts';

const ORIGIN = 'https://ferretry-hosted-relay.example.workers.dev';

let identity: DaemonIdentity;

beforeAll(async () => {
  identity = await newDaemonIdentity();
});

function client(provisioner: FakeProvisioner, origin = ORIGIN): TunnelProvisioningClient {
  return new TunnelProvisioningClient({ origin, provisioner, crypto: testCrypto, identity });
}

describe('tunnel provisioning', () => {
  it('should sign a provision the service verifies over its own host, with the listener’s port', async () => {
    // Arrange
    const provisioner = new FakeProvisioner(ORIGIN);

    // Act
    const outcome = await client(provisioner).provision(41_234);

    // Assert
    should(outcome).deepEqual({ kind: 'done', value: provisionOf() });
    should(provisioner.challenges).deepEqual([{ daemonId: identity.daemonId }]);
    should(provisioner.provisions[0]?.originPort).equal(41_234);
    should(provisioner.provisions[0]?.daemonId).equal(identity.daemonId);
    should(provisioner.verdicts).deepEqual([true]);
  });

  it('should sign a release under its own label, so a provision can never be replayed as one', async () => {
    // Arrange
    const provisioner = new FakeProvisioner(ORIGIN);

    // Act
    const outcome = await client(provisioner).release();

    // Assert
    should(outcome).deepEqual({ kind: 'done', value: { version: 1, released: true } });
    should(provisioner.verdicts).deepEqual([true]);
    should(Object.keys(provisioner.releases[0] ?? {}).sort()).deepEqual([
      'daemonId',
      'nonce',
      'publicKey',
      'signature',
    ]);
  });

  it('should refuse to sign for a host it did not discover, before any key is used', async () => {
    // Arrange — the provisioner talks to somewhere else.
    const provisioner = new FakeProvisioner('https://hostile.example');

    // Act
    const provision = await client(provisioner).provision(41_234);
    const release = await client(provisioner).release();

    // Assert
    should(provision).deepEqual({
      kind: 'refused',
      reason:
        'this daemon refuses to sign for hostile.example, which is not the host it discovered (ferretry-hosted-relay.example.workers.dev)',
    });
    should(release.kind).equal('refused');
    should(provisioner.challenges).deepEqual([]);
  });

  it('should sign a signature only the discovered host verifies', async () => {
    // The other half of the binding: a hostile service that relayed this daemon's signed request to an
    // honest one on another host would find the honest one's own transcript does not verify.
    // Arrange
    const honest = new FakeProvisioner(ORIGIN);
    const relayedElsewhere = new FakeProvisioner(ORIGIN, undefined, 'honest-service.example');

    // Act
    await client(honest).provision(1);
    await client(relayedElsewhere).provision(1);

    // Assert
    should(honest.verdicts).deepEqual([true]);
    should(relayedElsewhere.verdicts).deepEqual([false]);
  });

  it('should retry what may clear and give up on what is about this daemon', async () => {
    // Arrange
    const provisioner = new FakeProvisioner(ORIGIN);
    provisioner.provisionAnswers = [
      { kind: 'refused', status: 503, code: 'tunnel_capacity', message: 'every account is full' },
      { kind: 'refused', status: 502, code: 'tunnel_upstream_failed', message: 'the Cloudflare API failed' },
      { kind: 'refused', status: 429, code: 'tunnel_rate_limited', message: 'slow down' },
      { kind: 'refused', status: 401, code: 'tunnel_claim_rejected', message: 'signature failed' },
      { kind: 'refused', status: 400, code: 'tunnel_bad_request', message: 'bad request' },
      { kind: 'failed', reason: 'this daemon could not reach the hosted tunnel service' },
      { kind: 'refused', status: 500, code: undefined, message: '/v1/tunnel/provision answered 500' },
    ];
    const subject = client(provisioner);

    // Act
    const outcomes = [];
    for (let attempt = 0; attempt < 7; attempt += 1) outcomes.push(await subject.provision(9));

    // Assert
    should(outcomes.map(outcome => outcome.kind)).deepEqual([
      'retry',
      'retry',
      'retry',
      'refused',
      'refused',
      'retry',
      'retry',
    ]);
    should(outcomes[0]).deepEqual({
      kind: 'retry',
      reason: 'the hosted service refused (tunnel_capacity, 503): every account is full',
    });
    should(outcomes[6]).deepEqual({
      kind: 'retry',
      reason: 'the hosted service refused (500): /v1/tunnel/provision answered 500',
    });
  });

  it('should carry a failed challenge through as the outcome', async () => {
    // Arrange
    const provisioner = new FakeProvisioner(ORIGIN);
    provisioner.challengeAnswers = [
      { kind: 'refused', status: 401, code: 'tunnel_challenge_expired', message: 'expired' },
    ];

    // Act
    const outcome = await client(provisioner).provision(9);

    // Assert
    should(outcome.kind).equal('retry');
    should(provisioner.provisions).deepEqual([]);
  });

  it('should classify a bare refusal by its status', () => {
    should(classifyProvisionerAnswer({ kind: 'refused', status: 404, code: undefined, message: 'gone' })).deepEqual({
      retry: false,
      reason: 'the hosted service refused (404): gone',
    });
  });

  it('should back off from five seconds to ten minutes', () => {
    should(provisionRetryDelayMs(0, () => 1)).equal(PROVISION_RETRY_BACKOFF.baseMs);
    should(provisionRetryDelayMs(30, () => 1)).equal(PROVISION_RETRY_BACKOFF.capMs);
  });
});
