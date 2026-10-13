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
} from '@ferretry/protocol';
import { toBase64Url } from '@ferretry/relay';
import should from 'should';
import {
  type DeviceConnectionRevoker,
  LiveDeviceConnections,
  type PairingCryptography,
  type PairingDeviceRecord,
  PairingDeviceRegistry,
  type PairingDeviceStore,
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

  async touch(id: string, lastSeenAt: string): Promise<void> {
    this.touched.push({ id, lastSeenAt });
    if (this.touchFailure !== undefined) throw this.touchFailure;
    this.records = this.records.map(record => (record.id === id ? { ...record, lastSeenAt } : record));
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

/**
 * Whether this machine has an operator password — the ONE fact the first-password requirement reads.
 *
 * It can also RAISE, because the real verifier does: a truncated file is not a machine with no
 * password, and a fake that could only answer `false` would let "damage read as absence" pass here.
 */
class FakeOperatorPassword {
  constructor(
    private readonly present: boolean,
    private readonly failure?: Error,
  ) {}

  async isSet(): Promise<boolean> {
    if (this.failure !== undefined) throw this.failure;
    return this.present;
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
    /** What this daemon resolved at boot, for a case about what a redemption hands out. */
    readonly carriers?: readonly DaemonCarrier[];
    /** The rendezvous the composition root proved a fresh device could discover, if any. */
    readonly discoveredRelayUrl?: string;
    /**
     * Whether this machine has an operator password. TRUE by default, because every case below is
     * about the code rather than about the requirement — the requirement's own cases say so out loud.
     */
    readonly passwordSet?: boolean;
    /** A verifier this daemon cannot read, for the case that must not be treated as "no password". */
    readonly passwordFailure?: Error;
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
    carriers: options.carriers ?? CARRIERS,
    ...(options.discoveredRelayUrl === undefined ? {} : { discoveredRelayUrl: options.discoveredRelayUrl }),
    clock,
    cryptography,
    devices,
    credentials,
    rateLimiter: options.limiter,
    compare: options.compare,
    deviceState: options.deviceState,
    ...(options.connections === undefined ? {} : { connections: options.connections }),
    operatorPassword: new FakeOperatorPassword(options.passwordSet ?? true, options.passwordFailure),
    clientName: 'fy',
  });
  /**
   * The minted code, with the requirement's answer already read.
   *
   * Every case that is about a CODE goes through this, so none of them can accidentally assert against
   * a refusal object; the cases that are about the REQUIREMENT call `service.mint()` directly and read
   * the union themselves.
   */
  const mint = async () => {
    const outcome = await service.mint();
    if (outcome.kind !== 'minted') throw new Error(`expected a minted code, got a refusal: ${outcome.reason}`);
    return outcome.response;
  };
  return { clock, cryptography, devices, credentials, service, mint };
}

describe('PairingService minting and status', () => {
  it('should mint the fixed-TTL code and daemon-owned fragment URL', async () => {
    const { service, mint } = fixture();

    const minted = await mint();

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
    });
    should(service.status(PAIRING_ID)).deepEqual({
      pairingId: PAIRING_ID,
      status: 'pending',
      expiresAt: '2026-08-03T12:02:00.000Z',
    });
  });

  it('should refuse to mint on a machine with no operator password, and name the way through', async () => {
    // THE GUARANTEE, AND IT IS HERE RATHER THAN IN A CLIENT. Pairing is the moment access leaves this
    // machine, and a device paired to a passwordless host arrives able to configure the fleet. The rule
    // used to live in the browser, which left `fy pair` handing out a key before the lock existed —
    // this is the same rule below BOTH doors, so which one somebody walks through does not matter.
    // Arrange
    const { service } = fixture({ passwordSet: false });

    // Act
    const refused = await service.mint();

    // Assert — a refusal, and one that carries the remedy at the point of decision.
    should(refused.kind).equal('refused');
    if (refused.kind !== 'refused') throw new Error('expected a refusal');
    should(refused.reason).match(/no operator password/u);
    should(refused.reason).match(/fy daemon password set/u);
    // NOTHING WAS MINTED. Not a code that is then withheld, not an observation somebody can poll: the
    // check runs before any state moves, so there is no pairing to find.
    should(service.status(PAIRING_ID)).be.undefined();
  });

  it('should refuse to mint when it cannot READ whether a password exists, rather than assuming one', async () => {
    // DAMAGE IS NOT ABSENCE AND IT IS NOT PRESENCE EITHER. A truncated verifier read as "no password"
    // would silently disarm the requirement on the one machine whose state is already known to be
    // broken; read as "password present" it would mint on an assumption. Both fail closed, and the two
    // refusals say different things because the remedies are different.
    // Arrange
    const { service } = fixture({ passwordFailure: new Error('operator-password.json is not JSON') });

    // Act
    const refused = await service.mint();

    // Assert
    if (refused.kind !== 'refused') throw new Error('expected a refusal');
    should(refused.reason).match(/could not read whether it has an operator password/u);
    // The daemon's own words about the damage travel with it, so an operator has something to repair.
    should(refused.reason).match(/operator-password\.json is not JSON/u);
    should(refused.reason).match(/fy daemon password set/u);
    should(service.status(PAIRING_ID)).be.undefined();
  });

  it('should leave a live code alone when the machine stops having a password underneath it', async () => {
    // The requirement is checked BEFORE anything moves, which is why this holds: a machine that stops
    // answering "yes" while a code is on screen has refused the NEXT mint, not destroyed the code
    // somebody is already walking to their phone to scan. Expiring it here would be a rule that
    // reaches backwards.
    //
    // NO SUPPORTED VERB PRODUCES THIS ANY MORE — removing a password is gone precisely because it left
    // paired devices on an ungated machine — so the reachable cause is now a state file edited or
    // restored by hand. The ordering property is asserted at the port for whatever the cause is,
    // because a rule that only holds for the causes somebody enumerated is not a rule.
    // Arrange — a machine whose verifier answers differently on the second read.
    const answers = [true, false];
    const { service } = fixture();
    const shifting = new PairingService({
      daemonId: DAEMON_ID,
      daemonName: 'workstation',
      advertisement: { kind: 'address', url: 'https://workstation.example.test', origin: 'operator' },
      carriers: CARRIERS,
      clock: new FakeClock(),
      cryptography: new FakeCryptography(),
      devices: new RecordingDevices(),
      credentials: new PairingDeviceRegistry(DAEMON_ID),
      operatorPassword: { isSet: async () => answers.shift() ?? false },
      clientName: 'fy',
    });
    const first = await shifting.mint();
    if (first.kind !== 'minted') throw new Error('expected a minted code');

    // Act — the password is gone by the time the second code is asked for.
    const second = await shifting.mint();

    // Assert
    should(second.kind).equal('refused');
    should(shifting.status(first.response.pairingId)).containDeep({ status: 'pending' });
    // And the code still redeems, because it was minted while the machine had its gate.
    const redeemed = await redeemDirect(shifting, { code: first.response.code, deviceName: 'phone' }, 'peer');
    should(redeemed.kind).equal('paired');
    // The unrelated fixture is untouched — this case invents no shared state.
    should(service.status(PAIRING_ID)).be.undefined();
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

    const mintedWithoutDiscovery = await selfHosted.mint();
    const redemption = await redeemRelayed(selfHosted.service, { code: CODE, deviceName: 'phone' });

    should(mintedWithoutDiscovery.discoveredRelayUrl).be.undefined();
    if (redemption.kind !== 'paired') throw new Error('expected a pairing');
    // The set a device navigates by is unchanged — this narrowing touches disclosure, not publication.
    should(redemption.response.carriers).deepEqual(carriers);

    const discovered = fixture({ carriers, discoveredRelayUrl: 'wss://hosted.example.test/fy' });
    should((await discovered.mint()).discoveredRelayUrl).equal('wss://hosted.example.test/fy');
  });

  it('should mint the same fragment whether or not a rendezvous is discoverable', async () => {
    // BYTE-IDENTICAL, AND THAT IS THE POINT OF THE NARROWING. The disclosure is host-facing; the link
    // is the one every daemon has ever written, so no reader anywhere is asked to learn a new form.
    const expected =
      'https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fworkstation.example.test%2F;code=7F3K-Q2ND;fp=fy_daemon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const direct = fixture({ carriers: [{ kind: 'direct', url: 'https://workstation.example.test' }] });
    const relayed = fixture({ discoveredRelayUrl: 'wss://hosted.example.test/fy' });

    const withoutRelay = await direct.mint();
    const withRelay = await relayed.mint();

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

    const withoutDiscovery = pairingMintOutcome(await selfHosted.mint());
    const withDiscovery = pairingMintOutcome(await discovered.mint());

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

    const minted = await mint();

    should(minted).containDeep({ reach: 'local-only', daemonUrl: 'http://127.0.0.1:7431/' });
    should('refusal' in minted).be.false();
  });

  it('should mint the valid local-only link derived from a raw IPv6 loopback host', async () => {
    // The shared decision accepts operator host spellings, including raw IPv6. This crosses the next
    // boundary too: the service normalises the URL and the protocol verifies its fragment, so an
    // unbracketed authority cannot hide behind a kind-only decision test.
    const advertisement = decideAdvertisement({ host: '::1', port: 7_431 });
    const { mint } = fixture({ advertisement });

    const minted = await mint();

    should(minted).containDeep({ reach: 'local-only', daemonUrl: 'http://[::1]:7431/' });
    if (minted.pairUrl === undefined) throw new Error('a local-only advertisement must still mint its link');
    should(new URL(minted.pairUrl).hash).containEql(encodeURIComponent('http://[::1]:7431/'));
  });

  it('should mint a code with no link at all when there is no address to hand out', async () => {
    // A wildcard bind serves normally and has nothing to advertise. The CODE is still minted, because
    // somebody who points a browser at this machine themselves can still redeem it; only the link is
    // withheld, with the reason attached.
    const { service, mint } = fixture({ advertisement: { kind: 'none', refusal: 'wildcard-bind' } });

    const minted = await mint();

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

    const first = await mint();
    const second = await mint();

    should('reach' in first && first.reach).equal('local-only');
    should('reach' in second && second.reach).equal('local-only');
    should(service.mint.length).equal(0);
  });

  it('should expire a superseded or timed-out mint and refuse an unknown status handle', async () => {
    const { clock, service, mint } = fixture();
    await mint();
    await mint();

    should(service.status(PAIRING_ID)?.status).equal('expired');
    clock.nowMs += 120_000;
    should(service.status(SECOND_PAIRING_ID)?.status).equal('expired');
    should(service.status(`fy_pair_${'z'.repeat(22)}` as PairingId)).be.undefined();
  });
});

