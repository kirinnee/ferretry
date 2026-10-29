import { describe, it } from 'bun:test';
import {
  type Advertisement,
  type DaemonCarrier,
  type DaemonId,
  decideAdvertisement,
  invitationRedeemableByAnotherDevice,
  type PairingCode,
  type PairingId,
  pairingMintOutcome,
  type CapabilityGrants,
  LIMITED_DEVICE_GRANTS,
  FULL_DEVICE_GRANTS,
} from '@ferretry/protocol';
import { toBase64Url } from '@ferretry/relay';
import should from 'should';
import type { GrantAuditEntry } from '../../../src/lib/grants/types.ts';
import {
  type DeviceConnectionRevoker,
  LiveDeviceConnections,
  type PairingCryptography,
  type PairingDeviceRecord,
  PairingDeviceRegistry,
  type PairingDeviceStore,
  type PairingGrant,
  type PairingGrantObserver,
  PAIRING_GRANTS_PER_HOUR,
  PAIRING_MAX_DEVICES,
  PairingRateLimiter,
  PairingService,
} from '../../../src/lib/pairing/index.ts';

/** An Ed25519 SPKI: the fixed DER prefix and 32 key bytes. The service checks the shape; the session checks the key. */
const DEVICE_KEY = toBase64Url(
  new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, ...new Array(32).fill(5)]),
);
const SECOND_DEVICE_KEY = toBase64Url(
  new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, ...new Array(32).fill(6)]),
);

class RecordingAudit {
  readonly entries: GrantAuditEntry[] = [];

  constructor(
    private readonly onRecord?: () => void,
    private readonly failure?: Error,
  ) {}

  async record(entry: GrantAuditEntry): Promise<void> {
    this.onRecord?.();
    if (this.failure !== undefined) throw this.failure;
    this.entries.push(entry);
  }
}

interface AttemptShape {
  readonly code?: string;
  readonly deviceName?: string;
}

/**
 * A redemption that arrived on this daemon's own listener, as the session layer presents one.
 *
 * `proven` is the session's verdict on the record's proof; every case that is not about the proof
 * passes a proven key, and the cases that are say so.
 */
function redeemDirect(
  service: Pick<PairingService, 'redeemInSession'>,
  attempt: AttemptShape | undefined,
  peer: string,
  options: { readonly proven?: boolean; readonly deviceKey?: string } = {},
) {
  return service.redeemInSession(
    {
      code: attempt?.code ?? '',
      deviceName: attempt?.deviceName ?? '',
      deviceKey: options.deviceKey ?? DEVICE_KEY,
      prove: async () => options.proven ?? true,
    },
    { kind: 'direct', rateLimitKey: peer },
  );
}

/** The same redemption arriving over a rendezvous, which spends the relay budget instead. */
function redeemRelayed(
  service: Pick<PairingService, 'redeemInSession'>,
  attempt: AttemptShape,
  options: { readonly proven?: boolean; readonly deviceKey?: string } = {},
) {
  return service.redeemInSession(
    {
      code: attempt.code ?? '',
      deviceName: attempt.deviceName ?? '',
      deviceKey: options.deviceKey ?? DEVICE_KEY,
      prove: async () => options.proven ?? true,
    },
    { kind: 'relay' },
  );
}

