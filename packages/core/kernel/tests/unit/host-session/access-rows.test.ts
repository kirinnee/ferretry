/**
 * The Access rows the KERNEL session layer owns (Access co-owns them through its `device` and `pair` modes). Each
 * runs on the real layer (`createSessionLayer`) through the shared harness; a part of a row that lives in the app
 * shell rather than the kernel is said in its test.
 */
import { describe, expect, test } from 'bun:test';
import type { SocketHandler } from '../../../contract/socket.ts';
import {
  CREDIT_WINDOW_FRAMES,
  DEFAULT_ACCESS_LEASE_POLICY,
  deviceAuthMessage,
  devicePairMessage,
  SESSION_PROTOCOL_ID,
  signDeviceProof,
  toBase64Url,
  UNKNOWN_HOLDER_KEY,
} from '../../../host/session/index.ts';
import {
  bootTimings,
  DEFAULT_DAEMON_TIMINGS,
  describeDaemonTimings,
  parseDaemonTimings,
} from '../../../host/session/timings.ts';
import { type Fixture, fixture, pairedDevice, serving, type TestClient, TestClient as Client } from './harness.ts';
import { relayCrypto } from './identities.ts';

const MINUTE = 60_000;
const UNKNOWN = { code: 4403, reason: 'unknown device credential' };
const LAPSED = { code: 4441, reason: 'the access lease ended' };

const req = (id: number): Record<string, unknown> => ({ t: 'req', id, method: 'GET', path: '/v1/health' });

/** A stream session on `/v1/events` whose handler accepts and stays open. */
async function streamSession(
  fx: Fixture,
): Promise<{ client: TestClient; device: Awaited<ReturnType<typeof pairedDevice>> }> {
  fx.sockets = {
    upgrade: async request => {
      fx.streams.push(request);
      return {
        outcome: 'accepted',
        attach: async () => ({ open: async () => {}, fromClient: () => {}, close: () => {} }) satisfies SocketHandler,
      };
    },
    reauthorize: () => true,
  };
  const device = await pairedDevice(fx.device);
  const client = Client.open(fx);
  await client.handshake(fx.daemonId);
  await client.auth(device, { path: '/v1/events' }, 'stream');
  return { client, device };
}

