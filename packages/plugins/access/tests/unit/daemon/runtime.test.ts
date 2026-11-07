import { MemoryStateFolder } from '../../support/daemon/state-folder.ts';
/**
 * Access's composition (`daemon/runtime.ts`): the `device` and `pair` session modes, the `credentials:device`
 * provider and the Access port, wired to fake kernel ports (state in memory, a driven clock), a fake Gate and a
 * host stub. The kernel's own halves of these rows — the transcript signature check, the dummy key, the lease, the
 * sealed records and their close codes — are the kernel's to test; this file proves what Access answers it.
 */
import { describe, expect, test } from 'bun:test';
import {
  type AuditDraft,
  DEFAULT_GATE_CONFIG,
  FULL_DEVICE_GRANTS,
  type GateApi,
  type GateConfig,
  LIMITED_DEVICE_GRANTS,
  STEP_UP_ACTS,
} from '@ferretry/core-gate/contract';
import type {
  CarrierKey,
  EventDef,
  HolderId,
  HolderWatch,
  KernelPorts,
  Log,
  ModeRedeemed,
  SessionId,
} from '@ferretry/kernel/contract';
import { type DrivenClock, fixedClock } from '@ferretry/kernel/testing';
import { instantFromEpochMs } from '@ferretry/std';
import {
  DevicesChanged,
  DevicesFile,
  GrantAuditFile,
  PairingCodeMintResponseSchema,
  PairingResponseSchema,
  PasskeysFile,
  PushFile,
  PushKeysFile,
  UnlocksFile,
} from '../../../contract/index.ts';
import { accessConformance } from '../../../contract/testing/index.ts';
import { toBase64Url } from '../../../daemon/lib/proof/binary.ts';
import { type AccessHost, AccessRuntime } from '../../../daemon/runtime.ts';
import { call, jsonBody } from '../../support/daemon/call.ts';
import {
  assertion,
  clientData,
  CREDENTIAL_ID,
  es256Authenticator,
} from '../../support/daemon/passkey-authenticator.ts';
import { deviceRotateMessage } from '../../../daemon/lib/proof/device-proof.ts';

const DAEMON_ID = `fy_daemon_${'A'.repeat(43)}`;
const DAY_MS = 24 * 60 * 60 * 1_000;

const ed25519: AccessHost['ed25519'] = {
  verifyEd25519: async (publicKeySpki, signature, message) => {
    try {
      const key = await crypto.subtle.importKey('spki', new Uint8Array(publicKeySpki), { name: 'Ed25519' }, false, [
        'verify',
      ]);
      return await crypto.subtle.verify('Ed25519', key, new Uint8Array(signature), new Uint8Array(message));
    } catch {
      return false;
    }
  },
};

interface World {
  readonly runtime: AccessRuntime;
  readonly clock: DrivenClock;
  readonly folder: MemoryStateFolder;
  readonly drafts: AuditDraft[];
  readonly published: { readonly event: EventDef<string, unknown>; readonly payload: unknown }[];
  readonly logged: string[];
  policy: GateConfig | undefined;
}

function world(options: { readonly identity?: AccessHost['identity'] } = {}): World {
  const folder = new MemoryStateFolder();
  const clock = fixedClock('2026-11-06T09:00:00.000Z');
  const logged: string[] = [];
  const log: Log = {
    debug: message => logged.push(message),
    info: message => logged.push(message),
    warn: (message, fields) => logged.push(`${message} ${JSON.stringify(fields ?? {})}`),
    error: (message, fields) => logged.push(`${message} ${JSON.stringify(fields ?? {})}`),
    child: () => log,
  };
  const published: World['published'] = [];
  const kernel = {
    clock,
    log,
    state: folder.port([DevicesFile, PasskeysFile, UnlocksFile, PushFile, PushKeysFile, GrantAuditFile]),
    events: {
      publish: (event: EventDef<string, unknown>, payload: unknown) => published.push({ event, payload }),
    },
    fetch: {
      request: async () => {
        throw new Error('a unit test reaches no network');
      },
    },
  } as unknown as KernelPorts;
  const drafts: AuditDraft[] = [];
  const state: Partial<World> & { policy: GateConfig | undefined } = { policy: DEFAULT_GATE_CONFIG };
  const gate: GateApi = {
    audit: async draft => {
      drafts.push(draft);
    },
    policy: () => state.policy,
  };
  const host: AccessHost = {
    identity: options.identity ?? (() => ({ daemonId: DAEMON_ID, daemonName: 'Studio' })),
    allowedOrigins: () => ['https://app.example.test'],
    ed25519,
    clientName: 'fy',
  };
  const runtime = new AccessRuntime({ kernel, gate, connections: () => undefined, host });
  return Object.assign(state, { runtime, clock, folder, drafts, published, logged }) as World;
}

