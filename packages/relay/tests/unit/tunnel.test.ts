import { describe, it } from 'bun:test';
import {
  CLOUDFLARE_TUNNELS_PER_ACCOUNT,
  MAX_TUNNEL_ACCOUNTS,
  NONCE_BYTES,
  signTunnelRequest,
  TUNNEL_PROVISION_LABEL,
  TUNNEL_RELEASE_LABEL,
  TunnelAccountPoolSchema,
  TunnelAccountSchema,
  TunnelChallengeRequestSchema,
  TunnelChallengeSchema,
  TunnelProvisionRequestSchema,
  TunnelProvisionSchema,
  TunnelRefusalSchema,
  TunnelReleaseRequestSchema,
  TunnelServiceAdvertisementSchema,
  toBase64Url,
  tunnelIngress,
  tunnelTranscript,
  utf8Text,
  verifyTunnelRequest,
} from '@ferretry/relay';
import should from 'should';
import { newDaemonIdentity, relayCrypto } from '../support/identities.ts';

const host = 'tunnels.example.test';
const account = {
  name: 'pool-a',
  accountId: 'a'.repeat(32),
  apiToken: 'never-a-real-token',
  zoneId: 'b'.repeat(32),
  zone: 'tunnels-a.example.com',
};

describe('tunnel provisioning signature', () => {
  it('should let the key holder provision, and verify against the service-side context', async () => {
    const identity = await newDaemonIdentity();
    const nonce = relayCrypto.randomBytes(NONCE_BYTES);
    const context = { action: 'provision' as const, daemonId: identity.daemonId, host, nonce, originPort: 41_234 };
    const signed = await signTunnelRequest(relayCrypto, identity, context);
    should(signed.daemonId).equal(identity.daemonId);
    should(signed.nonce).equal(toBase64Url(nonce));
    should(await verifyTunnelRequest(relayCrypto, context, signed)).eql({ ok: true });
    should(TunnelProvisionRequestSchema.safeParse({ ...signed, originPort: 41_234 }).success).be.true();
  });

  it('should bind the action, host and port into what is signed', async () => {
    const identity = await newDaemonIdentity();
    const nonce = relayCrypto.randomBytes(NONCE_BYTES);
    const provision = { action: 'provision' as const, daemonId: identity.daemonId, host, nonce, originPort: 7000 };
    const signed = await signTunnelRequest(relayCrypto, identity, provision);
    const release = { action: 'release' as const, daemonId: identity.daemonId, host, nonce };
    should(await verifyTunnelRequest(relayCrypto, release, signed)).eql({ ok: false, reason: 'signature failed' });
    should(await verifyTunnelRequest(relayCrypto, { ...provision, host: 'evil.example' }, signed)).eql({
      ok: false,
      reason: 'signature failed',
    });
    should(await verifyTunnelRequest(relayCrypto, { ...provision, originPort: 7001 }, signed)).eql({
      ok: false,
      reason: 'signature failed',
    });
    const releaseSigned = await signTunnelRequest(relayCrypto, identity, release);
    should(await verifyTunnelRequest(relayCrypto, release, releaseSigned)).eql({ ok: true });
    should(TunnelReleaseRequestSchema.safeParse(releaseSigned).success).be.true();
  });

  it('should start each transcript with its own label and leave an absent port empty', async () => {
    const nonce = new Uint8Array(NONCE_BYTES);
    const daemonId = (await newDaemonIdentity()).daemonId;
    const provision = tunnelTranscript({ action: 'provision', daemonId, host, nonce, originPort: 9 });
    const release = tunnelTranscript({ action: 'release', daemonId, host, nonce });
    should(utf8Text(provision.slice(0, TUNNEL_PROVISION_LABEL.length))).equal(TUNNEL_PROVISION_LABEL);
    should(utf8Text(release.slice(0, TUNNEL_RELEASE_LABEL.length))).equal(TUNNEL_RELEASE_LABEL);
    // The last field is LP("9") in one and LP("") in the other.
    should(Array.from(provision.slice(-5))).eql([0, 0, 0, 1, 57]);
    should(Array.from(release.slice(-4))).eql([0, 0, 0, 0]);
  });

  it('should refuse a stranger, a malformed key, a mismatched fingerprint and a mismatched nonce', async () => {
    const [mine, theirs] = await Promise.all([newDaemonIdentity(), newDaemonIdentity()]);
    const nonce = relayCrypto.randomBytes(NONCE_BYTES);
    const context = { action: 'release' as const, daemonId: mine.daemonId, host, nonce };
    const stranger = await signTunnelRequest(relayCrypto, theirs, { ...context, daemonId: theirs.daemonId });
    should(await verifyTunnelRequest(relayCrypto, context, { ...stranger, daemonId: mine.daemonId })).eql({
      ok: false,
      reason: 'public key does not match the fingerprint',
    });
    should(await verifyTunnelRequest(relayCrypto, context, stranger)).eql({
      ok: false,
      reason: 'fingerprint does not match the challenge',
    });
    const signed = await signTunnelRequest(relayCrypto, mine, context);
    should(await verifyTunnelRequest(relayCrypto, context, { ...signed, publicKey: 'short' })).eql({
      ok: false,
      reason: 'key or signature is malformed',
    });
    should(await verifyTunnelRequest(relayCrypto, context, { ...signed, signature: 'short' })).eql({
      ok: false,
      reason: 'key or signature is malformed',
    });
    should(
      await verifyTunnelRequest(relayCrypto, context, {
        ...signed,
        nonce: toBase64Url(relayCrypto.randomBytes(NONCE_BYTES)),
      }),
    ).eql({ ok: false, reason: 'nonce does not match the challenge' });
  });
});

