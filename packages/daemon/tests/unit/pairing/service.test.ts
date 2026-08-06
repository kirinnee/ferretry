import { describe, it } from 'bun:test';
import {
  type Advertisement,
  type DaemonCarrier,
  type DaemonId,
  decideAdvertisement,
  type DeviceToken,
  type PairingCode,
  type PairingId,
} from '@ferretry/protocol';
import should from 'should';
import {
  type PairingCryptography,
  type PairingDeviceRecord,
  PairingDeviceRegistry,
  type PairingDeviceStore,
  PairingRateLimiter,
  PairingService,
} from '../../../src/lib/pairing/index.ts';

const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}` as DaemonId;
const PAIRING_ID = `fy_pair_${'b'.repeat(22)}` as PairingId;
const SECOND_PAIRING_ID = `fy_pair_${'c'.repeat(22)}` as PairingId;
const DEVICE_TOKEN = `fy_device_${'d'.repeat(43)}` as DeviceToken;
const SECOND_DEVICE_TOKEN = `fy_device_${'e'.repeat(43)}` as DeviceToken;
const CODE = '7F3K-Q2ND' as PairingCode;
const SECOND_CODE = '6E2J-P3MC' as PairingCode;
const FIRST_DEVICE_ID = `fy_device_id_${'1'.padStart(22, 'a')}`;
const SECOND_DEVICE_ID = `fy_device_id_${'2'.padStart(22, 'a')}`;

/**
 * A REAL published set, and non-empty on purpose.
 *
 * `PairingResponse.carriers` defaults to `[]`, so a fixture that handed the service an empty set would
 * assert nothing: "the daemon's carriers reached the device" and "the field was dropped and the schema
 * re-defaulted it" produce byte-identical responses. Two entries of both kinds is the smallest set that
 * cannot be produced by accident.
 */
const CARRIERS: readonly DaemonCarrier[] = [
  { kind: 'direct', url: 'https://workstation.example.test' },
  { kind: 'relay', url: 'wss://rendezvous.example.test/fy' },
];

class FakeClock {
  nowMs = Date.parse('2026-08-03T12:00:00.000Z');
  now = (): number => this.nowMs;
}

class FakeCryptography implements PairingCryptography {
  readonly codes = [CODE, SECOND_CODE];
  readonly pairingIds = [PAIRING_ID, SECOND_PAIRING_ID];
  readonly tokens = [DEVICE_TOKEN, SECOND_DEVICE_TOKEN];
  deviceIds = 0;

  pairingCode(): string {
    return this.codes.shift() ?? SECOND_CODE;
  }

  pairingId(): string {
    return this.pairingIds.shift() ?? SECOND_PAIRING_ID;
  }

  deviceToken(): string {
    return this.tokens.shift() ?? SECOND_DEVICE_TOKEN;
  }

  /**
   * A REALISTIC id, because the protocol's device projection parses it.
   *
   * `device-1` would exercise the state machine perfectly well and then fail the moment a record was
   * projected for the wire — the boundary that keeps a digest off the wire also insists on the id
   * shape, and a fixture that cannot cross it proves nothing about the surface it is standing in for.
   */
  deviceId(): string {
    this.deviceIds += 1;
    return `fy_device_id_${String(this.deviceIds).padStart(22, 'a')}`;
  }

  hashDeviceToken(daemonId: string, token: string): string {
    return `hash:${daemonId}:${token.length}`;
  }
}

class RecordingDevices implements PairingDeviceStore {
  records: PairingDeviceRecord[] = [];
  failure: Error | undefined;

  async add(record: PairingDeviceRecord): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.records.push(record);
  }

  async list(): Promise<readonly PairingDeviceRecord[]> {
    return this.records;
  }

  async remove(id: string): Promise<boolean> {
    if (this.failure !== undefined) throw this.failure;
    const remaining = this.records.filter(record => record.id !== id);
    if (remaining.length === this.records.length) return false;
    this.records = remaining;
    return true;
  }
}

/**
 * Something else that is keyed by a device, recording what it was asked to forget.
 *
 * A push enrolment is the first real one. What matters here is only the seam: revocation has to reach
 * every owner of per-device state, in the right order, and a fake that records is the only way to prove
 * the order rather than the intention.
 */
class RecordingDeviceState {
  readonly forgotten: string[] = [];

  constructor(private readonly failure?: Error) {}

  async forgetDevice(deviceId: string): Promise<number> {
    this.forgotten.push(deviceId);
    if (this.failure !== undefined) throw this.failure;
    return 1;
  }
}

function fixture(
  options: {
    readonly limiter?: PairingRateLimiter;
    readonly compare?: (left: string, right: string) => boolean;
    /** The decision this daemon was built with. Dialable unless a case is about the other two. */
    readonly advertisement?: Advertisement;
    readonly deviceState?: readonly RecordingDeviceState[];
    /** What this daemon resolved at boot, for a case about what a redemption hands out. */
    readonly carriers?: readonly DaemonCarrier[];
  } = {},
) {
  const clock = new FakeClock();
  const cryptography = new FakeCryptography();
  const devices = new RecordingDevices();
  const credentials = new PairingDeviceRegistry(DAEMON_ID, cryptography);
  const service = new PairingService({
    daemonId: DAEMON_ID,
    daemonName: 'workstation',
    advertisement: options.advertisement ?? {
      kind: 'address',
      url: 'https://workstation.example.test',
      origin: 'operator',
    },
    carriers: options.carriers ?? CARRIERS,
    clock,
    cryptography,
    devices,
    credentials,
    rateLimiter: options.limiter,
    compare: options.compare,
    deviceState: options.deviceState,
  });
  return { clock, cryptography, devices, credentials, service };
}

describe('PairingService minting and status', () => {
  it('should mint the fixed-TTL code and daemon-owned fragment URL', () => {
    const { service } = fixture();

    const minted = service.mint();

    should(minted).deepEqual({
      pairingId: PAIRING_ID,
      code: CODE,
      ttlSeconds: 120,
      expiresAt: '2026-08-03T12:02:00.000Z',
      daemonId: DAEMON_ID,
      daemonName: 'workstation',
      daemonUrl: 'https://workstation.example.test/',
      // A v2 fragment, because this daemon publishes a rendezvous. The candidate is what a device
      // that CANNOT reach the address beside it has to dial, and it can only travel out of band —
      // a device that cannot reach the daemon cannot ask the daemon where else to look.
      pairUrl:
        'https://ferretry.pages.dev/pair#v2;url=https%3A%2F%2Fworkstation.example.test%2F;code=7F3K-Q2ND;fp=fy_daemon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;relay=wss%3A%2F%2Frendezvous.example.test%2Ffy',
      // Who can redeem it travels WITH it. A link and no audience is the shape that put a QR of a
      // loopback address in front of a phone, and the protocol has no value for it any more.
      reach: 'any-device',
      relayCandidate: 'wss://rendezvous.example.test/fy',
    });
    should(service.status(PAIRING_ID)).deepEqual({
      pairingId: PAIRING_ID,
      status: 'pending',
      expiresAt: '2026-08-03T12:02:00.000Z',
    });
  });

  it('should mint the v1 fragment unchanged when this daemon publishes no rendezvous', () => {
    // A daemon reachable only at its own address has no candidate to name, and the link it mints is
    // BYTE-IDENTICAL to the one it minted before any of this existed — which is what lets a reader
    // that predates the second version keep working against a daemon that does not need it.
    const { service } = fixture({ carriers: [{ kind: 'direct', url: 'https://workstation.example.test' }] });

    const minted = service.mint();

    should(minted.pairUrl).equal(
      'https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fworkstation.example.test%2F;code=7F3K-Q2ND;fp=fy_daemon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    should(minted.relayCandidate).be.undefined();
  });

  it('should name the FIRST published rendezvous, from the same array a redemption answers with', async () => {
    // The candidate and the carrier set a device stores afterwards must be the same fact, or a client
    // is asked to choose between keeping an address the daemon did not publish and discarding the only
    // one that works. Taking both from one frozen array is what makes that impossible.
    const carriers: readonly DaemonCarrier[] = [
      { kind: 'direct', url: 'https://workstation.example.test' },
      { kind: 'relay', url: 'wss://first.example.test' },
      { kind: 'relay', url: 'wss://second.example.test' },
    ];
    const { service } = fixture({ carriers });

    const minted = service.mint();
    const redemption = await service.redeemOverRelay({ code: CODE, deviceName: 'phone' });

    should(minted.relayCandidate).equal('wss://first.example.test');
    if (redemption.kind !== 'paired') throw new Error('expected a pairing');
    should(redemption.response.carriers).deepEqual(carriers);
  });

  it('should mint a link for a loopback advertisement and say only this machine can redeem it', () => {
    // THE DEFAULT INSTALL. A loopback bind is not a misconfiguration and its code is not refused — a
    // browser on this machine pairs with it perfectly. What the response must carry is the audience,
    // so the surface drawing it knows not to offer it to a phone.
    const { service } = fixture({ advertisement: { kind: 'local-only', url: 'http://127.0.0.1:7431' } });

    const minted = service.mint();

    should(minted).containDeep({ reach: 'local-only', daemonUrl: 'http://127.0.0.1:7431/' });
    should('refusal' in minted).be.false();
  });

  it('should mint the valid local-only link derived from a raw IPv6 loopback host', () => {
    // The shared decision accepts operator host spellings, including raw IPv6. This crosses the next
    // boundary too: the service normalises the URL and the protocol verifies its fragment, so an
    // unbracketed authority cannot hide behind a kind-only decision test.
    const advertisement = decideAdvertisement({ host: '::1', port: 7_431 });
    const { service } = fixture({ advertisement });

    const minted = service.mint();

    should(minted).containDeep({ reach: 'local-only', daemonUrl: 'http://[::1]:7431/' });
    if (minted.pairUrl === undefined) throw new Error('a local-only advertisement must still mint its link');
    should(new URL(minted.pairUrl).hash).containEql(encodeURIComponent('http://[::1]:7431/'));
  });

  it('should mint a code with no link at all when there is no address to hand out', () => {
    // A wildcard bind serves normally and has nothing to advertise. The CODE is still minted, because
    // somebody who points a browser at this machine themselves can still redeem it; only the link is
    // withheld, with the reason attached.
    const { service } = fixture({ advertisement: { kind: 'none', refusal: 'wildcard-bind' } });

    const minted = service.mint();

    should(minted).containDeep({ code: CODE, refusal: 'wildcard-bind' });
    should('daemonUrl' in minted).be.false();
    should('pairUrl' in minted).be.false();
    should('reach' in minted).be.false();
    // The code is live: the mint is a real mint, not a refusal dressed as one.
    should(service.status(PAIRING_ID)).containDeep({ status: 'pending' });
  });

  it('should answer every caller identically, because the minter is not the redeemer', () => {
    // THE TRAP. `ApiRequest.loopback` names who is MINTING, and the commonest case there is is
    // somebody standing at the machine minting a code to scan with their phone — minter local,
    // redeemer not. A mint that read the requester's carrier would call that address fine and re-ship
    // the dead QR, passing every test written on one machine. `mint()` takes no argument, and this is
    // the assertion that keeps it that way: two mints from one configuration agree on the audience.
    const { service } = fixture({ advertisement: { kind: 'local-only', url: 'http://127.0.0.1:7431' } });

    const first = service.mint();
    const second = service.mint();

    should('reach' in first && first.reach).equal('local-only');
    should('reach' in second && second.reach).equal('local-only');
    should(service.mint.length).equal(0);
  });

  it('should expire a superseded or timed-out mint and refuse an unknown status handle', () => {
    const { clock, service } = fixture();
    service.mint();
    service.mint();

    should(service.status(PAIRING_ID)?.status).equal('expired');
    clock.nowMs += 120_000;
    should(service.status(SECOND_PAIRING_ID)?.status).equal('expired');
    should(service.status(`fy_pair_${'z'.repeat(22)}` as PairingId)).be.undefined();
  });
});

describe('PairingService redemption', () => {
  it('should atomically consume a code, persist only its hash, and acknowledge the bounded name', async () => {
    const { credentials, devices, service } = fixture();
    service.mint();

    const result = await service.redeem({ code: CODE, deviceName: '  Ernest phone  ' }, '198.51.100.2');

    should(result.kind).equal('paired');
    if (result.kind !== 'paired') throw new Error('expected successful pairing');
    should(result.response).deepEqual({
      deviceToken: DEVICE_TOKEN,
      daemonId: DAEMON_ID,
      daemonName: 'workstation',
      capabilities: ['daemon-api'],
      // EVERY WAY TO REACH THIS DAEMON, not just the one this device happened to pair over. A phone
      // that learned only the direct address has nothing to fall back to when it leaves the house, and
      // it cannot discover the rendezvous by itself — each end used to read its own build-time
      // directory and the two met by coincidence.
      carriers: CARRIERS,
    });
    should(devices.records).deepEqual([
      {
        id: FIRST_DEVICE_ID,
        daemonId: DAEMON_ID,
        name: 'Ernest phone',
        platform: 'browser',
        createdAt: '2026-08-03T12:00:00.000Z',
        lastSeenAt: '2026-08-03T12:00:00.000Z',
        tokenHash: `hash:${DAEMON_ID}:${DEVICE_TOKEN.length}`,
      },
    ]);
    should(JSON.stringify(devices.records)).not.containEql(DEVICE_TOKEN);
    should(credentials.identify(DEVICE_TOKEN)).equal(FIRST_DEVICE_ID);
    should(service.status(PAIRING_ID)).deepEqual({
      pairingId: PAIRING_ID,
      status: 'redeemed',
      expiresAt: '2026-08-03T12:02:00.000Z',
      redeemedAt: '2026-08-03T12:00:00.000Z',
      deviceName: 'Ernest phone',
    });
  });

  it('should publish the carrier set it was given rather than deriving one from its advertisement', async () => {
    // THE SHORTCUT THIS FORBIDS. The service already holds a dialable address, so "publish a direct
    // carrier for it" looks free — and it is wrong twice over: the advertisement is one address while
    // the carrier set is every address, and the rendezvous half cannot be derived from an
    // advertisement at all. The set is resolved once, at boot, by the owner of that question; this
    // service is a courier. So the two facts are deliberately in disagreement here, and the response
    // must carry the set.
    // Arrange
    const resolved: readonly DaemonCarrier[] = [{ kind: 'relay', url: 'wss://elsewhere.example.test/fy' }];
    const { service } = fixture({ carriers: resolved });
    service.mint();

    // Act
    const result = await service.redeem({ code: CODE, deviceName: 'phone' }, '198.51.100.9');

    // Assert
    if (result.kind !== 'paired') throw new Error('expected successful pairing');
    should(result.response.carriers).deepEqual(resolved);
    should(JSON.stringify(result.response.carriers)).not.containEql('workstation.example.test');
  });

  it('should refuse a carrier set the wire would reject BEFORE anything can be paired', async () => {
    // THE HALF-STATE THIS CLOSES. The response is parsed LAST, after the code is burned, the device row
    // is written and the credential is live — and `PublishedCarriersSchema` throws rather than dropping.
    // So a set the wire refuses used to turn one redemption into a generic 500 with the code spent, a
    // device persisted and no token delivered to anybody: nothing the operator or the phone can repair,
    // reached by a configuration mistake rather than by an attack. Construction is where it belongs.
    // Arrange — a URL the type permits and `DaemonOriginSchema` does not: a credential in an address.
    const devices = new RecordingDevices();
    const credentials = new PairingDeviceRegistry(DAEMON_ID, new FakeCryptography());
    const build = () =>
      new PairingService({
        daemonId: DAEMON_ID,
        daemonName: 'workstation',
        advertisement: { kind: 'address', url: 'https://workstation.example.test', origin: 'operator' },
        carriers: [{ kind: 'direct', url: 'https://operator:hunter2@workstation.example.test' }],
        clock: new FakeClock(),
        cryptography: new FakeCryptography(),
        devices,
        credentials,
      });

    // Act / Assert — it throws where a boot can report it, not where a request would, and it throws
    // about the CARRIER: a bare `.throw()` here would pass on any unrelated construction failure.
    should(build).throw(/daemon address may not carry credentials/u);
    // And nothing was mutated on the way: no device row, no live credential, no code to spend.
    should(devices.records).be.empty();
    should(credentials.identify(DEVICE_TOKEN)).be.undefined();
  });

  it('should refuse more carriers than the wire will carry, at construction', async () => {
    // The ceiling is the wire's (`MAX_PUBLISHED_CARRIERS`), and it exists because every entry is an
    // address some browser dials in turn — an unbounded list is an unbounded walk. A daemon that only
    // discovered the ceiling while answering a redemption would fail the one request that cannot be
    // retried.
    // Arrange
    const tooMany: readonly DaemonCarrier[] = Array.from({ length: 9 }, (_, index) => ({
      kind: 'relay' as const,
      url: `wss://rendezvous-${String(index)}.example.test/fy`,
    }));

    // Act / Assert
    should(() => fixture({ carriers: tooMany })).throw(/expected array to have <=8 items/u);
  });

  it('should keep publishing after construction accepted the set, rather than re-checking per redemption', async () => {
    // The check is a BOOT check, so it must not have become a per-request one: two redemptions from one
    // service both publish, and the second does not pay for the first's validation or fail on it.
    // Arrange
    const { service } = fixture();

    // Act
    service.mint();
    const first = await service.redeem({ code: CODE, deviceName: 'first' }, '198.51.100.3');
    service.mint();
    const second = await service.redeem({ code: SECOND_CODE, deviceName: 'second' }, '198.51.100.4');

    // Assert
    if (first.kind !== 'paired' || second.kind !== 'paired') throw new Error('expected two pairings');
    should([first.response.carriers, second.response.carriers]).deepEqual([CARRIERS, CARRIERS]);
  });

  it('should give wrong, malformed, expired, and already-consumed codes the same refusal', async () => {
    const wrong = fixture();
    wrong.service.mint();
    const malformed = fixture();
    malformed.service.mint();
    const expired = fixture();
    expired.service.mint();
    expired.clock.nowMs += 120_000;
    const consumed = fixture();
    consumed.service.mint();
    await consumed.service.redeem({ code: CODE, deviceName: 'phone' }, 'one');

    const refusals = await Promise.all([
      wrong.service.redeem({ code: SECOND_CODE, deviceName: 'phone' }, 'one'),
      malformed.service.redeem({ code: 'not-a-code', deviceName: 'phone' }, 'one'),
      expired.service.redeem({ code: CODE, deviceName: 'phone' }, 'one'),
      consumed.service.redeem({ code: CODE, deviceName: 'phone' }, 'two'),
    ]);

    should(refusals).deepEqual([{ kind: 'refused' }, { kind: 'refused' }, { kind: 'refused' }, { kind: 'refused' }]);
  });

  it('should kill the code after five failed attempts so the sixth cannot redeem it', async () => {
    const { devices, service } = fixture();
    service.mint();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      should((await service.redeem({ code: SECOND_CODE, deviceName: 'phone' }, `peer-${attempt}`)).kind).equal(
        'refused',
      );
    }
    const sixth = await service.redeem({ code: CODE, deviceName: 'phone' }, 'peer-six');

    should(sixth).deepEqual({ kind: 'refused' });
    should(devices.records).be.empty();
    should(service.status(PAIRING_ID)?.status).equal('expired');
  });

  it('should not let malformed uploads spend the daemon-wide code-guess budget', async () => {
    const { service } = fixture();
    service.mint();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      should((await service.redeem(undefined, `garbage-peer-${attempt}`)).kind).equal('refused');
    }
    const legitimate = await service.redeem({ code: CODE, deviceName: 'phone' }, 'legitimate-peer');

    should(legitimate.kind).equal('paired');
  });

  it('should allow only one of two concurrent redemptions to cross the consume boundary', async () => {
    let release: (() => void) | undefined;
    const persisted = new Promise<void>(resolve => {
      release = resolve;
    });
    const base = fixture();
    const devices: PairingDeviceStore = {
      add: async () => await persisted,
      list: async () => [],
      remove: async () => false,
    };
    const service = new PairingService({
      daemonId: DAEMON_ID,
      daemonName: 'workstation',
      advertisement: { kind: 'address', url: 'https://workstation.example.test', origin: 'operator' },
      carriers: CARRIERS,
      clock: base.clock,
      cryptography: base.cryptography,
      devices,
      credentials: base.credentials,
    });
    service.mint();

    const first = service.redeem({ code: CODE, deviceName: 'first' }, 'peer-one');
    const second = service.redeem({ code: CODE, deviceName: 'second' }, 'peer-two');
    release?.();
    const results = await Promise.all([first, second]);

    should(results.map(result => result.kind).sort()).deepEqual(['paired', 'refused']);
  });

  it('should keep endpoint rate limiting independent from the active code attempt budget', async () => {
    const clock = new FakeClock();
    const limiter = new PairingRateLimiter(clock, 1, 60_000);
    const current = fixture({ limiter });
    current.service.mint();

    await current.service.redeem({ code: SECOND_CODE, deviceName: 'phone' }, 'same-peer');
    const limited = await current.service.redeem({ code: CODE, deviceName: 'phone' }, 'same-peer');
    const otherPeer = await current.service.redeem({ code: CODE, deviceName: 'phone' }, 'other-peer');

    should(limited.kind).equal('refused');
    should(otherPeer.kind).equal('paired');
  });

  it('should bound peer windows and evict the least recently used one', () => {
    const clock = new FakeClock();
    const limiter = new PairingRateLimiter(clock, 1, 60_000, 2);

    should(limiter.admit('alpha')).be.true();
    should(limiter.admit('beta')).be.true();
    should(limiter.admit('gamma')).be.true();
    should(limiter.admit('beta')).be.false();
    should(limiter.admit('alpha')).be.true();
    should(limiter.admit('gamma')).be.true();
  });

  it('should consume the code and refuse when durable credential storage fails', async () => {
    const current = fixture();
    current.devices.failure = new Error('disk unavailable');
    current.service.mint();

    const failed = await current.service.redeem({ code: CODE, deviceName: 'phone' }, 'peer-one');
    const retried = await current.service.redeem({ code: CODE, deviceName: 'phone' }, 'peer-two');

    should(failed.kind).equal('refused');
    should(retried.kind).equal('refused');
    should(current.credentials.identify(DEVICE_TOKEN)).be.undefined();
  });

  it('should perform the constant-time comparison even when no usable code exists', async () => {
    const comparisons: Array<readonly [string, string]> = [];
    const current = fixture({
      compare: (left, right) => {
        comparisons.push([left, right]);
        return left === right;
      },
    });

    await current.service.redeem({ deviceName: 'phone' }, 'peer-one');
    current.service.mint();
    await current.service.redeem({ code: SECOND_CODE, deviceName: 'phone' }, 'peer-two');

    should(comparisons).deepEqual([
      ['', '2222-2222'],
      [SECOND_CODE, CODE],
    ]);
  });
});