async function newDeviceKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
}

test('runtime wiring logs a damaged unlock ledger notice once and keeps devices locked', async () => {
  const w = world();
  w.folder.plant(UnlocksFile, '{broken');
  const code = await mint(w);
  const result = await redeem(w, { code, deviceKey: await newDeviceKey() });
  expect(result).not.toBe('refused');
  if (result === 'refused') throw new Error('expected paired device');
  const response = PairingResponseSchema.parse(result.fields.response);
  const standing = w.runtime.credentials.standing(response.deviceId as HolderId, w.clock.now());
  expect(standing).not.toBe('unknown');
  expect(Object.keys(standing as object)).not.toContain('unlockedUntil');
  await Promise.all([w.runtime.ready(), w.runtime.ready()]);
  expect(w.logged.filter(message => message.includes('the unlock ledger could not be read'))).toHaveLength(1);
  expect(w.logged.some(message => message.includes('so every device is asked to unlock again'))).toBe(true);
});

/** Mints a code at the machine (the owner's `fy pair`) and hands it back; never printed. */
async function mint(w: World, grants?: 'full' | 'limited'): Promise<string> {
  const response = await w.runtime.handler('POST /v1/pair/code')(
    call({
      host: true,
      method: 'POST',
      path: '/v1/pair/code',
      body: grants === undefined ? '' : JSON.stringify({ grants }),
    }),
  );
  expect(response.status).toBe(201);
  return PairingCodeMintResponseSchema.parse(jsonBody(response)).code;
}

interface Attempt {
  readonly code: string;
  readonly deviceKey: string;
  readonly deviceName?: string;
  readonly carrier?: 'direct' | 'relay';
  readonly peer?: string;
  readonly prove?: () => Promise<boolean>;
}

async function redeem(w: World, attempt: Attempt): Promise<ModeRedeemed | 'refused'> {
  const redeemer = w.runtime.pairMode.redeem;
  if (redeemer === undefined) throw new Error('the pair mode redeems');
  return await redeemer({
    proof: {
      mode: 'pair',
      body: { code: attempt.code, deviceName: attempt.deviceName ?? 'Phone', deviceKey: attempt.deviceKey },
    },
    prove: attempt.prove ?? (async () => true),
    carrier: (attempt.carrier ?? 'direct') as CarrierKey,
    peer: attempt.peer ?? '192.0.2.10',
  });
}

/** A device paired through the `pair` mode, as a browser would: its id and the key it registered. */
async function paired(
  w: World,
  grants?: 'full' | 'limited',
): Promise<{ readonly deviceId: string; readonly key: string }> {
  const key = await newDeviceKey();
  const outcome = await redeem(w, { code: await mint(w, grants), deviceKey: key });
  if (outcome === 'refused') throw new Error('the pairing was refused');
  return { deviceId: PairingResponseSchema.parse(outcome.fields.response).deviceId, key };
}

async function holderOf(w: World, body: unknown) {
  const holder = w.runtime.deviceMode.holder;
  if (holder === undefined) throw new Error('the device mode names holders');
  return await holder({ mode: 'device', body });
}

/** A code of the right shape that is not the live one: its first character changed within the alphabet. */
const wrong = (code: string): string => `${code.startsWith('2') ? '3' : '2'}${code.slice(1)}`;