describe('PairingService redemption', () => {
  it('should atomically consume a code, persist only its public key, and acknowledge the bounded name', async () => {
    const { credentials, devices, service, mint } = fixture();
    await mint();

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
        publicKey: DEVICE_KEY,
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
    await mint();

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
        carriers: [{ kind: 'direct', url: 'https://operator:hunter2@workstation.example.test' }],
        clock: new FakeClock(),
        cryptography: new FakeCryptography(),
        devices,
        credentials,
        operatorPassword: new FakeOperatorPassword(true),
        clientName: 'fy',
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
    await mint();
    const first = await redeemDirect(service, { code: CODE, deviceName: 'first' }, '198.51.100.3');
    await mint();
    const second = await redeemDirect(service, { code: SECOND_CODE, deviceName: 'second' }, '198.51.100.4');

    // Assert
    if (first.kind !== 'paired' || second.kind !== 'paired') throw new Error('expected two pairings');
    should([first.response.carriers, second.response.carriers]).deepEqual([CARRIERS, CARRIERS]);
  });

  it('should give wrong, malformed, expired, and already-consumed codes the same refusal', async () => {
    const wrong = fixture();
    await wrong.mint();
    const malformed = fixture();
    await malformed.mint();
    const expired = fixture();
    await expired.mint();
    expired.clock.nowMs += 120_000;
    const consumed = fixture();
    await consumed.mint();
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
    await mint();

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
    await mint();

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
      operatorPassword: new FakeOperatorPassword(true),
      clientName: 'fy',
    });
    const minted = await service.mint();
    if (minted.kind !== 'minted') throw new Error('expected a minted code');

    const first = redeemDirect(service, { code: CODE, deviceName: 'first' }, 'peer-one');
    const second = redeemDirect(service, { code: CODE, deviceName: 'second' }, 'peer-two');
    release?.();
    const results = await Promise.all([first, second]);

    should(results.map(result => result.kind).sort()).deepEqual(['paired', 'refused']);
  });

  it('should keep endpoint rate limiting independent from the active code attempt budget', async () => {
    const clock = new FakeClock();
    const limiter = new PairingRateLimiter(clock, 1, 60_000);
    const current = fixture({ limiter });
    await current.mint();

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
    await current.mint();

    const failed = await redeemDirect(current.service, { code: CODE, deviceName: 'phone' }, 'peer-one');
    const retried = await redeemDirect(current.service, { code: CODE, deviceName: 'phone' }, 'peer-two');

    should(failed.kind).equal('refused');
    should(retried.kind).equal('refused');
    should(current.credentials.all()).be.empty();
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
    await current.mint();
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
    const minted = await mint();

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
    await mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    const revoked = service.revoke(PAIRING_ID);

    // Assert
    should(revoked).containDeep({ status: 'redeemed', deviceName: 'phone' });
  });

  it('should be idempotent for a code it knows and silent about one it never minted', async () => {
    // Arrange
    const { service, mint } = fixture();
    await mint();

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
    await mint();
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
      },
    ]);
    should(JSON.stringify(listed)).not.containEql(DEVICE_KEY);
  });

  it('should end a revoked device’s access for the very next request', async () => {
    // THE HALF THAT ACTUALLY REVOKES. Rewriting the document decides what comes back after a restart;
    // dropping the live grant decides whether the next request is served, which is the only one the
    // person holding the lost phone is making.
    // Arrange
    const { credentials, devices, service, mint } = fixture();
    await mint();
    await redeemDirect(service, { code: CODE, deviceName: 'first' }, 'peer-one');
    await mint();
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
    await mint();
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
    await mint();
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
    await mint();
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

  it('should leave the device fully paired when its other state cannot be purged', async () => {
    // THE ORDER IS THE OPPOSITE OF THE DOCUMENT'S, and deliberately: purging first means a failure
    // leaves a device that is still paired with its state intact — retryable, nothing half-done —
    // where revoking first would leave a phone that is unpaired and still being notified.
    // Arrange
    const push = new RecordingDeviceState(new Error('the enrolment document could not be written'));
    const { credentials, devices, service, mint } = fixture({ deviceState: [push] });
    await mint();
    await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer-one');

    // Act
    await service.revokeDevice(FIRST_DEVICE_ID).should.be.rejectedWith(/enrolment document/u);

    // Assert
    should(devices.records.map(record => record.id)).deepEqual([FIRST_DEVICE_ID]);
    should(credentials.get(FIRST_DEVICE_ID)?.publicKey).equal(DEVICE_KEY);
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
    await mint();
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

describe('PairingDeviceRegistry', () => {
  const record = (overrides: Partial<PairingDeviceRecord> = {}): PairingDeviceRecord => ({
    id: FIRST_DEVICE_ID,
    daemonId: DAEMON_ID,
    name: 'phone',
    platform: 'browser',
    createdAt: '2026-08-03T12:00:00.000Z',
    lastSeenAt: '2026-08-03T12:00:00.000Z',
    publicKey: DEVICE_KEY,
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
    await built.mint();
    const redemption = await redeemDirect(built.service, { code: CODE, deviceName: 'phone' }, 'peer-one');
    if (redemption.kind !== 'paired') throw new Error('expected a pairing');
    return built;
  }

  it('should refuse a key whose proof did not verify exactly as it refuses a wrong code, spending one guess', async () => {
    // The session decides `proven`; here it is one more way to be wrong. A different answer, or a free
    // one, would let a guesser tell a bad key apart from a bad code.
    const { service, mint, devices } = fixture();
    await mint();
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
    await mint();
    const refused = await redeemDirect(service, { code: CODE, deviceName: 'phone' }, 'peer', {
      deviceKey: 'not-a-key',
    });
    should(refused.kind).equal('refused');
  });

  it('should spend the relay budget for an unproven relayed key and leave the direct path alone', async () => {
    const { service, mint } = fixture();
    await mint();
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
    await mint();
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

describe('PairingService redemption over a relay', () => {
  it('should pair through a port that takes no request, and answer with the whole published set', async () => {
    // Arrange
    const { devices, service, mint } = fixture();
    await mint();

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
    // Assert — single-use, on either carrier.
    should((await redeemRelayed(service, { code: CODE, deviceName: 'again' })).kind).equal('refused');
  });

  it('should spend a relay budget that can never expire a code a LAN device could still redeem', async () => {
    // Arrange
    const { devices, service, mint } = fixture();
    await mint();

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
    await mint();
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
    await mint();

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
    await expired.mint();
    expired.clock.nowMs += 120_000;
    const unusable = fixture();
    await unusable.mint();

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
    await mint();

    // Act
    const redemption = await redeemRelayed(service, { code: CODE, deviceName: 'phone' });

    // Assert — the same fail-closed answer the direct path gives: the code is spent, nothing paired.
    should(redemption).deepEqual({ kind: 'refused' });
    should(service.status(PAIRING_ID)?.status).equal('expired');
  });
});