describe('PairingService revocation', () => {
  it('should end a live code early, leaving nothing to redeem', async () => {
    // Arrange
    const { service } = fixture();
    const minted = service.mint();

    // Act
    const revoked = service.revoke(minted.pairingId);
    const attempted = await service.redeem({ code: CODE, deviceName: 'phone' }, 'peer-one');

    // Assert
    should(revoked).deepEqual({
      pairingId: PAIRING_ID,
      status: 'expired',
      expiresAt: '2026-08-03T12:02:00.000Z',
    });
    should(attempted).deepEqual({ kind: 'refused' });
  });

  it('should keep a redeemed code redeemed rather than reporting it expired', async () => {
    // A revoke arriving after a device got in must not tell the operator nobody did. The code is
    // already spent either way; what differs is the answer, and only one of them is true.
    // Arrange
    const { service } = fixture();
    service.mint();
    await service.redeem({ code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    const revoked = service.revoke(PAIRING_ID);

    // Assert
    should(revoked).containDeep({ status: 'redeemed', deviceName: 'phone' });
  });

  it('should be idempotent for a code it knows and silent about one it never minted', () => {
    // Arrange
    const { service } = fixture();
    service.mint();

    // Act
    const first = service.revoke(PAIRING_ID);
    const second = service.revoke(PAIRING_ID);
    const unknown = service.revoke(`fy_pair_${'z'.repeat(22)}` as PairingId);

    // Assert — two people shutting the same door is the expected use, not an error.
    should(first).deepEqual(second);
    should(unknown).be.undefined();
  });

  it('should project paired devices without their token digests', async () => {
    // Arrange
    const { devices, service } = fixture();
    service.mint();
    await service.redeem({ code: CODE, deviceName: 'Ernest phone' }, 'peer-one');

    // Act
    const listed = await service.devices();

    // Assert — the record HAS a digest and the projection has no field for one.
    should(devices.records[0]?.tokenHash).be.a.String();
    should(listed).deepEqual([
      {
        id: FIRST_DEVICE_ID,
        name: 'Ernest phone',
        platform: 'browser',
        createdAt: '2026-08-03T12:00:00.000Z',
        lastSeenAt: '2026-08-03T12:00:00.000Z',
      },
    ]);
    should(JSON.stringify(listed)).not.containEql('tokenHash');
  });

  it('should end a revoked device’s access for the very next request', async () => {
    // THE HALF THAT ACTUALLY REVOKES. Rewriting the document decides what comes back after a restart;
    // dropping the live grant decides whether the next request is served, which is the only one the
    // person holding the lost phone is making.
    // Arrange
    const { credentials, devices, service } = fixture();
    service.mint();
    await service.redeem({ code: CODE, deviceName: 'first' }, 'peer-one');
    service.mint();
    await service.redeem({ code: SECOND_CODE, deviceName: 'second' }, 'peer-two');

    // Act
    const removed = await service.revokeDevice(FIRST_DEVICE_ID);

    // Assert — the revoked grant is gone from both halves, and the sibling grant is untouched.
    // `identify` is asserted only NOT to be the revoked device: this fixture's digest is deliberately
    // sensitive to nothing but token length, so the two grants share one, and which of them answers
    // is a property of the fake rather than of the service. `PairingDeviceRegistry refusals` below
    // proves the real separation against a digest that has it.
    should(removed).be.true();
    should(credentials.identify(DEVICE_TOKEN)).not.equal(FIRST_DEVICE_ID);
    should(devices.records.map(record => record.id)).deepEqual([SECOND_DEVICE_ID]);
  });

  it('should stop authenticating the revoked device when nothing else is paired', async () => {
    // Arrange
    const { credentials, service } = fixture();
    service.mint();
    await service.redeem({ code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    await service.revokeDevice(FIRST_DEVICE_ID);

    // Assert
    should(credentials.identify(DEVICE_TOKEN)).be.undefined();
    should(await service.devices()).be.empty();
  });

  it('should report a device it never had rather than claiming to have revoked one', async () => {
    const { service } = fixture();

    should(await service.revokeDevice(FIRST_DEVICE_ID)).be.false();
  });

  it('should take the device’s other state away in the same act', async () => {
    // A revoked phone that keeps receiving this machine's notifications is a security defect, not a
    // cosmetic one, so revocation is one act across every owner of per-device state.
    // Arrange
    const push = new RecordingDeviceState();
    const { devices, service } = fixture({ deviceState: [push] });
    service.mint();
    await service.redeem({ code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    should(await service.revokeDevice(FIRST_DEVICE_ID)).be.true();

    // Assert
    should(push.forgotten).deepEqual([FIRST_DEVICE_ID]);
    should(devices.records).be.empty();
  });

  it('should leave the device fully paired when its other state cannot be purged', async () => {
    // THE ORDER IS THE OPPOSITE OF THE DOCUMENT'S, and deliberately: purging first means a failure
    // leaves a device that is still paired with its state intact — retryable, nothing half-done —
    // where revoking first would leave a phone that is unpaired and still being notified.
    // Arrange
    const push = new RecordingDeviceState(new Error('the enrolment document could not be written'));
    const { credentials, devices, service } = fixture({ deviceState: [push] });
    service.mint();
    await service.redeem({ code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    await service.revokeDevice(FIRST_DEVICE_ID).should.be.rejectedWith(/enrolment document/u);

    // Assert
    should(devices.records.map(record => record.id)).deepEqual([FIRST_DEVICE_ID]);
    should(credentials.identify(DEVICE_TOKEN)).equal(FIRST_DEVICE_ID);
  });

  it('should purge a device’s other state even when there was no grant left to remove', async () => {
    // Two people revoking the same lost phone is the expected way this is used, and the second pass
    // must still be able to clean up whatever the first one left behind.
    const push = new RecordingDeviceState();
    const { service } = fixture({ deviceState: [push] });

    should(await service.revokeDevice(FIRST_DEVICE_ID)).be.false();
    should(push.forgotten).deepEqual([FIRST_DEVICE_ID]);
  });

  it('should leave the live credential alone when the document cannot be written', async () => {
    // The order is the point: persist first, and only a successful write drops the grant. The other
    // way round, a failed write leaves a phone that stops working now and works again after a
    // restart — the least explainable outcome available.
    // Arrange
    const { credentials, devices, service } = fixture();
    service.mint();
    await service.redeem({ code: CODE, deviceName: 'phone' }, 'peer-one');
    devices.failure = new Error('disk unavailable');

    // Act
    const attempt = await service.revokeDevice(FIRST_DEVICE_ID).then(
      () => 'resolved',
      (reason: unknown) => (reason as Error).message,
    );

    // Assert
    should(attempt).equal('disk unavailable');
    should(credentials.identify(DEVICE_TOKEN)).equal(FIRST_DEVICE_ID);
  });
});

describe('PairingDeviceRegistry', () => {
  it('should scope every persisted device grant to its daemon', () => {
    const cryptography = new FakeCryptography();
    const registry = new PairingDeviceRegistry(DAEMON_ID, cryptography);
    const record: PairingDeviceRecord = {
      id: 'foreign',
      daemonId: `fy_daemon_${'z'.repeat(43)}` as DaemonId,
      name: 'foreign',
      platform: 'browser',
      createdAt: '2026-08-03T12:00:00.000Z',
      lastSeenAt: '2026-08-03T12:00:00.000Z',
      tokenHash: 'hash',
    };

    should(() => registry.add(record)).throw('a device grant belongs to a different daemon');
    should(registry.identify(DEVICE_TOKEN)).be.undefined();
  });
});

/**
 * The refusals, against a hash that is sensitive to BOTH the daemon id and the whole token — the
 * shape `NodePairingCryptography` has. The service fixture's hash deliberately collides on token
 * length, which is fine for exercising the state machine but cannot show that a wrong token, or the
 * right token at the wrong daemon, is turned away.
 */
describe('PairingDeviceRegistry refusals', () => {
  const SECOND_DAEMON_ID = `fy_daemon_${'f'.repeat(43)}` as DaemonId;
  const separated = {
    hashDeviceToken: (daemonId: string, token: string): string => `sha256(${daemonId}\0${token})`,
  };

  function grantedTo(daemonId: DaemonId, token: string, id = 'device-1'): PairingDeviceRegistry {
    const registry = new PairingDeviceRegistry(daemonId, separated);
    registry.add({
      id,
      daemonId,
      name: 'phone',
      platform: 'browser',
      createdAt: '2026-08-03T12:00:00.000Z',
      lastSeenAt: '2026-08-03T12:00:00.000Z',
      tokenHash: separated.hashDeviceToken(daemonId, token),
    });
    return registry;
  }

  it('should identify the device that holds the token', () => {
    should(grantedTo(DAEMON_ID, DEVICE_TOKEN).identify(DEVICE_TOKEN)).equal('device-1');
  });

  it('should refuse a token no grant covers', () => {
    should(grantedTo(DAEMON_ID, DEVICE_TOKEN).identify(SECOND_DEVICE_TOKEN)).be.undefined();
  });

  it('should refuse a token granted by another daemon', () => {
    // The digest is domain-separated by daemon id, so copying a device document — or the token
    // itself — to a second daemon cannot make the credential valid there.
    const here = grantedTo(DAEMON_ID, DEVICE_TOKEN);
    const there = grantedTo(SECOND_DAEMON_ID, DEVICE_TOKEN, 'device-2');

    should(here.identify(DEVICE_TOKEN)).equal('device-1');
    should(there.identify(DEVICE_TOKEN)).equal('device-2');
    should(new PairingDeviceRegistry(SECOND_DAEMON_ID, separated).identify(DEVICE_TOKEN)).be.undefined();
  });

  it('should refuse the stored digest presented as if it were the token', () => {
    // What the daemon persists is not a credential: a reader of `devices.json` holds hashes, and a
    // hash re-hashes to something else. Only the token the phone kept can authenticate.
    const digest = separated.hashDeviceToken(DAEMON_ID, DEVICE_TOKEN);

    should(grantedTo(DAEMON_ID, DEVICE_TOKEN).identify(digest)).be.undefined();
  });

  it('should refuse a blank token without consulting any grant', () => {
    const consulted: string[] = [];
    const recording = {
      hashDeviceToken: (daemonId: string, token: string): string => {
        consulted.push(token);
        return separated.hashDeviceToken(daemonId, token);
      },
    };
    const registry = new PairingDeviceRegistry(DAEMON_ID, recording);

    should(registry.identify('')).be.undefined();
    should(registry.identify('   ')).be.undefined();
    should(consulted).be.empty();
  });

  it('should refuse to register a grant carrying no digest', () => {
    const registry = new PairingDeviceRegistry(DAEMON_ID, separated);

    should(() =>
      registry.add({
        id: 'device-1',
        daemonId: DAEMON_ID,
        name: 'phone',
        platform: 'browser',
        createdAt: '2026-08-03T12:00:00.000Z',
        lastSeenAt: '2026-08-03T12:00:00.000Z',
        tokenHash: '  ',
      }),
    ).throw('a device grant carries no token digest');
    should(registry.identify(DEVICE_TOKEN)).be.undefined();
  });

  it('should compare every grant, so neither the match nor its position is observable', () => {
    // No early exit: the loop walks all three records whichever one holds the token, so the number
    // of comparisons never says which device answered — or whether one did.
    const comparisons: Array<readonly [string, string]> = [];
    const registry = new PairingDeviceRegistry(DAEMON_ID, separated, [], (left, right) => {
      comparisons.push([left, right]);
      return left === right;
    });
    for (const [index, token] of [SECOND_DEVICE_TOKEN, DEVICE_TOKEN, 'fy_device_other'].entries()) {
      registry.add({
        id: `device-${index}`,
        daemonId: DAEMON_ID,
        name: 'phone',
        platform: 'browser',
        createdAt: '2026-08-03T12:00:00.000Z',
        lastSeenAt: '2026-08-03T12:00:00.000Z',
        tokenHash: separated.hashDeviceToken(DAEMON_ID, token),
      });
    }

    should(registry.identify(DEVICE_TOKEN)).equal('device-1');
    should(comparisons).have.length(3);
    comparisons.length = 0;
    should(registry.identify('fy_device_absent')).be.undefined();
    should(comparisons).have.length(3);
  });
});

describe('PairingService redemption over a relay', () => {
  it('should pair through a port that takes no request, and answer with the whole published set', async () => {
    // Arrange
    const { devices, service } = fixture();
    service.mint();

    // Act
    const redemption = await service.redeemOverRelay({ code: CODE, deviceName: 'phone' });

    // Assert — the same grant a direct redemption produces, from the same code, `carriers` included:
    // that field is what a relay-paired device navigates by afterwards.
    should(redemption.kind).equal('paired');
    if (redemption.kind !== 'paired') throw new Error('expected a pairing');
    should(redemption.response.carriers).deepEqual(CARRIERS);
    should(redemption.response.daemonId).equal(DAEMON_ID);
    should(devices.records).have.length(1);
    should(devices.records[0]?.name).equal('phone');
    // Assert — single-use, on either carrier.
    should((await service.redeemOverRelay({ code: CODE, deviceName: 'again' })).kind).equal('refused');
  });

  it('should spend a relay budget that can never expire a code a LAN device could still redeem', async () => {
    // Arrange
    const { devices, service } = fixture();
    service.mint();

    // Act — five wrong guesses from the internet, which is the direct budget's whole size.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      should((await service.redeemOverRelay({ code: SECOND_CODE, deviceName: 'phone' })).kind).equal('refused');
    }

    // Assert — the code is ALIVE. This is the entire reason the counters are separate: a fingerprint
    // is public, so a shared budget would let anybody on earth kill a code sitting on somebody's desk.
    should(service.status(PAIRING_ID)?.status).equal('pending');
    const direct = await service.redeem({ code: CODE, deviceName: 'phone' }, 'lan-peer');
    should(direct.kind).equal('paired');
    should(devices.records).have.length(1);
  });

  it('should close only the relay path once its own budget is spent', async () => {
    // Arrange
    const { service } = fixture();
    service.mint();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.redeemOverRelay({ code: SECOND_CODE, deviceName: 'phone' });
    }

    // Act — the RIGHT code, arriving over the carrier whose budget is spent.
    const relayed = await service.redeemOverRelay({ code: CODE, deviceName: 'phone' });

    // Assert — refused there, and still redeemable here.
    should(relayed).deepEqual({ kind: 'refused' });
    should((await service.redeem({ code: CODE, deviceName: 'phone' }, 'lan-peer')).kind).equal('paired');
  });

  it('should never spend the relay budget from the direct path either', async () => {
    // Arrange
    const { service } = fixture();
    service.mint();

    // Act — the direct budget is exhausted, which expires the code entirely.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.redeem({ code: SECOND_CODE, deviceName: 'phone' }, `peer-${attempt}`);
    }

    // Assert — an expired code is gone for everybody. The asymmetry is deliberate: a relayed guesser
    // must not reach the LAN's budget, while the owner's own five guesses still end the code.
    should(service.status(PAIRING_ID)?.status).equal('expired');
    should((await service.redeemOverRelay({ code: CODE, deviceName: 'phone' })).kind).equal('refused');
  });

  it('should refuse identically with no code minted, a bad name, and an expired one', async () => {
    // Arrange — nothing has ever been minted, so there is nothing to guess.
    const never = fixture();
    const expired = fixture();
    expired.service.mint();
    expired.clock.nowMs += 120_000;
    const unusable = fixture();
    unusable.service.mint();

    // Act
    const refusals = await Promise.all([
      never.service.redeemOverRelay({ code: CODE, deviceName: 'phone' }),
      expired.service.redeemOverRelay({ code: CODE, deviceName: 'phone' }),
      unusable.service.redeemOverRelay({ code: CODE, deviceName: '' }),
      unusable.service.redeemOverRelay({ code: 'not-a-code', deviceName: 'phone' }),
    ]);

    // Assert — one answer for every cause. A pre-credential surface the whole internet can reach must
    // not be an oracle, and "no code is minted" is exactly the fact a faster refusal would leak.
    should(refusals).deepEqual([{ kind: 'refused' }, { kind: 'refused' }, { kind: 'refused' }, { kind: 'refused' }]);
  });

  it('should compare in constant time even when there is nothing to compare against', async () => {
    // Arrange — a comparator that records every pair it was given.
    const compared: string[] = [];
    const { service } = fixture({
      compare: (left, right) => {
        compared.push(right);
        return left === right;
      },
    });

    // Act — no code has been minted at all.
    should((await service.redeemOverRelay({ code: CODE, deviceName: 'phone' })).kind).equal('refused');

    // Assert — the work happened anyway, against the dummy.
    should(compared).have.length(1);
    should(compared[0]).not.equal(CODE);
  });

  it('should consume the code and refuse when durable storage fails a relayed redemption', async () => {
    // Arrange
    const { devices, service } = fixture();
    devices.failure = new Error('the state home is read-only');
    service.mint();

    // Act
    const redemption = await service.redeemOverRelay({ code: CODE, deviceName: 'phone' });

    // Assert — the same fail-closed answer the direct path gives: the code is spent, nothing paired.
    should(redemption).deepEqual({ kind: 'refused' });
    should(service.status(PAIRING_ID)?.status).equal('expired');
  });
});