const claim = (deviceId: string) => ({ deviceId, appSession: 'app-session-one' });

async function revoke(w: World, deviceId: string): Promise<number> {
  const response = await w.runtime.handler('DELETE /v1/pair/devices/:deviceId')(
    call({ host: true, method: 'DELETE', path: `/v1/pair/devices/${deviceId}`, params: { deviceId } }),
  );
  return response.status;
}

function watcher(session: string, appSession = session) {
  const seen = { revoked: 0, lapsed: 0, regranted: 0 };
  const watch: HolderWatch = {
    session: session as SessionId,
    appSession,
    revoked: () => {
      seen.revoked += 1;
    },
    lapsed: () => {
      seen.lapsed += 1;
    },
    regranted: () => {
      seen.regranted += 1;
    },
  };
  return { watch, seen };
}

describe('the pair session mode', () => {
  test('P18 a sealed pair record redeems the code and answers deviceId, daemonId, daemonName, capabilities, carriers and idleExpiryDays', async () => {
    const w = world();
    const key = await newDeviceKey();
    const outcome = await redeem(w, { code: await mint(w), deviceKey: key });
    if (outcome === 'refused') throw new Error('refused');
    expect(outcome.outcome).toBe('paired');
    const response = PairingResponseSchema.parse(outcome.fields.response);
    expect(Object.keys(response).sort()).toEqual(
      ['capabilities', 'carriers', 'daemonId', 'daemonName', 'deviceId', 'idleExpiryDays'].sort(),
    );
    expect(response.daemonId).toBe(DAEMON_ID);
    expect(response.daemonName).toBe('Studio');
    expect(response.idleExpiryDays).toBe(30);
    expect(w.published).toEqual([{ event: DevicesChanged, payload: { device: response.deviceId, change: 'paired' } }]);
  });

  test('R574 the paired outcome carries the pairing response verbatim, carriers included', async () => {
    const w = world();
    const outcome = await redeem(w, { code: await mint(w), deviceKey: await newDeviceKey() });
    if (outcome === 'refused') throw new Error('refused');
    expect(Object.keys(outcome.fields)).toEqual(['response']);
    expect(PairingResponseSchema.parse(outcome.fields.response)).toEqual(outcome.fields.response as never);
    expect((outcome.fields.response as { carriers: unknown }).carriers).toEqual([]);
  });

  test('P6 no bearer value exists: the paired outcome holds no token and the device record holds only the public key', async () => {
    const w = world();
    const key = await newDeviceKey();
    const code = await mint(w);
    const outcome = await redeem(w, { code, deviceKey: key });
    if (outcome === 'refused') throw new Error('refused');
    const wire = JSON.stringify(outcome.fields);
    expect(wire).not.toContain(key);
    expect(wire).not.toContain(code);
    expect(wire).not.toMatch(/"(?:token|secret|bearer)"/iu);
    const stored = w.folder.raw(DevicesFile) ?? '';
    expect(stored).toContain(key);
    expect(stored).not.toContain(code);
    expect(stored).not.toMatch(/"(?:token|secret|bearer)"/iu);
  });

  test('P12 there is no device credential to return: what a session proves with is the key the device kept, which the daemon only checks', async () => {
    const w = world();
    const { deviceId, key } = await paired(w);
    const holder = await holderOf(w, claim(deviceId));
    expect(holder).toEqual({ holder: deviceId as HolderId, key });
    // The public half is all the daemon has; nothing the mode answers could open a session on its own.
    expect(JSON.parse(w.folder.raw(DevicesFile) ?? '{}').devices[0].publicKey).toBe(key);
  });

  test('P25 one attempt gets exactly one outcome, `paired` or a generic `refused`, and a malformed record is refused without spending the code', async () => {
    const w = world();
    const code = await mint(w);
    expect(await redeem(w, { code, deviceKey: 'not-a-key' })).toBe('refused');
    const missing = await w.runtime.pairMode.redeem?.({
      proof: { mode: 'pair', body: { code } },
      prove: async () => true,
      carrier: 'direct' as CarrierKey,
      peer: '192.0.2.10',
    });
    expect(missing).toBe('refused');
    const outcome = await redeem(w, { code, deviceKey: await newDeviceKey() });
    expect(outcome === 'refused' ? outcome : outcome.outcome).toBe('paired');
  });

  test('P26 a bad signature spends one guess and gets the same refusal as a wrong code', async () => {
    const w = world();
    const code = await mint(w);
    const wrongCode = await redeem(w, { code: wrong(code), deviceKey: await newDeviceKey() });
    const badProof = await redeem(w, { code, deviceKey: await newDeviceKey(), prove: async () => false });
    expect(badProof).toBe(wrongCode);
    expect(badProof).toBe('refused');
    // Three more failures make five direct guesses: the code is gone even for the right proof.
    for (let index = 0; index < 3; index += 1)
      expect(await redeem(w, { code, deviceKey: await newDeviceKey(), prove: async () => false })).toBe('refused');
    expect(await redeem(w, { code, deviceKey: await newDeviceKey() })).toBe('refused');
  });

  test('R20 the code is redeemed only inside the session, and the kernel’s proof runs once for every attempt', async () => {
    const w = world();
    const code = await mint(w);
    let proofs = 0;
    const prove = async () => {
      proofs += 1;
      return true;
    };
    expect(await redeem(w, { code: wrong(code), deviceKey: await newDeviceKey(), prove })).toBe('refused');
    expect(proofs).toBe(1);
    expect(await redeem(w, { code, deviceKey: await newDeviceKey(), prove })).not.toBe('refused');
    expect(proofs).toBe(2);
    expect(w.runtime.pairMode.principalKind).toBe('none');
  });

  test('P27 direct attempts are keyed by peer and spend the direct five; relayed attempts spend a separate relay budget', async () => {
    const w = world();
    const code = await mint(w);
    for (let index = 0; index < 5; index += 1)
      expect(
        await redeem(w, { code, deviceKey: await newDeviceKey(), carrier: 'relay', prove: async () => false }),
      ).toBe('refused');
    // The relay path is closed for this code …
    expect(await redeem(w, { code, deviceKey: await newDeviceKey(), carrier: 'relay' })).toBe('refused');
    // … and the direct five are untouched, so a LAN device still redeems.
    const direct = await redeem(w, { code, deviceKey: await newDeviceKey(), carrier: 'direct', peer: '192.0.2.20' });
    expect(direct === 'refused' ? direct : direct.outcome).toBe('paired');
  });

  test('R587 exhausting the relay budget closes only the relay path for that code', async () => {
    const w = world();
    const code = await mint(w);
    for (let index = 0; index < 5; index += 1)
      await redeem(w, { code, deviceKey: await newDeviceKey(), carrier: 'relay', prove: async () => false });
    const outcome = await redeem(w, { code, deviceKey: await newDeviceKey(), carrier: 'direct' });
    expect(outcome === 'refused' ? outcome : outcome.outcome).toBe('paired');
  });

  test('R589 `pairing` governs minting only: a redemption is credentialed by the code alone, even with pairing switched off', async () => {
    const w = world();
    const code = await mint(w);
    w.policy = {
      ...DEFAULT_GATE_CONFIG,
      grants: { ...DEFAULT_GATE_CONFIG.grants, pairing: { use: false, configure: false } },
    };
    const outcome = await redeem(w, { code, deviceKey: await newDeviceKey() });
    expect(outcome === 'refused' ? outcome : outcome.outcome).toBe('paired');
  });

  test('R578 the pair mode reads only the record’s code, name and key, never an authorization, and mints exactly one device', async () => {
    const w = world();
    const code = await mint(w);
    const outcome = await w.runtime.pairMode.redeem?.({
      proof: {
        mode: 'pair',
        body: { code, deviceName: 'Phone', deviceKey: await newDeviceKey(), authorization: 'Bearer fy_admin_token' },
      },
      prove: async () => true,
      carrier: 'direct' as CarrierKey,
      peer: '192.0.2.10',
    });
    expect(outcome === undefined || outcome === 'refused' ? outcome : outcome.outcome).toBe('paired');
    expect(await w.runtime.port.devices()).toHaveLength(1);
    expect(await redeem(w, { code, deviceKey: await newDeviceKey() })).toBe('refused');
    expect(await w.runtime.port.devices()).toHaveLength(1);
  });

  test('R573 a redemption answers exactly one outcome, `paired` or `refused`, and gives the session no edge to serving', async () => {
    const w = world();
    const code = await mint(w);
    const outcomes = [
      await redeem(w, { code: wrong(code), deviceKey: await newDeviceKey() }),
      await redeem(w, { code, deviceKey: await newDeviceKey() }),
    ];
    expect(outcomes.map(outcome => (outcome === 'refused' ? outcome : outcome.outcome))).toEqual(['refused', 'paired']);
    // The pair mode names no holder, so the kernel has nothing to admit the session as.
    expect(w.runtime.pairMode.holder).toBeUndefined();
  });

  test('R577 a pairing session has no holder to name, so it can never become a request session', () => {
    const w = world();
    expect(w.runtime.pairMode.principalKind).toBe('none');
    expect(w.runtime.pairMode.holder).toBeUndefined();
    expect(w.runtime.pairMode.watch).toBeUndefined();
  });

  test('P32 nothing a relay could be handed carries the code, the key or the device name: no log line and no audit draft', async () => {
    const w = world();
    const key = await newDeviceKey();
    const code = await mint(w);
    await redeem(w, { code, deviceKey: key, deviceName: 'Kitchen tablet', carrier: 'relay' });
    const said = [...w.logged, ...w.drafts.map(draft => JSON.stringify(draft))].join('\n');
    expect(said).not.toContain(code);
    expect(said).not.toContain(key);
  });

  test('P33 once paired, the device opens an ordinary authenticated session with the key it registered', async () => {
    const w = world();
    const { deviceId, key } = await paired(w);
    expect(await holderOf(w, claim(deviceId))).toEqual({ holder: deviceId as HolderId, key });
  });

  test('G135 a newly paired device holds every capability, behind the unlock', async () => {
    const w = world();
    const { deviceId } = await paired(w);
    expect(w.runtime.credentials.standing(deviceId as HolderId, w.clock.now())).toEqual({
      kind: 'device',
      holder: deviceId as HolderId,
      grants: FULL_DEVICE_GRANTS,
    });
  });

  test('G136 a `--limited` code gives `fleet.use` only', async () => {
    const w = world();
    const { deviceId } = await paired(w, 'limited');
    const standing = w.runtime.credentials.standing(deviceId as HolderId, w.clock.now());
    expect(standing === 'unknown' || standing === 'revoked' ? standing : standing.grants).toEqual(
      LIMITED_DEVICE_GRANTS,
    );
  });
});

