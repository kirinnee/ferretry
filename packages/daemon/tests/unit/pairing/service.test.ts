import { describe, it } from 'bun:test';
import type { DaemonId, DeviceToken, PairingCode, PairingId } from '@ferretry/protocol';
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

  deviceId(): string {
    this.deviceIds += 1;
    return `device-${this.deviceIds}`;
  }

  hashDeviceToken(daemonId: string, token: string): string {
    return `hash:${daemonId}:${token.length}`;
  }
}

class RecordingDevices implements PairingDeviceStore {
  readonly records: PairingDeviceRecord[] = [];
  failure: Error | undefined;

  async add(record: PairingDeviceRecord): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.records.push(record);
  }
}

function fixture(
  options: {
    readonly limiter?: PairingRateLimiter;
    readonly compare?: (left: string, right: string) => boolean;
  } = {},
) {
  const clock = new FakeClock();
  const cryptography = new FakeCryptography();
  const devices = new RecordingDevices();
  const credentials = new PairingDeviceRegistry(DAEMON_ID, cryptography);
  const service = new PairingService({
    daemonId: DAEMON_ID,
    daemonName: 'workstation',
    daemonUrl: 'https://workstation.example.test',
    clock,
    cryptography,
    devices,
    credentials,
    rateLimiter: options.limiter,
    compare: options.compare,
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
      pairUrl:
        'https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fworkstation.example.test%2F;code=7F3K-Q2ND;fp=fy_daemon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    should(service.status(PAIRING_ID)).deepEqual({
      pairingId: PAIRING_ID,
      status: 'pending',
      expiresAt: '2026-08-03T12:02:00.000Z',
    });
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
    });
    should(devices.records).deepEqual([
      {
        id: 'device-1',
        daemonId: DAEMON_ID,
        name: 'Ernest phone',
        platform: 'browser',
        createdAt: '2026-08-03T12:00:00.000Z',
        lastSeenAt: '2026-08-03T12:00:00.000Z',
        tokenHash: `hash:${DAEMON_ID}:${DEVICE_TOKEN.length}`,
      },
    ]);
    should(JSON.stringify(devices.records)).not.containEql(DEVICE_TOKEN);
    should(credentials.identify(DEVICE_TOKEN)).equal('device-1');
    should(service.status(PAIRING_ID)).deepEqual({
      pairingId: PAIRING_ID,
      status: 'redeemed',
      expiresAt: '2026-08-03T12:02:00.000Z',
      redeemedAt: '2026-08-03T12:00:00.000Z',
      deviceName: 'Ernest phone',
    });
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
    const devices: PairingDeviceStore = { add: async () => await persisted };
    const service = new PairingService({
      daemonId: DAEMON_ID,
      daemonName: 'workstation',
      daemonUrl: 'https://workstation.example.test',
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