describe('tunnel wire shapes', () => {
  it('should parse the advertisement, challenge and refusal strictly', async () => {
    should(TunnelServiceAdvertisementSchema.parse({ version: 1, available: false })).eql({
      version: 1,
      available: false,
    });
    should(TunnelServiceAdvertisementSchema.safeParse({ version: 1, available: true, extra: 1 }).success).be.false();
    const daemonId = (await newDaemonIdentity()).daemonId;
    should(TunnelChallengeRequestSchema.safeParse({ daemonId }).success).be.true();
    should(TunnelChallengeRequestSchema.safeParse({ daemonId: 'fy_daemon_nope' }).success).be.false();
    const nonce = toBase64Url(new Uint8Array(NONCE_BYTES));
    should(TunnelChallengeSchema.safeParse({ version: 1, nonce, deadlineSeconds: 60 }).success).be.true();
    should(TunnelChallengeSchema.safeParse({ version: 1, nonce, deadlineSeconds: 61 }).success).be.false();
    should(TunnelChallengeSchema.safeParse({ version: 1, nonce: 'AAAA', deadlineSeconds: 60 }).success).be.false();
    should(
      TunnelRefusalSchema.safeParse({ error: { code: 'tunnel_capacity', message: 'every account is full' } }).success,
    ).be.true();
    should(TunnelRefusalSchema.safeParse({ error: { code: 'nope', message: 'x' } }).success).be.false();
  });

  it('should accept only an https tunnel origin and a bounded renewal', () => {
    const answer = {
      version: 1,
      tunnelUrl: 'https://abc.tunnels-a.example.com/',
      connectorToken: 'opaque',
      renewAfterSeconds: 86_400,
    };
    should(TunnelProvisionSchema.parse(answer).tunnelUrl).equal('https://abc.tunnels-a.example.com');
    should(TunnelProvisionSchema.safeParse({ ...answer, tunnelUrl: 'http://abc.example.com' }).success).be.false();
    should(TunnelProvisionSchema.safeParse({ ...answer, renewAfterSeconds: 59 }).success).be.false();
    should(TunnelProvisionSchema.safeParse({ ...answer, connectorToken: '' }).success).be.false();
  });

  it('should forward exactly one route to one loopback port', async () => {
    const daemonId = (await newDaemonIdentity()).daemonId;
    should(tunnelIngress('abc.tunnels-a.example.com', daemonId, 41_234)).eql([
      {
        hostname: 'abc.tunnels-a.example.com',
        path: `^/v1/rendezvous/${daemonId}/client$`,
        service: 'http://127.0.0.1:41234',
      },
      { service: 'http_status:404' },
    ]);
  });
});

describe('tunnel account pool', () => {
  it('should default capacity to Cloudflare’s ceiling and accept new tunnels', () => {
    const parsed = TunnelAccountSchema.parse(account);
    should(parsed.maxTunnels).equal(CLOUDFLARE_TUNNELS_PER_ACCOUNT);
    should(parsed.accepting).be.true();
    should(TunnelAccountSchema.safeParse({ ...account, maxTunnels: 1001 }).success).be.false();
    should(TunnelAccountSchema.safeParse({ ...account, zone: 'Not A Zone' }).success).be.false();
    should(TunnelAccountSchema.safeParse({ ...account, accountId: 'short' }).success).be.false();
  });

  it('should refuse duplicate names, duplicate accounts and an unbounded pool', () => {
    should(TunnelAccountPoolSchema.safeParse([account]).success).be.true();
    should(TunnelAccountPoolSchema.safeParse([account, { ...account, accountId: 'c'.repeat(32) }]).success).be.false();
    should(TunnelAccountPoolSchema.safeParse([account, { ...account, name: 'pool-b' }]).success).be.false();
    const many = Array.from({ length: MAX_TUNNEL_ACCOUNTS + 1 }, (_, index) => ({
      ...account,
      name: `pool-${index}`,
      accountId: index.toString(16).padStart(32, '0'),
    }));
    should(TunnelAccountPoolSchema.safeParse(many).success).be.false();
  });
});