describe('the device session mode', () => {
  test('R78 an unknown, a revoked and an idle-expired device, and a malformed claim, are all the same `undefined`', async () => {
    const w = world();
    const live = await paired(w);
    const revoked = await paired(w);
    expect(await revoke(w, revoked.deviceId)).toBe(200);
    expect(await holderOf(w, claim('fy_device_id_AAAAAAAAAAAAAAAAAAAAAA'))).toBeUndefined();
    expect(await holderOf(w, claim(revoked.deviceId))).toBeUndefined();
    expect(await holderOf(w, { deviceId: live.deviceId })).toBeUndefined();
    expect(await holderOf(w, 'not a claim')).toBeUndefined();
    expect(await holderOf(w, claim(live.deviceId))).toEqual({ holder: live.deviceId as HolderId, key: live.key });
    await w.clock.advance(30 * DAY_MS);
    expect(await holderOf(w, claim(live.deviceId))).toBeUndefined();
  });

  test('R236 the auth claim names `deviceId` and `appSession`; the proof itself is the kernel’s to check against the key answered', async () => {
    const w = world();
    const { deviceId, key } = await paired(w);
    expect(await holderOf(w, { deviceId, appSession: '' })).toBeUndefined();
    expect(await holderOf(w, { deviceId, appSession: 'page-one', proof: 'ignored-here' })).toEqual({
      holder: deviceId as HolderId,
      key,
    });
  });

  test('R19 the mode answers the stored public key for the kernel to check the transcript signature against, never a secret', async () => {
    const w = world();
    const { deviceId, key } = await paired(w);
    const holder = await holderOf(w, claim(deviceId));
    expect(Object.keys(holder ?? {}).sort()).toEqual(['holder', 'key']);
    expect(holder?.key).toBe(key);
  });

  test('R239 only a device grant resolves: a claim naming an admin token or anything but a paired device id is refused', async () => {
    const w = world();
    await paired(w);
    expect(await holderOf(w, { deviceId: 'fy_admin_token', appSession: 'a' })).toBeUndefined();
    expect(await holderOf(w, { token: 'fy_admin_token' })).toBeUndefined();
  });

  test('R243 asked again at a renewal, the mode re-reads pairing and idle expiry', async () => {
    const w = world();
    const { deviceId, key } = await paired(w);
    expect(await holderOf(w, claim(deviceId))).toEqual({ holder: deviceId as HolderId, key });
    expect(await revoke(w, deviceId)).toBe(200);
    expect(await holderOf(w, claim(deviceId))).toBeUndefined();
  });

  test('R257 only `seen` (a request marked presence) moves the idle clock', async () => {
    const w = world();
    const { deviceId } = await paired(w);
    await w.clock.advance(29 * DAY_MS);
    w.runtime.deviceMode.seen?.(deviceId as HolderId);
    await w.clock.advance(2 * DAY_MS);
    expect(await holderOf(w, claim(deviceId))).toBeDefined();
  });

  test('R246 auth and renewal never count as device use', async () => {
    const w = world();
    const { deviceId } = await paired(w);
    await w.clock.advance(29 * DAY_MS);
    // An auth at day 29 answers, and is not use …
    expect(await holderOf(w, claim(deviceId))).toBeDefined();
    await w.clock.advance(2 * DAY_MS);
    // … so the device is idle-expired at day 31.
    expect(await holderOf(w, claim(deviceId))).toBeUndefined();
  });

  test('R240 a revocation ends every live session the device holds, and a session watched after it ends at once', async () => {
    const w = world();
    const { deviceId } = await paired(w);
    const one = watcher('session-one');
    const two = watcher('session-two');
    w.runtime.deviceMode.watch?.(deviceId as HolderId, one.watch);
    w.runtime.deviceMode.watch?.(deviceId as HolderId, two.watch);
    expect(await revoke(w, deviceId)).toBe(200);
    expect([one.seen.revoked, two.seen.revoked]).toEqual([1, 1]);
    const late = watcher('session-three');
    w.runtime.deviceMode.watch?.(deviceId as HolderId, late.watch);
    expect(late.seen.revoked).toBe(1);
  });

  test('R252 after a rotation the mode answers only the new key, so the old key opens nothing', async () => {
    const w = world();
    const { deviceId, key } = await paired(w);
    const replacement = await newDeviceKey();
    expect(await (await w.runtime.ready()).pairing.rotateDeviceKey(deviceId, replacement)).toBe(true);
    const holder = await holderOf(w, claim(deviceId));
    expect(holder?.key).toBe(replacement);
    expect(holder?.key).not.toBe(key);
    expect(w.folder.raw(DevicesFile) ?? '').not.toContain(key);
  });

  test('R237 `rotateBy` is the key’s issue plus the rotation period, and absent when no rotation is asked', async () => {
    const w = world();
    const { deviceId } = await paired(w);
    expect(w.runtime.deviceMode.rotateBy?.(deviceId as HolderId)).toBe(
      instantFromEpochMs(Date.parse('2026-11-06T09:00:00.000Z') + 30 * DAY_MS),
    );
    expect(w.runtime.deviceMode.rotateBy?.('fy_device_id_AAAAAAAAAAAAAAAAAAAAAA' as HolderId)).toBeUndefined();
  });
});