/** The session crypto, counting every signature check and the key each was made against. */
function countingCrypto(): { crypto: typeof relayCrypto; verified: Uint8Array[] } {
  const verified: Uint8Array[] = [];
  const crypto = new Proxy(relayCrypto, {
    get(target, property) {
      if (property === 'verifyEd25519')
        return async (spki: Uint8Array, signature: Uint8Array, message: Uint8Array) => {
          verified.push(spki);
          return await target.verifyEd25519(spki, signature, message);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { crypto, verified };
}

const at = (record: Record<string, unknown> | undefined): number => Date.parse(String(record?.['accessExpiresAt']));

describe('Access rows on the kernel session layer', () => {
  test('R238 a relay sees only THAT a refusal happened, as one code and reason, and an unknown device costs one check against the dummy key', async () => {
    const { crypto, verified } = countingCrypto();
    const fx = await fixture({ crypto, lease: { leaseMs: MINUTE, renewLeadMs: 10_000, maxSessionMs: 10 * MINUTE } });
    // unknown device
    const ghost = await pairedDevice(fx.device, 'G');
    fx.device.keys.delete(ghost.deviceId);
    const unknown = Client.open(fx);
    await unknown.handshake(fx.daemonId);
    const before = verified.length;
    await unknown.auth(ghost);
    expect(verified.length - before).toBe(1);
    expect(toBase64Url(verified[verified.length - 1] ?? new Uint8Array())).toBe(UNKNOWN_HOLDER_KEY);
    // a known device with a wrong signature: the same single check, the same refusal
    const known = await pairedDevice(fx.device, 'K');
    const impostor = await pairedDevice(fx.device, 'I');
    const forged = Client.open(fx);
    await forged.handshake(fx.daemonId);
    const proof = await signDeviceProof(
      relayCrypto,
      relayCrypto.deviceKeyHandle(impostor.privateKey),
      deviceAuthMessage(forged.transcript ?? new Uint8Array(), 'auth', known.deviceId, known.appSession),
    );
    const beforeForged = verified.length;
    await forged.send({
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceId: known.deviceId,
      appSession: known.appSession,
      proof,
    });
    await forged.pump();
    expect(verified.length - beforeForged).toBe(1);
    // a revoked holder mid-session, and a lapsed lease
    const revoked = await serving(fx);
    for (const watch of fx.device.watches.get(revoked.device.deviceId) ?? []) watch.revoked();
    await revoked.client.pump();
    const lapsed = await serving(fx);
    fx.clock.advance(MINUTE);
    await lapsed.client.pump();
    // What crosses the carrier unsealed is the session end alone: a code and a fixed reason, no holder, no cause.
    for (const end of [unknown.end, forged.end, revoked.client.end]) expect(end).toEqual(UNKNOWN);
    expect(lapsed.client.end).toEqual(LAPSED);
    for (const client of [unknown, forged]) expect(client.records).toHaveLength(0);
    for (const end of [unknown.end, forged.end, revoked.client.end, lapsed.client.end])
      for (const name of [ghost.deviceId, known.deviceId, revoked.device.deviceId])
        expect(JSON.stringify(end).includes(name)).toBe(false);
    expect(fx.layer.report().lastRefusal?.includes(ghost.deviceId) ?? false).toBe(false);
  });

  test('R241 no bearer token: the lease is 15 min from the proof and renew is sent 2 min before it ends, on request and stream sessions', async () => {
    for (const open of ['request', 'stream'] as const) {
      const fx = await fixture();
      const proofAt = fx.clock.nowMs();
      const { client } = open === 'request' ? await serving(fx) : await streamSession(fx);
      const accepted =
        client.last(open === 'request' ? 'authenticated' : 'stream-opened') ?? client.last('authenticated');
      if (open === 'request') {
        // the acceptance carries the lease end and nothing a client could present again
        expect(
          Object.keys(client.last('authenticated') ?? {}).filter(key => /token|bearer|secret|key/i.test(key)),
        ).toEqual([]);
        expect(at(accepted)).toBe(proofAt + 15 * MINUTE);
        await client.send(req(1));
        await client.pump();
        expect(Date.parse(String(fx.requests[0]?.principal?.leaseUntil))).toBe(proofAt + 15 * MINUTE);
      } else expect(Date.parse(String(fx.streams[0]?.principal?.leaseUntil))).toBe(proofAt + 15 * MINUTE);
      fx.clock.advance(13 * MINUTE - 1);
      await client.pump();
      expect(client.last('renew')).toBeUndefined();
      fx.clock.advance(1);
      await client.pump();
      expect(at(client.last('renew') ? { accessExpiresAt: client.last('renew')?.['expiresAt'] } : undefined)).toBe(
        proofAt + 15 * MINUTE,
      );
    }
    expect(DEFAULT_ACCESS_LEASE_POLICY).toEqual({
      leaseMs: 15 * MINUTE,
      renewLeadMs: 2 * MINUTE,
      maxSessionMs: 12 * 60 * MINUTE,
    });
  });

  test('R244 a lapsed lease ends 4441, never as a revocation; 4403 is the only "no longer accepted"', async () => {
    // The app's retry (a read once, silently; a write never) is the app shell's half of this row, not the kernel's.
    const fx = await fixture({ lease: { leaseMs: MINUTE, renewLeadMs: 10_000, maxSessionMs: 10 * MINUTE } });
    const lapsed = await serving(fx);
    fx.clock.advance(MINUTE);
    await lapsed.client.pump();
    expect(lapsed.client.end).toEqual(LAPSED);
    // the holder is still accepted: a new session on it is served
    const again = Client.open(fx);
    await again.handshake(fx.daemonId);
    await again.auth(lapsed.device);
    expect(again.last('authenticated')).toBeDefined();
    // a renewal answered by a holder revoked meanwhile is the 4403, not a 4441
    const revoked = await serving(fx);
    fx.clock.advance(50_000);
    await revoked.client.pump();
    const nonce = String(revoked.client.last('renew')?.['nonce']);
    fx.device.keys.delete(revoked.device.deviceId);
    await revoked.client.renew(revoked.device, nonce);
    expect(revoked.client.end).toEqual(UNKNOWN);
  });

  test('R245 the clock is checked on every record, so a late timer serves nothing; renew is queued ahead of credit-blocked payloads', async () => {
    const lease = { leaseMs: MINUTE, renewLeadMs: 10_000, maxSessionMs: 10 * MINUTE };
    const fx = await fixture({ lease });
    const late = await serving(fx);
    fx.clock.skew(MINUTE); // past the lease, and the lease timer has NOT fired
    await late.client.send(req(1));
    await late.client.pump();
    expect(late.client.end).toEqual(LAPSED);
    expect(fx.requests).toHaveLength(0);

    const blocked = await fixture({ lease });
    const { client } = await serving(blocked);
    for (let id = 1; id <= CREDIT_WINDOW_FRAMES + 4; id += 1) await client.send(req(id));
    await client.pump();
    const seen = client.records.length;
    expect(client.records.filter(record => record['t'] === 'res')).toHaveLength(CREDIT_WINDOW_FRAMES - 2);
    blocked.clock.advance(50_000);
    await client.pump();
    expect(client.records).toHaveLength(seen); // the window is full: the renewal waits for credit too
    client.credit(16);
    await client.pump();
    expect(client.records[seen]?.['t']).toBe('renew');
    expect(client.records.slice(seen + 1).filter(record => record['t'] === 'res')).toHaveLength(6);
  });

  test('R247 FYD_TEST_TIMINGS may only shorten: a longer value refuses the boot, shortened timings are logged once, unset is the shipped values exactly', async () => {
    const said: string[] = [];
    const unset = bootTimings(undefined, line => said.push(line));
    expect(unset).toEqual({ ok: true, timings: DEFAULT_DAEMON_TIMINGS });
    expect(unset.ok && unset.timings).toBe(DEFAULT_DAEMON_TIMINGS);
    expect(DEFAULT_DAEMON_TIMINGS).toEqual({ lease: DEFAULT_ACCESS_LEASE_POLICY, idleDayMs: 86_400_000 });
    expect(said).toEqual([]);
    for (const longer of [
      '{"leaseSeconds": 901}',
      '{"renewLeadSeconds": 121}',
      '{"maxSessionSeconds": 43201}',
      '{"idleDaySeconds": 86401}',
    ]) {
      const refused = bootTimings(longer, line => said.push(line));
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.sentence).toStartWith(
        'fyd: FYD_TEST_TIMINGS may only shorten the shipped timings: ',
      );
    }
    expect(bootTimings('lease=6', () => {}).ok).toBe(false);
    expect(bootTimings('{"leaseSeconds": 60}', () => {}).ok).toBe(false); // renew lead not shorter than the lease
    expect(bootTimings('{"leaseMinutes": 1}', () => {}).ok).toBe(false);
    expect(said).toEqual([]);
    const shortened = bootTimings(
      '{"leaseSeconds": 6, "renewLeadSeconds": 2, "maxSessionSeconds": 20, "idleDaySeconds": 5}',
      line => said.push(line),
    );
    expect(said).toEqual(['FYD_TEST_TIMINGS in force: lease 6s (renewed 2s ahead), session cap 20s, one idle day 5s']);
    expect(shortened.ok && shortened.timings).toEqual({
      lease: { leaseMs: 6_000, renewLeadMs: 2_000, maxSessionMs: 20_000 },
      idleDayMs: 5_000,
    });
    expect(describeDaemonTimings(parseDaemonTimings('  '))).toBeUndefined();
    // the layer runs on exactly what was parsed
    if (!shortened.ok) throw new Error('shortened');
    const fx = await fixture({ lease: shortened.timings.lease });
    const proofAt = fx.clock.nowMs();
    const { client } = await serving(fx);
    expect(at(client.last('authenticated'))).toBe(proofAt + 6_000);
    fx.clock.advance(4_000);
    await client.pump();
    expect(client.last('renew')).toBeDefined();
  });

  test('R540 stream sessions hold and renew a lease exactly as request sessions do', async () => {
    const lease = { leaseMs: MINUTE, renewLeadMs: 10_000, maxSessionMs: 10 * MINUTE };
    const fx = await fixture({ lease });
    const { client, device } = await streamSession(fx);
    expect(client.last('stream-opened')).toBeDefined();
    fx.clock.advance(50_000);
    await client.pump();
    const renew = client.last('renew');
    expect(renew).toBeDefined();
    await client.renew(device, String(renew?.['nonce']));
    fx.clock.advance(15_000);
    await client.pump();
    expect(client.end).toBeUndefined();
    fx.clock.advance(MINUTE);
    await client.pump();
    expect(client.end).toEqual(LAPSED);
  });

  test('R572 pair is legal only as the record at sequence 1, and its proof is domain-separated', async () => {
    const pairRecord = async (
      client: TestClient,
      message?: (transcript: Uint8Array, deviceKey: string) => Uint8Array,
    ) => {
      const key = await relayCrypto.generateDeviceKey();
      const deviceKey = toBase64Url(key.publicKeySpki);
      const transcript = client.transcript ?? new Uint8Array();
      const proof = await signDeviceProof(
        relayCrypto,
        relayCrypto.deviceKeyHandle(key.privateKey),
        (message ?? devicePairMessage)(transcript, deviceKey),
      );
      return { t: 'pair', protocol: SESSION_PROTOCOL_ID, code: 'ABCD-1234', deviceName: 'phone', deviceKey, proof };
    };
    const fx = await fixture();
    // after an accepted credential (sequence 2), a pair record ends the session and no pairing is attempted
    const { client } = await serving(fx, 'direct', { address: '192.0.2.1' });
    await client.send(await pairRecord(client));
    await client.pump();
    expect(client.end?.code).toBe(4400);
    expect(fx.pair.attempts).toHaveLength(0);
    // a device-auth signature over the same transcript is not a pairing proof
    const crossed = Client.open(fx, 'direct', { address: '192.0.2.2' });
    await crossed.handshake(fx.daemonId);
    await crossed.send(
      await pairRecord(crossed, (transcript, deviceKey) => deviceAuthMessage(transcript, 'auth', deviceKey, 'x')),
    );
    await crossed.pump();
    expect(crossed.last('pair-refused')).toMatchObject({ reason: 'pairing_refused' });
    // one strict union: a pair record carrying a field of another record is no record at all
    const mixed = Client.open(fx, 'direct', { address: '192.0.2.3' });
    await mixed.handshake(fx.daemonId);
    await mixed.send({ ...(await pairRecord(mixed)), deviceId: 'fy_device_id_x' });
    await mixed.pump();
    expect(mixed.end?.code).toBe(4400);
    // and at sequence 1, the proof made for pairing pairs
    const first = Client.open(fx, 'direct', { address: '192.0.2.4' });
    await first.handshake(fx.daemonId);
    await first.send(await pairRecord(first));
    await first.pump();
    expect(first.sequences.length).toBeGreaterThan(0);
    expect(first.last('paired')).toBeDefined();
    expect(fx.pair.attempts).toHaveLength(2);
  });
});