const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}` as DaemonId;
const PAIRING_ID = `fy_pair_${'b'.repeat(22)}` as PairingId;
const SECOND_PAIRING_ID = `fy_pair_${'c'.repeat(22)}` as PairingId;
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
  deviceIds = 0;

  pairingCode(): string {
    return this.codes.shift() ?? SECOND_CODE;
  }

  pairingId(): string {
    return this.pairingIds.shift() ?? SECOND_PAIRING_ID;
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

  readonly touched: { readonly id: string; readonly lastSeenAt: string }[] = [];
  touchFailure: Error | undefined;

  /** Holds every write until released, so a case can land something else while one is in flight. */
  touchGate: Promise<void> | undefined;

  async touch(id: string, lastSeenAt: string): Promise<void> {
    this.touched.push({ id, lastSeenAt });
    if (this.touchGate !== undefined) await this.touchGate;
    if (this.touchFailure !== undefined) throw this.touchFailure;
    this.records = this.records.map(record => (record.id === id ? { ...record, lastSeenAt } : record));
  }

  readonly rotated: { readonly id: string; readonly publicKey: string; readonly keyRotatedAt: string }[] = [];
  rotateResult = true;
  rotateFailure: Error | undefined;

  async rotateKey(id: string, publicKey: string, keyRotatedAt: string): Promise<boolean> {
    if (this.rotateFailure !== undefined) throw this.rotateFailure;
    if (!this.rotateResult) return false;
    this.rotated.push({ id, publicKey, keyRotatedAt });
    this.records = this.records.map(record => (record.id === id ? { ...record, publicKey, keyRotatedAt } : record));
    return true;
  }

  /** Held so a case can make the write wait, and race it against a sighting. */
  grantWrite: Promise<void> = Promise.resolve();

  async setGrants(id: string, grants: CapabilityGrants): Promise<boolean> {
    if (this.failure !== undefined) throw this.failure;
    await this.grantWrite;
    if (!this.records.some(record => record.id === id)) return false;
    this.records = this.records.map(record => (record.id === id ? { ...record, grants } : record));
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
    readonly connections?: DeviceConnectionRevoker;
    readonly audit?: RecordingAudit;
    /** What this daemon resolved at boot, for a case about what a redemption hands out. */
    readonly carriers?: readonly DaemonCarrier[];
    /** The rendezvous the composition root proved a fresh device could discover, if any. */
    readonly discoveredRelayUrl?: string;
    /** The machine's idle period, when a case is about the setting rather than the default. */
    readonly idleExpiryDays?: () => number;
    /** How long one idle day is, when a case drives the period in seconds. */
    readonly idleDayMs?: number;
    /** The observer told once a grant is persisted, when a case is about what it is handed or what it may do. */
    readonly onGranted?: PairingGrantObserver;
  } = {},
) {
  const clock = new FakeClock();
  const cryptography = new FakeCryptography();
  const devices = new RecordingDevices();
  const credentials = new PairingDeviceRegistry(DAEMON_ID);
  const service = new PairingService({
    daemonId: DAEMON_ID,
    daemonName: 'workstation',
    advertisement: options.advertisement ?? {
      kind: 'address',
      url: 'https://workstation.example.test',
      origin: 'operator',
    },
    carriers: { current: () => options.carriers ?? CARRIERS },
    ...(options.discoveredRelayUrl === undefined ? {} : { discoveredRelayUrl: options.discoveredRelayUrl }),
    clock,
    cryptography,
    devices,
    credentials,
    rateLimiter: options.limiter,
    compare: options.compare,
    deviceState: options.deviceState,
    ...(options.connections === undefined ? {} : { connections: options.connections }),
    ...(options.idleExpiryDays === undefined ? {} : { idleExpiryDays: options.idleExpiryDays }),
    ...(options.idleDayMs === undefined ? {} : { idleDayMs: options.idleDayMs }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.onGranted === undefined ? {} : { onGranted: options.onGranted }),
  });
  const mint = () => service.mint();
  return { clock, cryptography, devices, credentials, service, mint };
}

describe('PairingService minting and status', () => {
  it('should mint the fixed-TTL code and daemon-owned fragment URL', async () => {
    const { service, mint } = fixture();

    const minted = mint();

    should(minted).deepEqual({
      pairingId: PAIRING_ID,
      code: CODE,
      ttlSeconds: 120,
      expiresAt: '2026-08-03T12:02:00.000Z',
      daemonId: DAEMON_ID,
      daemonName: 'workstation',
      daemonUrl: 'https://workstation.example.test/',
      // The ONE fragment form, and it names no rendezvous even though this daemon publishes one. A
      // device that cannot reach the address beside it still has somewhere to dial — the rendezvous
      // its own build discovers from the hosted directory — so the link does not have to carry one.
      pairUrl:
        'https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fworkstation.example.test%2F;code=7F3K-Q2ND;fp=fy_daemon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      // Who can redeem it travels WITH it. A link and no audience is the shape that put a QR of a
      // loopback address in front of a phone, and the protocol has no value for it any more.
      reach: 'any-device',
      // What a device redeeming it will hold: full access behind the unlock, unless minted `--limited`.
      grants: 'full',
    });
    should(service.status(PAIRING_ID)).deepEqual({
      pairingId: PAIRING_ID,
      status: 'pending',
      expiresAt: '2026-08-03T12:02:00.000Z',
    });
  });

  it('should forget the oldest observation once 128 minted codes are remembered', async () => {
    // Arrange — every mint gets a distinct id, so each one leaves its own observation behind
    const { cryptography, service } = fixture();
    let minted = 0;
    cryptography.pairingId = () => {
      minted += 1;
      return `fy_pair_${String(minted).padStart(22, 'd')}`;
    };
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => `fy_pair_${String(index + 1).padStart(22, 'd')}` as PairingId);

    // Act
    for (let index = 0; index < 128; index += 1) service.mint();
    const beforeEviction = ids(128).map(id => service.status(id) !== undefined);
    service.mint();

    // Assert — the 129th mint pushes only the oldest out
    should(beforeEviction.every(Boolean)).be.true();
    should(service.status(ids(1)[0] as PairingId)).be.undefined();
    should(service.status(ids(2)[1] as PairingId)).not.be.undefined();
    should(service.status(ids(129)[128] as PairingId)?.status).equal('pending');
  });

  it('should disclose the discovered rendezvous and never a published one, whatever it publishes', async () => {
    // THE GAP, PINNED AS BEHAVIOUR. This used to read the FIRST published relay of any provenance,
    // which is wrong in exactly the case that matters: an operator's own rendezvous is published and
    // is NOT something a fresh phone can find, so disclosing it promised a first pairing that cannot
    // happen. Only the composition root knows which entry — if any — came from the hosted directory
    // advertisement, so only it may answer, and the published set stays untouched.
    const carriers: readonly DaemonCarrier[] = [
      { kind: 'direct', url: 'https://workstation.example.test' },
      { kind: 'relay', url: 'wss://self-hosted.example.test' },
      { kind: 'relay', url: 'wss://second.example.test' },
    ];
    const selfHosted = fixture({ carriers });

    const mintedWithoutDiscovery = selfHosted.mint();
    const redemption = await redeemRelayed(selfHosted.service, { code: CODE, deviceName: 'phone' });

    should(mintedWithoutDiscovery.discoveredRelayUrl).be.undefined();
    if (redemption.kind !== 'paired') throw new Error('expected a pairing');
    // The set a device navigates by is unchanged — this narrowing touches disclosure, not publication.
    should(redemption.response.carriers).deepEqual(carriers);

    const discovered = fixture({ carriers, discoveredRelayUrl: 'wss://hosted.example.test/fy' });
    should(discovered.mint().discoveredRelayUrl).equal('wss://hosted.example.test/fy');
  });

  it('should mint the same fragment whether or not a rendezvous is discoverable', async () => {
    // BYTE-IDENTICAL, AND THAT IS THE POINT OF THE NARROWING. The disclosure is host-facing; the link
    // is the one every daemon has ever written, so no reader anywhere is asked to learn a new form.
    const expected =
      'https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fworkstation.example.test%2F;code=7F3K-Q2ND;fp=fy_daemon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const direct = fixture({ carriers: [{ kind: 'direct', url: 'https://workstation.example.test' }] });
    const relayed = fixture({ discoveredRelayUrl: 'wss://hosted.example.test/fy' });

    const withoutRelay = direct.mint();
    const withRelay = relayed.mint();

    should(withoutRelay.pairUrl).equal(expected);
    should(withoutRelay.discoveredRelayUrl).be.undefined();
    should(withRelay.pairUrl).equal(expected);
    should(withRelay.pairUrl).not.containEql('relay');
  });

  it('should draw no QR for a loopback bind whose only rendezvous is self-hosted, and one when it is discovered', async () => {
    // The user-visible half of the same gap, read through the protocol's single narrowing so this
    // agrees with `fy pair` and the Add-a-device panel rather than re-deciding.
    const local: Advertisement = { kind: 'local-only', url: 'http://127.0.0.1:7431' };
    const selfHosted = fixture({ advertisement: local });
    const discovered = fixture({ advertisement: local, discoveredRelayUrl: 'wss://hosted.example.test/fy' });

    const withoutDiscovery = pairingMintOutcome(selfHosted.mint());
    const withDiscovery = pairingMintOutcome(discovered.mint());

    if (withoutDiscovery.kind !== 'invitation' || withDiscovery.kind !== 'invitation')
      throw new Error('expected two invitations');
    should(invitationRedeemableByAnotherDevice(withoutDiscovery)).be.false();
    should(invitationRedeemableByAnotherDevice(withDiscovery)).be.true();
  });

  it('should mint a link for a loopback advertisement and say only this machine can redeem it', async () => {
    // THE DEFAULT INSTALL. A loopback bind is not a misconfiguration and its code is not refused — a
    // browser on this machine pairs with it perfectly. What the response must carry is the audience,
    // so the surface drawing it knows not to offer it to a phone.
    const { mint } = fixture({ advertisement: { kind: 'local-only', url: 'http://127.0.0.1:7431' } });

    const minted = mint();

    should(minted).containDeep({ reach: 'local-only', daemonUrl: 'http://127.0.0.1:7431/' });
    should('refusal' in minted).be.false();
  });

  it('should mint the valid local-only link derived from a raw IPv6 loopback host', async () => {
    // The shared decision accepts operator host spellings, including raw IPv6. This crosses the next
    // boundary too: the service normalises the URL and the protocol verifies its fragment, so an
    // unbracketed authority cannot hide behind a kind-only decision test.
    const advertisement = decideAdvertisement({ host: '::1', port: 7_431 });
    const { mint } = fixture({ advertisement });

    const minted = mint();

    should(minted).containDeep({ reach: 'local-only', daemonUrl: 'http://[::1]:7431/' });
    if (minted.pairUrl === undefined) throw new Error('a local-only advertisement must still mint its link');
    should(new URL(minted.pairUrl).hash).containEql(encodeURIComponent('http://[::1]:7431/'));
  });

  it('should mint a code with no link at all when there is no address to hand out', async () => {
    // A wildcard bind serves normally and has nothing to advertise. The CODE is still minted, because
    // somebody who points a browser at this machine themselves can still redeem it; only the link is
    // withheld, with the reason attached.
    const { service, mint } = fixture({ advertisement: { kind: 'none', refusal: 'wildcard-bind' } });

    const minted = mint();

    should(minted).containDeep({ code: CODE, refusal: 'wildcard-bind' });
    should('daemonUrl' in minted).be.false();
    should('pairUrl' in minted).be.false();
    should('reach' in minted).be.false();
    // The code is live: the mint is a real mint, not a refusal dressed as one.
    should(service.status(PAIRING_ID)).containDeep({ status: 'pending' });
  });

  it('should answer every caller identically, because the minter is not the redeemer', async () => {
    // THE TRAP. `ApiRequest.loopback` names who is MINTING, and the commonest case there is is
    // somebody standing at the machine minting a code to scan with their phone — minter local,
    // redeemer not. A mint that read the requester's carrier would call that address fine and re-ship
    // the dead QR, passing every test written on one machine. `mint()` takes no argument, and this is
    // the assertion that keeps it that way: two mints from one configuration agree on the audience.
    const { service, mint } = fixture({ advertisement: { kind: 'local-only', url: 'http://127.0.0.1:7431' } });

    const first = mint();
    const second = mint();

    should('reach' in first && first.reach).equal('local-only');
    should('reach' in second && second.reach).equal('local-only');
    should(service.mint.length).equal(0);
  });

  it('should expire a superseded or timed-out mint and refuse an unknown status handle', async () => {
    const { clock, service, mint } = fixture();
    mint();
    mint();

    should(service.status(PAIRING_ID)?.status).equal('expired');
    clock.nowMs += 120_000;
    should(service.status(SECOND_PAIRING_ID)?.status).equal('expired');
    should(service.status(`fy_pair_${'z'.repeat(22)}` as PairingId)).be.undefined();
  });
});

describe('PairingService redemption', () => {
  it('should atomically consume a code, persist only its public key, and acknowledge the bounded name', async () => {
    const { credentials, devices, service, mint } = fixture();
    mint();

    const result = await redeemDirect(service, { code: CODE, deviceName: '  Ernest phone  ' }, '198.51.100.2');

    should(result.kind).equal('paired');
    if (result.kind !== 'paired') throw new Error('expected successful pairing');
    should(result.response).deepEqual({
      // An identity, not a credential: nothing in this answer can authenticate anybody.
      deviceId: FIRST_DEVICE_ID,
      daemonId: DAEMON_ID,
      daemonName: 'workstation',
      capabilities: ['daemon-api'],
      // EVERY WAY TO REACH THIS DAEMON, not just the one this device happened to pair over. A phone
      // that learned only the direct address has nothing to fall back to when it leaves the house, and
      // it cannot discover the rendezvous by itself — each end used to read its own build-time
      // directory and the two met by coincidence.
      carriers: CARRIERS,
      idleExpiryDays: 30,
    });
    should(devices.records).deepEqual([
      {
        id: FIRST_DEVICE_ID,
        daemonId: DAEMON_ID,
        name: 'Ernest phone',
        platform: 'browser',
        createdAt: '2026-08-03T12:00:00.000Z',
        lastSeenAt: '2026-08-03T12:00:00.000Z',
        // How it arrived, so every other device can be told "over the relay" or "on the local network".
        pairedOver: 'direct',
        publicKey: DEVICE_KEY,
        // Full access behind the unlock (owner decision 2026-10-14): the default for a newly paired device.
        grants: FULL_DEVICE_GRANTS,
      },
    ]);
    should(JSON.stringify(result.response)).not.containEql(DEVICE_KEY);
    should(credentials.get(FIRST_DEVICE_ID)?.publicKey).equal(DEVICE_KEY);
    should(await service.deviceKey(FIRST_DEVICE_ID)).equal(DEVICE_KEY);
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
    const { service, mint } = fixture({ carriers: resolved });
    mint();

    // Act
    const result = await redeemDirect(service, { code: CODE, deviceName: 'phone' }, '198.51.100.9');

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
    const credentials = new PairingDeviceRegistry(DAEMON_ID);
    const build = () =>
      new PairingService({
        daemonId: DAEMON_ID,
        daemonName: 'workstation',
        advertisement: { kind: 'address', url: 'https://workstation.example.test', origin: 'operator' },
        carriers: { current: () => [{ kind: 'direct', url: 'https://operator:hunter2@workstation.example.test' }] },
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
    should(credentials.all()).be.empty();
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
    const { service, mint } = fixture();

    // Act
    mint();
    const first = await redeemDirect(service, { code: CODE, deviceName: 'first' }, '198.51.100.3');
    mint();
    const second = await redeemDirect(service, { code: SECOND_CODE, deviceName: 'second' }, '198.51.100.4');

    // Assert
    if (first.kind !== 'paired' || second.kind !== 'paired') throw new Error('expected two pairings');
    should([first.response.carriers, second.response.carriers]).deepEqual([CARRIERS, CARRIERS]);
  });

  it('should give wrong, malformed, expired, and already-consumed codes the same refusal', async () => {
    const wrong = fixture();
    wrong.mint();
    const malformed = fixture();
    malformed.mint();
    const expired = fixture();
    expired.mint();
    expired.clock.nowMs += 120_000;
    const consumed = fixture();
    consumed.mint();
    await redeemDirect(consumed.service, { code: CODE, deviceName: 'phone' }, 'one');

    const refusals = await Promise.all([
      redeemDirect(wrong.service, { code: SECOND_CODE, deviceName: 'phone' }, 'one'),
      redeemDirect(malformed.service, { code: 'not-a-code', deviceName: 'phone' }, 'one'),
      redeemDirect(expired.service, { code: CODE, deviceName: 'phone' }, 'one'),
      redeemDirect(consumed.service, { code: CODE, deviceName: 'phone' }, 'two'),
    ]);

    should(refusals).deepEqual([{ kind: 'refused' }, { kind: 'refused' }, { kind: 'refused' }, { kind: 'refused' }]);
  });

  it('should kill the code after five failed attempts so the sixth cannot redeem it', async () => {
    const { devices, service, mint } = fixture();
    mint();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      should((await redeemDirect(service, { code: SECOND_CODE, deviceName: 'phone' }, `peer-${attempt}`)).kind).equal(
        'refused',
      );
    }
    const sixth = await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-six');

    should(sixth).deepEqual({ kind: 'refused' });
    should(devices.records).be.empty();
    should(service.status(PAIRING_ID)?.status).equal('expired');
  });

  it('should not let malformed uploads spend the daemon-wide code-guess budget', async () => {
    const { service, mint } = fixture();
    mint();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      should((await redeemDirect(service, undefined, `garbage-peer-${attempt}`)).kind).equal('refused');
    }
    const legitimate = await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'legitimate-peer');

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
      touch: async () => undefined,
      rotateKey: async () => false,
      setGrants: async () => false,
    };
    const service = new PairingService({
      daemonId: DAEMON_ID,
      daemonName: 'workstation',
      advertisement: { kind: 'address', url: 'https://workstation.example.test', origin: 'operator' },
      carriers: { current: () => CARRIERS },
      clock: base.clock,
      cryptography: base.cryptography,
      devices,
      credentials: base.credentials,
    });
    service.mint();

    const first = redeemDirect(service, { code: CODE, deviceName: 'first' }, 'peer-one');
    const second = redeemDirect(service, { code: CODE, deviceName: 'second' }, 'peer-two');
    release?.();
    const results = await Promise.all([first, second]);

    should(results.map(result => result.kind).sort()).deepEqual(['paired', 'refused']);
  });

  it('should grant at most ten redemptions an hour on each carrier, and leave the code live when refused', async () => {
    const { clock, service } = fixture();
    const pair = async (index: number, carrier: 'direct' | 'relay') => {
      const code = service.mint().code;
      const attempt = { code, deviceName: `device ${String(index)}` };
      // A fresh peer every time, so the per-peer guess window is never what refuses.
      return (
        carrier === 'direct'
          ? await redeemDirect(service, attempt, `peer-${String(index)}`)
          : await redeemRelayed(service, attempt)
      ).kind;
    };

    const relayed = [];
    for (let index = 0; index < PAIRING_GRANTS_PER_HOUR + 1; index += 1) relayed.push(await pair(index, 'relay'));
    // The relay budget is its own: the bound address still pairs.
    const direct = await pair(100, 'direct');
    const code = service.mint().code;
    const refused = await redeemRelayed(service, { code, deviceName: 'later' });
    clock.nowMs += 60 * 60 * 1_000;
    const afterAnHour = await redeemRelayed(service, { code, deviceName: 'later' });

    should(relayed.filter(kind => kind === 'paired')).have.length(PAIRING_GRANTS_PER_HOUR);
    should(relayed.at(-1)).equal('refused');
    should([direct, refused.kind]).deepEqual(['paired', 'refused']);
    // The code a full hour refused was not consumed: it pairs once there is room. (It expired meanwhile,
    // so a fresh one is minted the way a person would.)
    should(afterAnHour.kind).equal('refused');
    const fresh = service.mint().code;
    should((await redeemRelayed(service, { code: fresh, deviceName: 'later' })).kind).equal('paired');
  });

  it('should pair at most thirty-two devices, and pair again once one is removed', async () => {
    const { clock, service } = fixture();
    for (let index = 0; index < PAIRING_MAX_DEVICES; index += 1) {
      if (index % PAIRING_GRANTS_PER_HOUR === 0) clock.nowMs += 60 * 60 * 1_000;
      const code = service.mint().code;
      should((await redeemDirect(service, { code, deviceName: `d${String(index)}` }, `p${String(index)}`)).kind).equal(
        'paired',
      );
    }
    clock.nowMs += 60 * 60 * 1_000;
    const code = service.mint().code;

    const full = await redeemDirect(service, { code, deviceName: 'one too many' }, 'p-full');
    const first = (await service.devices())[0];
    if (first === undefined) throw new Error('no device');
    await service.revokeDevice(first.id, 'admin-cli');
    const roomAgain = await redeemDirect(service, { code, deviceName: 'one too many' }, 'p-full');

    should([full.kind, roomAgain.kind]).deepEqual(['refused', 'paired']);
    should(await service.devices()).have.length(PAIRING_MAX_DEVICES);
  });

  it('should keep endpoint rate limiting independent from the active code attempt budget', async () => {
    const clock = new FakeClock();
    const limiter = new PairingRateLimiter(clock, 1, 60_000);
    const current = fixture({ limiter });
    current.mint();

    await redeemDirect(current.service, { code: SECOND_CODE, deviceName: 'phone' }, 'same-peer');
    const limited = await redeemDirect(current.service, { code: CODE, deviceName: 'phone' }, 'same-peer');
    const otherPeer = await redeemDirect(current.service, { code: CODE, deviceName: 'phone' }, 'other-peer');

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
    current.mint();

    const failed = await redeemDirect(current.service, { code: CODE, deviceName: 'phone' }, 'peer-one');
    const retried = await redeemDirect(current.service, { code: CODE, deviceName: 'phone' }, 'peer-two');

    should(failed.kind).equal('refused');
    should(retried.kind).equal('refused');
    should(current.credentials.all()).be.empty();
  });

  it('should tell the grant observer once, after the device is persisted, with no key or token in it', async () => {
    const grants: PairingGrant[] = [];
    const persistedWhenTold: number[] = [];
    const current = fixture({
      onGranted: async grant => {
        grants.push(grant);
        persistedWhenTold.push(current.devices.records.length);
      },
    });
    current.mint();

    const result = await redeemRelayed(current.service, { code: CODE, deviceName: 'phone' });

    should(result.kind).equal('paired');
    should(grants).deepEqual([
      { deviceId: FIRST_DEVICE_ID, deviceName: 'phone', carrier: 'relay', createdAt: '2026-08-03T12:00:00.000Z' },
    ]);
    should(persistedWhenTold).deepEqual([1]);
    should(JSON.stringify(grants)).not.containEql(DEVICE_KEY);
  });

  it('should keep a device paired when the grant observer rejects, rather than refusing a pairing that happened', async () => {
    const current = fixture({
      onGranted: async () => {
        throw new Error('disk full');
      },
    });
    current.mint();

    const result = await redeemDirect(current.service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    should(result.kind).equal('paired');
    should(current.credentials.get(FIRST_DEVICE_ID)?.publicKey).equal(DEVICE_KEY);
    should(current.devices.records.map(record => record.id)).deepEqual([FIRST_DEVICE_ID]);
  });

  it('should perform the constant-time comparison even when no usable code exists', async () => {
    const comparisons: Array<readonly [string, string]> = [];
    const current = fixture({
      compare: (left, right) => {
        comparisons.push([left, right]);
        return left === right;
      },
    });

    await redeemDirect(current.service, { deviceName: 'phone' }, 'peer-one');
    current.mint();
    await redeemDirect(current.service, { code: SECOND_CODE, deviceName: 'phone' }, 'peer-two');

    should(comparisons).deepEqual([
      ['', '2222-2222'],
      [SECOND_CODE, CODE],
    ]);
  });
});

describe('PairingService revocation', () => {
  it('should end a live code early, leaving nothing to redeem', async () => {
    // Arrange
    const { service, mint } = fixture();
    const minted = mint();

    // Act
    const revoked = service.revoke(minted.pairingId);
    const attempted = await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

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
    const { service, mint } = fixture();
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    const revoked = service.revoke(PAIRING_ID);

    // Assert
    should(revoked).containDeep({ status: 'redeemed', deviceName: 'phone' });
  });

  it('should be idempotent for a code it knows and silent about one it never minted', async () => {
    // Arrange
    const { service, mint } = fixture();
    mint();

    // Act
    const first = service.revoke(PAIRING_ID);
    const second = service.revoke(PAIRING_ID);
    const unknown = service.revoke(`fy_pair_${'z'.repeat(22)}` as PairingId);

    // Assert — two people shutting the same door is the expected use, not an error.
    should(first).deepEqual(second);
    should(unknown).be.undefined();
  });

  it('should project paired devices without their keys, with when they were seen and when they lapse', async () => {
    // Arrange
    const { devices, service, mint } = fixture();
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'Ernest phone' }, 'peer-one');

    // Act
    const listed = await service.devices();

    // Assert — the record HAS a key and the projection has no field for one.
    should(devices.records[0]?.publicKey).equal(DEVICE_KEY);
    should(listed).deepEqual([
      {
        id: FIRST_DEVICE_ID,
        name: 'Ernest phone',
        platform: 'browser',
        createdAt: '2026-08-03T12:00:00.000Z',
        lastSeenAt: '2026-08-03T12:00:00.000Z',
        idleExpiresAt: '2026-09-02T12:00:00.000Z',
        grants: FULL_DEVICE_GRANTS,
        pairedOver: 'direct',
      },
    ]);
    should(JSON.stringify(listed)).not.containEql(DEVICE_KEY);
  });

  it('should project a device that predates the carrier field without inventing one', async () => {
    // Arrange
    const { credentials, service, mint } = fixture();
    await mint();
    await redeemDirect(service, { code: CODE, deviceName: 'Ernest phone' }, 'peer-one');
    const stored = credentials.get(FIRST_DEVICE_ID);
    if (stored === undefined) throw new Error('expected a device');
    const { pairedOver: _carrier, ...older } = stored;
    credentials.refresh(older);

    // Act
    const listed = await service.devices();

    // Assert
    should(listed[0]).not.have.property('pairedOver');
  });

  it('should end a revoked device’s access for the very next request', async () => {
    // THE HALF THAT ACTUALLY REVOKES. Rewriting the document decides what comes back after a restart;
    // dropping the live grant decides whether the next request is served, which is the only one the
    // person holding the lost phone is making.
    // Arrange
    const { credentials, devices, service, mint } = fixture();
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'first' }, 'peer-one');
    mint();
    await redeemDirect(service, { code: SECOND_CODE, deviceName: 'second' }, 'peer-two');

    // Act
    const removed = await service.revokeDevice(FIRST_DEVICE_ID);

    // Assert — the revoked grant is gone from both halves, and the sibling grant is untouched.
    should(removed).be.true();
    should(await service.deviceKey(FIRST_DEVICE_ID)).be.undefined();
    should(credentials.get(SECOND_DEVICE_ID)).not.be.undefined();
    should(devices.records.map(record => record.id)).deepEqual([SECOND_DEVICE_ID]);
  });

  it('should stop authenticating the revoked device when nothing else is paired', async () => {
    // Arrange
    const { credentials, service, mint } = fixture();
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    await service.revokeDevice(FIRST_DEVICE_ID);

    // Assert
    should(credentials.get(FIRST_DEVICE_ID)).be.undefined();
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
    const { devices, service, mint } = fixture({ deviceState: [push] });
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    should(await service.revokeDevice(FIRST_DEVICE_ID)).be.true();

    // Assert
    should(push.forgotten).deepEqual([FIRST_DEVICE_ID]);
    should(devices.records).be.empty();
  });

  it('should close the device’s live connections, and only once its credential no longer verifies', async () => {
    // A socket is authorized once, at the upgrade, so removing the grant alone left a revoked phone's
    // open terminal running. The connections end AFTER the grant is gone: ended any earlier, the
    // device could reconnect on the credential the revocation was about to remove.
    // Arrange
    const live = new LiveDeviceConnections();
    const verifiedAtEnd: Array<string | undefined> = [];
    const connections: DeviceConnectionRevoker = {
      endDevice: deviceId => {
        verifiedAtEnd.push(credentials.get(FIRST_DEVICE_ID)?.publicKey);
        return live.endDevice(deviceId);
      },
    };
    const { credentials, service, mint } = fixture({ connections });
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');
    const ended: string[] = [];
    live.track(FIRST_DEVICE_ID, () => ended.push('terminal'));

    // Act
    should(await service.revokeDevice(FIRST_DEVICE_ID)).be.true();

    // Assert
    should(ended).deepEqual(['terminal']);
    should(verifiedAtEnd).deepEqual([undefined]);
  });

  it('should leave a device’s connections open when there was no grant to revoke', async () => {
    const live = new LiveDeviceConnections();
    const { service } = fixture({ connections: live });
    const ended: string[] = [];
    live.track(FIRST_DEVICE_ID, () => ended.push('terminal'));

    should(await service.revokeDevice(FIRST_DEVICE_ID)).be.false();
    should(ended).be.empty();
  });

  it('should revoke the device first, so a purge that fails leaves it unpaired, never paired without state', async () => {
    // Review L5: purging first left a window in which a still-paired device was served, and a failed
    // revocation left a paired device whose passkeys were gone. The grant goes first now; a failed purge
    // surfaces as an error AFTER the phone has lost its access, and leaves only harmless orphans.
    // Arrange
    const push = new RecordingDeviceState(new Error('the enrolment document could not be written'));
    const { credentials, devices, service, mint } = fixture({ deviceState: [push] });
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    await service.revokeDevice(FIRST_DEVICE_ID).should.be.rejectedWith(/enrolment document/u);

    // Assert
    should(devices.records).be.empty();
    should(credentials.get(FIRST_DEVICE_ID)).be.undefined();
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
    const { credentials, devices, service, mint } = fixture();
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');
    devices.failure = new Error('disk unavailable');

    // Act
    const attempt = await service.revokeDevice(FIRST_DEVICE_ID).then(
      () => 'resolved',
      (reason: unknown) => (reason as Error).message,
    );

    // Assert
    should(attempt).equal('disk unavailable');
    should(credentials.get(FIRST_DEVICE_ID)?.publicKey).equal(DEVICE_KEY);
  });
});

describe('PairingService revocation audit', () => {
  it('should record the actor and the device id once the revocation has happened', async () => {
    // Arrange
    const audit = new RecordingAudit();
    const { service, mint } = fixture({ audit });
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    const removed = await service.revokeDevice(FIRST_DEVICE_ID, 'admin-cli');

    // Assert
    should(removed).be.true();
    should(audit.entries).deepEqual([
      { actor: 'admin-cli', changes: [`device.revoked=${FIRST_DEVICE_ID}`], at: '2026-08-03T12:00:00.000Z' },
    ]);
  });

  it('should record a revocation a governed device asked for under that device', async () => {
    // Arrange
    const audit = new RecordingAudit();
    const { service, mint } = fixture({ audit });
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    await service.revokeDevice(FIRST_DEVICE_ID, `device:${SECOND_DEVICE_ID}`);

    // Assert
    should(audit.entries.map(entry => entry.actor)).deepEqual([`device:${SECOND_DEVICE_ID}`]);
  });

  it('should record nothing for a device that was not there', async () => {
    // Arrange
    const audit = new RecordingAudit();
    const { service } = fixture({ audit });

    // Act
    const removed = await service.revokeDevice(FIRST_DEVICE_ID, 'admin-cli');

    // Assert
    should(removed).be.false();
    should(audit.entries).be.empty();
  });

  it('should record nothing when the revocation itself failed', async () => {
    // Arrange
    const audit = new RecordingAudit();
    const { devices, service, mint } = fixture({ audit });
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');
    devices.failure = new Error('disk unavailable');

    // Act
    await service.revokeDevice(FIRST_DEVICE_ID, 'admin-cli').catch(() => undefined);

    // Assert
    should(audit.entries).be.empty();
  });

  it('should record nothing for a revocation nobody asked for, such as idle expiry', async () => {
    // Arrange
    const audit = new RecordingAudit();
    const { service, mint } = fixture({ audit });
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    await service.revokeDevice(FIRST_DEVICE_ID);

    // Assert
    should(audit.entries).be.empty();
  });

  it('should write the record only after the grant is gone and its connections are closed', async () => {
    // Arrange
    const order: string[] = [];
    const audit = new RecordingAudit(() => order.push('audit'));
    const connections: DeviceConnectionRevoker = { endDevice: () => order.push('connections') };
    const { credentials, service, mint } = fixture({ audit, connections });
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    await service.revokeDevice(FIRST_DEVICE_ID, 'admin-cli');

    // Assert
    should(order).deepEqual(['connections', 'audit']);
    should(credentials.get(FIRST_DEVICE_ID)).be.undefined();
  });

  it('should leave the device revoked and surface the failure when the journal cannot be written', async () => {
    // Arrange
    const audit = new RecordingAudit(undefined, new Error('journal unavailable'));
    const { credentials, service, mint } = fixture({ audit });
    mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    const attempt = await service.revokeDevice(FIRST_DEVICE_ID, 'admin-cli').then(
      () => 'resolved',
      (reason: unknown) => (reason as Error).message,
    );

    // Assert — the stolen phone is gone either way; the missing record is reported, not hidden.
    should(attempt).equal('journal unavailable');
    should(credentials.get(FIRST_DEVICE_ID)).be.undefined();
  });
});

describe('PairingDeviceRegistry', () => {
  const record = (overrides: Partial<PairingDeviceRecord> = {}): PairingDeviceRecord => ({
    id: FIRST_DEVICE_ID,
    daemonId: DAEMON_ID,
    name: 'phone',
    platform: 'browser',
    createdAt: '2026-08-03T12:00:00.000Z',
    lastSeenAt: '2026-08-03T12:00:00.000Z',
    publicKey: DEVICE_KEY,
    grants: LIMITED_DEVICE_GRANTS,
    ...overrides,
  });

  it('should scope every persisted device grant to its daemon', () => {
    const registry = new PairingDeviceRegistry(DAEMON_ID);
    should(() => registry.add(record({ daemonId: `fy_daemon_${'z'.repeat(43)}` as DaemonId }))).throw(
      /different daemon/u,
    );
    should(registry.all()).be.empty();
  });

  it('should refuse to register a grant whose key is not an Ed25519 public key', () => {
    // A grant that can never verify a proof would sit here as a device that silently cannot get in.
    const registry = new PairingDeviceRegistry(DAEMON_ID);
    should(() => registry.add(record({ publicKey: '' }))).throw(/no usable key/u);
    should(() => registry.add(record({ publicKey: toBase64Url(new Uint8Array(44).fill(1)) }))).throw(/no usable key/u);
    should(registry.all()).be.empty();
  });

  it('should answer for a grant by id, forget it, and never resurrect a revoked one on refresh', () => {
    const registry = new PairingDeviceRegistry(DAEMON_ID, [
      record(),
      record({ id: SECOND_DEVICE_ID, publicKey: SECOND_DEVICE_KEY }),
    ]);
    should(registry.get(SECOND_DEVICE_ID)?.publicKey).equal(SECOND_DEVICE_KEY);
    should(registry.remove(FIRST_DEVICE_ID)).be.true();
    should(registry.remove(FIRST_DEVICE_ID)).be.false();
    registry.refresh(record({ lastSeenAt: '2026-08-04T12:00:00.000Z' }));
    should(registry.get(FIRST_DEVICE_ID)).be.undefined();
    registry.refresh(
      record({ id: SECOND_DEVICE_ID, publicKey: SECOND_DEVICE_KEY, lastSeenAt: '2026-08-04T12:00:00.000Z' }),
    );
    should(registry.get(SECOND_DEVICE_ID)?.lastSeenAt).equal('2026-08-04T12:00:00.000Z');
    should(registry.all().map(held => held.id)).deepEqual([SECOND_DEVICE_ID]);
  });
});

describe('PairingService device keys and idle expiry', () => {
  const DAY_MS = 24 * 60 * 60 * 1_000;

  async function paired(options: Parameters<typeof fixture>[0] = {}) {
    const built = fixture(options);
    built.mint();
    const redemption = await redeemDirect(built.service, { code: CODE, deviceName: 'phone' }, 'peer-one');
    if (redemption.kind !== 'paired') throw new Error('expected a pairing');
    return built;
  }

  it('should refuse a key whose proof did not verify exactly as it refuses a wrong code, spending one guess', async () => {
    // The session decides `proven`; here it is one more way to be wrong. A different answer, or a free
    // one, would let a guesser tell a bad key apart from a bad code.
    const { service, mint, devices } = fixture();
    mint();
    for (let attempt = 0; attempt < 5; attempt += 1)
      should(
        (await redeemDirect(service, { code: CODE, deviceName: 'phone' }, `peer-${attempt}`, { proven: false })).kind,
      ).equal('refused');
    // Five unproven attempts spent the code, so even the right one with a proven key is refused now.
    should((await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-last')).kind).equal('refused');
    should(devices.records).be.empty();
  });

  it('should refuse a proven key that is not an Ed25519 public key', async () => {
    const { service, mint } = fixture();
    mint();
    const refused = await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer', {
      deviceKey: 'not-a-key',
    });
    should(refused.kind).equal('refused');
  });

  it('should spend the relay budget for an unproven relayed key and leave the direct path alone', async () => {
    const { service, mint } = fixture();
    mint();
    for (let attempt = 0; attempt < 5; attempt += 1)
      await redeemRelayed(service, { code: CODE, deviceName: 'phone' }, { proven: false });
    should((await redeemRelayed(service, { code: CODE, deviceName: 'phone' })).kind).equal('refused');
    should((await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'lan-peer')).kind).equal('paired');
  });

  it('should answer a key for a live device and nothing for one it never paired', async () => {
    const { service } = await paired();
    should(await service.deviceKey(FIRST_DEVICE_ID)).equal(DEVICE_KEY);
    should(await service.deviceKey(SECOND_DEVICE_ID)).be.undefined();
  });

  it('should expire a device unused for thirty days when it next tries, and take its connections with it', async () => {
    const live = new LiveDeviceConnections();
    const { service, clock, devices } = await paired({ connections: live });
    const ended: string[] = [];
    live.track(FIRST_DEVICE_ID, () => ended.push('terminal'));
    clock.nowMs += 30 * DAY_MS - 1;
    should(await service.deviceKey(FIRST_DEVICE_ID)).equal(DEVICE_KEY);
    clock.nowMs += 1;

    should(await service.deviceKey(FIRST_DEVICE_ID)).be.undefined();
    should(devices.records).be.empty();
    should(ended).deepEqual(['terminal']);
  });

  it('should keep a device that keeps being seen, and push its expiry out with each sighting', async () => {
    const { service, clock } = await paired();
    clock.nowMs += 20 * DAY_MS;
    service.seen(FIRST_DEVICE_ID);
    clock.nowMs += 20 * DAY_MS;

    should(await service.deviceKey(FIRST_DEVICE_ID)).equal(DEVICE_KEY);
    const [listed] = await service.devices();
    should(listed?.lastSeenAt).equal('2026-08-23T12:00:00.000Z');
    should(listed?.idleExpiresAt).equal('2026-09-22T12:00:00.000Z');
  });

  it('should write a sighting to disk at most once an hour, and refresh the held grant when it lands', async () => {
    const { service, clock, devices, credentials } = await paired();
    service.seen(FIRST_DEVICE_ID);
    clock.nowMs += 59 * 60 * 1_000;
    service.seen(FIRST_DEVICE_ID);
    should(devices.touched).be.empty();

    clock.nowMs += 60 * 1_000;
    service.seen(FIRST_DEVICE_ID);
    // A burst while the write is in flight writes once.
    service.seen(FIRST_DEVICE_ID);
    await Promise.resolve();
    await Promise.resolve();

    should(devices.touched).deepEqual([{ id: FIRST_DEVICE_ID, lastSeenAt: '2026-08-03T13:00:00.000Z' }]);
    should(credentials.get(FIRST_DEVICE_ID)?.lastSeenAt).equal('2026-08-03T13:00:00.000Z');
  });

  it('should drop a failed sighting write without disturbing the grant, and ignore a device it does not hold', async () => {
    const { service, clock, devices, credentials } = await paired();
    devices.touchFailure = new Error('disk unavailable');
    clock.nowMs += 2 * 60 * 60 * 1_000;
    service.seen(FIRST_DEVICE_ID);
    service.seen(SECOND_DEVICE_ID);
    await Promise.resolve();
    await Promise.resolve();

    should(devices.touched.map(touch => touch.id)).deepEqual([FIRST_DEVICE_ID]);
    should(credentials.get(FIRST_DEVICE_ID)?.lastSeenAt).equal('2026-08-03T12:00:00.000Z');
    // The in-memory sighting still counts, so the failed write cannot shorten the device's life.
    should(await service.deviceKey(FIRST_DEVICE_ID)).equal(DEVICE_KEY);
  });

  it('should expire every idle device at once, and say how many', async () => {
    const { service, clock, mint } = await paired();
    mint();
    await redeemDirect(service, { code: SECOND_CODE, deviceName: 'laptop' }, 'peer-two', {
      deviceKey: SECOND_DEVICE_KEY,
    });
    clock.nowMs += 29 * DAY_MS;
    service.seen(SECOND_DEVICE_ID);
    clock.nowMs += DAY_MS;

    should(await service.expireIdleDevices()).equal(1);
    should((await service.devices()).map(device => device.id)).deepEqual([SECOND_DEVICE_ID]);
    should(await service.expireIdleDevices()).equal(0);
  });

  it('should not count an idle device it could not remove', async () => {
    const { service, clock, devices } = await paired();
    devices.failure = new Error('disk unavailable');
    clock.nowMs += 31 * DAY_MS;

    should(await service.expireIdleDevices()).equal(0);
    should(await service.deviceKey(FIRST_DEVICE_ID)).be.undefined();
  });
});

describe('PairingService idle period setting', () => {
  const DAY_MS = 24 * 60 * 60 * 1_000;

  async function paired(days: { current: number }) {
    const built = fixture({ idleExpiryDays: () => days.current });
    built.mint();
    const redemption = await redeemDirect(built.service, { code: CODE, deviceName: 'phone' }, 'peer-one');
    if (redemption.kind !== 'paired') throw new Error('expected a pairing');
    return { ...built, redemption };
  }

  it('should tell a device the period the machine holds now, not the default', async () => {
    const { redemption } = await paired({ current: 7 });
    should(redemption.response.idleExpiryDays).equal(7);
  });

  it('should project the expiry from the setting and follow it when it is shortened', async () => {
    const days = { current: 30 };
    const { service } = await paired(days);
    should((await service.devices())[0]?.idleExpiresAt).equal('2026-09-02T12:00:00.000Z');

    days.current = 3;

    should((await service.devices())[0]?.idleExpiresAt).equal('2026-08-06T12:00:00.000Z');
  });

  it('should expire a device at the shortened period when it next tries, not at thirty days', async () => {
    const days = { current: 30 };
    const { service, clock, devices } = await paired(days);
    clock.nowMs += 5 * DAY_MS;
    should(await service.deviceKey(FIRST_DEVICE_ID)).equal(DEVICE_KEY);

    days.current = 5;

    should(await service.deviceKey(FIRST_DEVICE_ID)).be.undefined();
    should(devices.records).be.empty();
  });

  it('should sweep at the shortened period, and keep a device the longer period still allows', async () => {
    const days = { current: 30 };
    const { service, clock } = await paired(days);
    clock.nowMs += 10 * DAY_MS;
    should(await service.expireIdleDevices()).equal(0);

    days.current = 10;

    should(await service.expireIdleDevices()).equal(1);
  });

  it('should count the idle period in the day it was given, so the shortest one can be driven in seconds', async () => {
    // B20: one day is the shortest period a machine may set, and nothing could wait one out end to end.
    const built = fixture({ idleExpiryDays: () => 1, idleDayMs: 5_000 });
    built.mint();
    const redemption = await redeemDirect(built.service, { code: CODE, deviceName: 'phone' }, 'peer-one');
    if (redemption.kind !== 'paired') throw new Error('expected a pairing');

    built.clock.nowMs += 4_999;
    const before = await built.service.deviceKey(FIRST_DEVICE_ID);
    const counted = built.service.devicesIdleLongerThan(1);
    built.clock.nowMs += 1;

    should(before).equal(DEVICE_KEY);
    should(counted).equal(0);
    should(built.service.devicesIdleLongerThan(1)).equal(1);
    should(await built.service.deviceKey(FIRST_DEVICE_ID)).be.undefined();
  });

  it('should count what a period would end without ending any of it', async () => {
    const days = { current: 30 };
    const { service, clock, devices } = await paired(days);
    clock.nowMs += 10 * DAY_MS;

    should(service.devicesIdleLongerThan(11)).equal(0);
    should(service.devicesIdleLongerThan(10)).equal(1);
    should(service.devicesIdleLongerThan(1)).equal(1);
    should(devices.records).have.length(1);
    should(await service.deviceKey(FIRST_DEVICE_ID)).equal(DEVICE_KEY);
  });

  it('should count a device seen meanwhile by when it was last seen, not by its last write', async () => {
    const { service, clock } = await paired({ current: 30 });
    clock.nowMs += 10 * DAY_MS;
    service.seen(FIRST_DEVICE_ID);
    clock.nowMs += 2 * DAY_MS;

    should(service.devicesIdleLongerThan(3)).equal(0);
    should(service.devicesIdleLongerThan(2)).equal(1);
  });
});

describe('PairingService device key rotation', () => {
  const ROTATED_KEY = toBase64Url(
    new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, ...new Array(32).fill(7)]),
  );
  const DAY_MS = 24 * 60 * 60 * 1_000;

  async function paired() {
    const built = fixture();
    built.mint();
    const redemption = await redeemDirect(built.service, { code: CODE, deviceName: 'phone' }, 'peer-one');
    if (redemption.kind !== 'paired') throw new Error('expected a pairing');
    return built;
  }

  it('should count a key’s age from the pairing until it is replaced, then from the replacement', async () => {
    const { service, clock } = await paired();
    should(service.keyIssuedAt(FIRST_DEVICE_ID)).equal(Date.parse('2026-08-03T12:00:00.000Z'));

    clock.nowMs += 40 * DAY_MS;
    should(await service.rotateDeviceKey(FIRST_DEVICE_ID, ROTATED_KEY)).be.true();

    should(service.keyIssuedAt(FIRST_DEVICE_ID)).equal(Date.parse('2026-09-12T12:00:00.000Z'));
  });

  it('should have no key age for a device it never paired', async () => {
    const { service } = await paired();
    should(service.keyIssuedAt(SECOND_DEVICE_ID)).be.undefined();
  });

  it('should write the new key first and then answer with it, keeping the rest of the grant', async () => {
    const { service, clock, devices, credentials } = await paired();
    clock.nowMs += DAY_MS;

    should(await service.rotateDeviceKey(FIRST_DEVICE_ID, ROTATED_KEY)).be.true();

    should(devices.rotated).deepEqual([
      { id: FIRST_DEVICE_ID, publicKey: ROTATED_KEY, keyRotatedAt: '2026-08-04T12:00:00.000Z' },
    ]);
    should(await service.deviceKey(FIRST_DEVICE_ID)).equal(ROTATED_KEY);
    should(credentials.get(FIRST_DEVICE_ID)).containEql({
      name: 'phone',
      createdAt: '2026-08-03T12:00:00.000Z',
      keyRotatedAt: '2026-08-04T12:00:00.000Z',
    });
  });

  it('should report a device that is gone without writing anything', async () => {
    const { service, devices } = await paired();

    should(await service.rotateDeviceKey(SECOND_DEVICE_ID, ROTATED_KEY)).be.false();

    should(devices.rotated).be.empty();
  });

  it('should keep the old key when the store says the device was already gone', async () => {
    const { service, devices, credentials } = await paired();
    devices.rotateResult = false;

    should(await service.rotateDeviceKey(FIRST_DEVICE_ID, ROTATED_KEY)).be.false();

    should(credentials.get(FIRST_DEVICE_ID)?.publicKey).equal(DEVICE_KEY);
    should(credentials.get(FIRST_DEVICE_ID)?.keyRotatedAt).be.undefined();
    should(await service.deviceKey(FIRST_DEVICE_ID)).equal(DEVICE_KEY);
  });

  it('should keep the old key when the write fails, rather than adopting a key it could not keep', async () => {
    const { service, devices, credentials } = await paired();
    devices.rotateFailure = new Error('disk unavailable');

    await service.rotateDeviceKey(FIRST_DEVICE_ID, ROTATED_KEY).then(
      () => should.fail(true, false, 'expected the write failure to surface'),
      (failure: Error) => should(failure.message).equal('disk unavailable'),
    );

    should(credentials.get(FIRST_DEVICE_ID)?.publicKey).equal(DEVICE_KEY);
  });

  it('should not roll a rotated key back when a sighting write that began before it lands after', async () => {
    // THE RACE. A sighting copies the record, writes, then refreshes. A rotation that lands in between
    // must survive: refreshing with the copy would restore the key this daemon has just forgotten.
    const { service, clock, devices, credentials } = await paired();
    let release: (() => void) | undefined;
    devices.touchGate = new Promise<void>(resolve => {
      release = resolve;
    });
    clock.nowMs += 2 * 60 * 60 * 1_000;
    service.seen(FIRST_DEVICE_ID);

    should(await service.rotateDeviceKey(FIRST_DEVICE_ID, ROTATED_KEY)).be.true();
    release?.();
    await new Promise(resolve => setTimeout(resolve, 0));

    should(credentials.get(FIRST_DEVICE_ID)?.publicKey).equal(ROTATED_KEY);
    should(credentials.get(FIRST_DEVICE_ID)?.lastSeenAt).equal('2026-08-03T14:00:00.000Z');
  });

  it('should not bring a device back when it was revoked while its sighting was being written', async () => {
    const { service, clock, devices, credentials } = await paired();
    let release: (() => void) | undefined;
    devices.touchGate = new Promise<void>(resolve => {
      release = resolve;
    });
    clock.nowMs += 2 * 60 * 60 * 1_000;
    service.seen(FIRST_DEVICE_ID);

    should(await service.revokeDevice(FIRST_DEVICE_ID)).be.true();
    release?.();
    await new Promise(resolve => setTimeout(resolve, 0));

    should(credentials.get(FIRST_DEVICE_ID)).be.undefined();
  });
});

describe('PairingService redemption over a relay', () => {
  it('should pair through a port that takes no request, and answer with the whole published set', async () => {
    // Arrange
    const { devices, service, mint } = fixture();
    mint();

    // Act
    const redemption = await redeemRelayed(service, { code: CODE, deviceName: 'phone' });

    // Assert — the same grant a direct redemption produces, from the same code, `carriers` included:
    // that field is what a relay-paired device navigates by afterwards.
    should(redemption.kind).equal('paired');
    if (redemption.kind !== 'paired') throw new Error('expected a pairing');
    should(redemption.response.carriers).deepEqual(CARRIERS);
    should(redemption.response.daemonId).equal(DAEMON_ID);
    should(devices.records).have.length(1);
    should(devices.records[0]?.name).equal('phone');
    // Assert — the carrier is kept and projected, so the other devices' notice can say "over the relay".
    should(devices.records[0]?.pairedOver).equal('relay');
    should((await service.devices())[0]?.pairedOver).equal('relay');
    // Assert — single-use, on either carrier.
    should((await redeemRelayed(service, { code: CODE, deviceName: 'again' })).kind).equal('refused');
  });

  it('should spend a relay budget that can never expire a code a LAN device could still redeem', async () => {
    // Arrange
    const { devices, service, mint } = fixture();
    mint();

    // Act — five wrong guesses from the internet, which is the direct budget's whole size.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      should((await redeemRelayed(service, { code: SECOND_CODE, deviceName: 'phone' })).kind).equal('refused');
    }

    // Assert — the code is ALIVE. This is the entire reason the counters are separate: a fingerprint
    // is public, so a shared budget would let anybody on earth kill a code sitting on somebody's desk.
    should(service.status(PAIRING_ID)?.status).equal('pending');
    const direct = await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'lan-peer');
    should(direct.kind).equal('paired');
    should(devices.records).have.length(1);
  });

  it('should close only the relay path once its own budget is spent', async () => {
    // Arrange
    const { service, mint } = fixture();
    mint();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await redeemRelayed(service, { code: SECOND_CODE, deviceName: 'phone' });
    }

    // Act — the RIGHT code, arriving over the carrier whose budget is spent.
    const relayed = await redeemRelayed(service, { code: CODE, deviceName: 'phone' });

    // Assert — refused there, and still redeemable here.
    should(relayed).deepEqual({ kind: 'refused' });
    should((await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'lan-peer')).kind).equal('paired');
  });

  it('should never spend the relay budget from the direct path either', async () => {
    // Arrange
    const { service, mint } = fixture();
    mint();

    // Act — the direct budget is exhausted, which expires the code entirely.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await redeemDirect(service, { code: SECOND_CODE, deviceName: 'phone' }, `peer-${attempt}`);
    }

    // Assert — an expired code is gone for everybody. The asymmetry is deliberate: a relayed guesser
    // must not reach the LAN's budget, while the owner's own five guesses still end the code.
    should(service.status(PAIRING_ID)?.status).equal('expired');
    should((await redeemRelayed(service, { code: CODE, deviceName: 'phone' })).kind).equal('refused');
  });

  it('should refuse identically with no code minted, a bad name, and an expired one', async () => {
    // Arrange — nothing has ever been minted, so there is nothing to guess.
    const never = fixture();
    const expired = fixture();
    expired.mint();
    expired.clock.nowMs += 120_000;
    const unusable = fixture();
    unusable.mint();

    // Act
    const refusals = await Promise.all([
      redeemRelayed(never.service, { code: CODE, deviceName: 'phone' }),
      redeemRelayed(expired.service, { code: CODE, deviceName: 'phone' }),
      redeemRelayed(unusable.service, { code: CODE, deviceName: '' }),
      redeemRelayed(unusable.service, { code: 'not-a-code', deviceName: 'phone' }),
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
    should((await redeemRelayed(service, { code: CODE, deviceName: 'phone' })).kind).equal('refused');

    // Assert — the work happened anyway, against the dummy.
    should(compared).have.length(1);
    should(compared[0]).not.equal(CODE);
  });

  it('should consume the code and refuse when durable storage fails a relayed redemption', async () => {
    // Arrange
    const { devices, service, mint } = fixture();
    devices.failure = new Error('the state home is read-only');
    mint();

    // Act
    const redemption = await redeemRelayed(service, { code: CODE, deviceName: 'phone' });

    // Assert — the same fail-closed answer the direct path gives: the code is spent, nothing paired.
    should(redemption).deepEqual({ kind: 'refused' });
    should(service.status(PAIRING_ID)?.status).equal('expired');
  });
});

describe('PairingService device grants', () => {
  async function paired() {
    const built = fixture();
    built.mint();
    const redemption = await redeemDirect(built.service, { code: CODE, deviceName: 'phone' }, 'peer-one');
    if (redemption.kind !== 'paired') throw new Error('expected a pairing');
    return built;
  }
  const WIDENED: CapabilityGrants = { ...LIMITED_DEVICE_GRANTS, terminal: { use: true, configure: false } };
  const limited = async () => {
    const built = fixture();
    built.service.mint('limited');
    const redemption = await redeemDirect(built.service, { code: CODE, deviceName: 'phone' }, 'peer-one');
    if (redemption.kind !== 'paired') throw new Error('expected a pairing');
    return built;
  };

  it('should give a newly paired device full access behind the unlock, and report it', async () => {
    // Arrange
    const { service } = await paired();

    // Act + Assert
    should(service.deviceGrants(FIRST_DEVICE_ID)).deepEqual(FULL_DEVICE_GRANTS);
    should((await service.devices())[0]?.grants).deepEqual(FULL_DEVICE_GRANTS);
  });

  it('should give a device paired with a limited code fleet.use only, and report it', async () => {
    // Arrange
    const { service } = await limited();

    // Act + Assert
    should(service.deviceGrants(FIRST_DEVICE_ID)).deepEqual(LIMITED_DEVICE_GRANTS);
    should((await service.devices())[0]?.grants).deepEqual(LIMITED_DEVICE_GRANTS);
  });

  it('should write a change to the document first, then to the live grant the boundary reads', async () => {
    // Arrange
    const { service, devices, credentials } = await paired();

    // Act
    const changed = await service.setDeviceGrants(FIRST_DEVICE_ID, WIDENED);

    // Assert
    should(changed).be.true();
    should(devices.records[0]?.grants).deepEqual(WIDENED);
    should(credentials.get(FIRST_DEVICE_ID)?.grants).deepEqual(WIDENED);
  });

  it('should change nothing live when the document refuses the write', async () => {
    // Arrange
    const { service, devices, credentials } = await paired();
    devices.failure = new Error('disk unavailable');

    // Act + Assert
    await should(service.setDeviceGrants(FIRST_DEVICE_ID, LIMITED_DEVICE_GRANTS)).be.rejectedWith('disk unavailable');
    should(credentials.get(FIRST_DEVICE_ID)?.grants).deepEqual(FULL_DEVICE_GRANTS);
  });

  it('should report a device it does not hold, or one revoked mid-write, as unchanged', async () => {
    // Arrange
    const { service, devices } = await paired();

    // Act
    const unknown = await service.setDeviceGrants(SECOND_DEVICE_ID, WIDENED);
    devices.records = [];
    const vanished = await service.setDeviceGrants(FIRST_DEVICE_ID, WIDENED);

    // Assert
    should([unknown, vanished]).deepEqual([false, false]);
    should(service.deviceGrants(SECOND_DEVICE_ID)).be.undefined();
  });

  it('should keep a grant change that lands while a sighting is being written', async () => {
    // The sighting's refresh used to copy the record it read BEFORE its write; a grant change made in
    // between would then be undone in memory while the document kept it.
    // Arrange
    const { service, clock, credentials } = await paired();
    clock.nowMs += 61 * 60 * 1_000;

    // Act
    service.seen(FIRST_DEVICE_ID);
    await service.setDeviceGrants(FIRST_DEVICE_ID, WIDENED);
    await new Promise(resolve => setTimeout(resolve, 0));

    // Assert
    should(credentials.get(FIRST_DEVICE_ID)?.grants).deepEqual(WIDENED);
    should(credentials.get(FIRST_DEVICE_ID)?.lastSeenAt).equal('2026-08-03T13:01:00.000Z');
  });

  it('should not resurrect a device revoked while its sighting was being written', async () => {
    // Arrange
    const { service, clock, credentials } = await paired();
    clock.nowMs += 61 * 60 * 1_000;

    // Act
    service.seen(FIRST_DEVICE_ID);
    credentials.remove(FIRST_DEVICE_ID);
    await Promise.resolve();
    await Promise.resolve();

    // Assert
    should(credentials.get(FIRST_DEVICE_ID)).be.undefined();
  });
});

describe('PairingService full-access codes', () => {
  it('should give the device that redeems a `full` code every capability, and echo the choice at the mint', async () => {
    // Arrange
    const { service } = fixture();
    const minted = service.mint('full');

    // Act
    const redemption = await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Assert
    should(redemption.kind).equal('paired');
    should(minted.grants).equal('full');
    should(service.deviceGrants(FIRST_DEVICE_ID)).deepEqual(FULL_DEVICE_GRANTS);
    // The link carries nothing about what the code grants.
    should(minted.pairUrl).not.match(/full|grant/u);
  });

  it('should give a default code’s device full access, and let a newer mint replace the choice', async () => {
    // Arrange
    const { service } = fixture();
    service.mint('limited');
    const minted = service.mint();

    // Act
    await redeemDirect(service, { code: SECOND_CODE, deviceName: 'phone' }, 'peer-one');

    // Assert
    should(minted.grants).equal('full');
    should(service.deviceGrants(FIRST_DEVICE_ID)).deepEqual(FULL_DEVICE_GRANTS);
  });

  it('should give a limited code’s device fleet.use only, and echo the choice at the mint', async () => {
    // Arrange
    const { service } = fixture();
    const minted = service.mint('limited');

    // Act
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Assert
    should(minted.grants).equal('limited');
    should(service.deviceGrants(FIRST_DEVICE_ID)).deepEqual(LIMITED_DEVICE_GRANTS);
  });
});