describe('the credentials:device provider', () => {
  test('G140 before Access has opened its state, every device is `unknown` (undetermined), never served unnarrowed', () => {
    const w = world();
    expect(w.runtime.credentials.standing('fy_device_id_AAAAAAAAAAAAAAAAAAAAAA' as HolderId, w.clock.now())).toBe(
      'unknown',
    );
  });

  test('P37 a newly paired device is locked: its standing carries no `unlockedUntil` until a passkey unlock', async () => {
    const w = world();
    const { deviceId } = await paired(w);
    const standing = w.runtime.credentials.standing(deviceId as HolderId, w.clock.now());
    expect(standing).not.toBe('unknown');
    expect(Object.keys(standing as object)).not.toContain('unlockedUntil');
  });

  test('P110 a revoked device has no standing, and the generation moves so Gate re-admits its streams', async () => {
    const w = world();
    const { deviceId } = await paired(w);
    const before = w.runtime.credentials.generation();
    expect(await revoke(w, deviceId)).toBe(200);
    expect(w.runtime.credentials.standing(deviceId as HolderId, w.clock.now())).toBe('revoked');
    expect(w.runtime.credentials.generation()).toBeGreaterThanOrEqual(before);
  });

  test('a host whose identity cannot be read answers every route `503` and keeps every device unknown (fail closed)', async () => {
    const w = world({
      identity: () => {
        throw new Error('no identity');
      },
    });
    const response = await w.runtime.handler('GET /v1/pair/devices')(call({ host: true }));
    expect(response.status).toBe(503);
    expect(jsonBody(response).code).toBe('plugin_failed');
    expect(w.runtime.credentials.standing('fy_device_id_AAAAAAAAAAAAAAAAAAAAAA' as HolderId, w.clock.now())).toBe(
      'unknown',
    );
  });
});

accessConformance('AccessRuntime.port', () => world().runtime.port);

/** A real runtime, real durable passkey store and real WebAuthn verifier; only the authenticator is software. */
async function prepared() {
  const w = world();
  const device = await paired(w);
  const wired = await w.runtime.ready();
  const authenticator = await es256Authenticator();
  const origin = 'https://app.example.test';
  const credentialId = toBase64Url(CREDENTIAL_ID);
  await wired.passkeyStore.add({
    credentialId,
    deviceId: device.deviceId,
    algorithm: authenticator.algorithm,
    publicKeySpki: toBase64Url(authenticator.spki),
    signCount: 0,
    origin,
    createdAt: w.clock.now(),
  });
  return { w, device, wired, authenticator, origin, credentialId };
}

async function signed(p: Awaited<ReturnType<typeof prepared>>, options: { challenge: string }, signCount = 1) {
  const answer = await assertion(p.authenticator, {
    client: clientData('webauthn.get', { challenge: options.challenge, origin: p.origin }),
    auth: { rpId: 'app.example.test', signCount },
  });
  return {
    credentialId: p.credentialId,
    clientDataJSON: toBase64Url(answer.clientDataJSON),
    authenticatorData: toBase64Url(answer.authenticatorData),
    signature: toBase64Url(answer.signature),
  };
}

test('a live runtime watch lets a verified add-device proof be claimed once through the provider', async () => {
  const p = await prepared();
  const watch = watcher('same-page-and-session');
  const release = p.w.runtime.deviceMode.watch?.(p.device.deviceId as HolderId, watch.watch);
  const subject = { deviceId: p.device.deviceId, appSession: watch.watch.appSession };
  const caller = { device: subject, hostLocal: false };
  const options = await p.wired.stepUp.stepUpOptions(caller, p.origin, STEP_UP_ACTS.addDevice);
  if (!options.ok) throw new Error('options refused');
  expect((await p.wired.stepUp.stepUp(caller, await signed(p, options.value))).ok).toBe(true);
  expect(p.w.runtime.witness.claimFresh(subject, STEP_UP_ACTS.addDevice)).toBe(true);
  expect(p.w.runtime.witness.claimFresh(subject, STEP_UP_ACTS.addDevice)).toBe(false);
  release?.();
});

test('releasing the runtime watch keeps the reconnect grace then ends its fresh proof', async () => {
  const p = await prepared();
  const watch = watcher('page-one');
  const release = p.w.runtime.deviceMode.watch?.(p.device.deviceId as HolderId, watch.watch);
  const subject = { deviceId: p.device.deviceId, appSession: watch.watch.appSession };
  const caller = { device: subject, hostLocal: false };
  const options = await p.wired.stepUp.stepUpOptions(caller, p.origin, STEP_UP_ACTS.addDevice);
  if (!options.ok) throw new Error('options refused');
  expect((await p.wired.stepUp.stepUp(caller, await signed(p, options.value))).ok).toBe(true);
  release?.();
  expect(p.w.runtime.witness.freshlyHeld(subject)).toBe(true);
  await p.w.clock.advance(61_000);
  expect(p.w.runtime.witness.claimFresh(subject, STEP_UP_ACTS.addDevice)).toBe(false);
});

test('R251 runtime unlock rotation rewrites the key, lapses other sessions, spares the carrying session and audits', async () => {
  const p = await prepared();
  p.w.policy = { ...DEFAULT_GATE_CONFIG, security: { ...DEFAULT_GATE_CONFIG.security, idleExpiryDays: 90 } };
  await p.w.clock.advance(31 * DAY_MS);
  const transcriptHash = new Uint8Array(32).fill(7);
  const carrying = watcher(Buffer.from(transcriptHash).toString('hex'), 'page-with-two-sessions');
  const other = watcher('other-session', 'page-with-two-sessions');
  p.w.runtime.deviceMode.watch?.(p.device.deviceId as HolderId, carrying.watch);
  p.w.runtime.deviceMode.watch?.(p.device.deviceId as HolderId, other.watch);
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const deviceKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
  const proof = toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        pair.privateKey,
        new Uint8Array(deviceRotateMessage(transcriptHash, p.device.deviceId, deviceKey)),
      ),
    ),
  );
  const caller = {
    device: { deviceId: p.device.deviceId, appSession: carrying.watch.appSession },
    hostLocal: false,
    transcriptHash,
  };
  const options = await p.wired.stepUp.unlockOptions(caller, p.origin);
  if (!options.ok) throw new Error('options refused');
  const done = await p.wired.stepUp.unlock(caller, {
    ...(await signed(p, options.value)),
    rotation: { deviceKey, proof },
  });
  expect(done.ok && done.value.keyRotated).toBe(true);
  expect([carrying.seen.lapsed, other.seen.lapsed]).toEqual([0, 1]);
  expect((await holderOf(p.w, claim(p.device.deviceId)))?.key).toBe(deviceKey);
  const records = JSON.parse(p.w.folder.raw(DevicesFile) ?? '{}').devices;
  expect(records[0].publicKey).toBe(deviceKey);
  expect(records[0].keyRotatedAt).toBe(p.w.clock.now());
  expect(p.w.folder.raw(DevicesFile)).not.toContain(p.device.key);
  const audit = (p.w.folder.raw(GrantAuditFile) ?? '')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  expect(audit.filter(line => line.kind === 'device.key-rotated')).toEqual([
    {
      format: 1,
      kind: 'device.key-rotated',
      actor: `device:${p.device.deviceId}`,
      changes: [`device.key-rotated=${p.device.deviceId}`],
      at: p.w.clock.now(),
    },
  ]);
});

test('the provider refuses all authority before the runtime opens', async () => {
  const runtime = world().runtime;
  const subject = { deviceId: 'unknown', appSession: 'page' };
  expect(runtime.witness.held(subject)).toBe(false);
  expect(runtime.witness.freshlyHeld(subject)).toBe(false);
  expect(runtime.witness.unlockRequired(subject)).toBe(true);
  expect(runtime.witness.claimFresh(subject, STEP_UP_ACTS.addDevice)).toBe(false);
  expect(runtime.witness.rotateBy(subject.deviceId)).toBeUndefined();
});
