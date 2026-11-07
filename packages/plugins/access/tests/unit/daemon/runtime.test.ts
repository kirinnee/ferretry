import { MemoryStateFolder } from '@ferretry/kernel/testing';
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
import { stepUpWitnessConformance } from '@ferretry/core-gate/contract/testing';
import type {
  CarrierKey,
  EventDef,
  HolderId,
  HolderWatch,
  KernelPorts,
  Log,
  StatePort,
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
import { type AccessHost, AccessRuntime, type AccessRuntimeDeps } from '../../../daemon/runtime.ts';
import { call, jsonBody, oneFreshProof } from '../../support/daemon/call.ts';
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

function failingUnlockWrites(port: StatePort, fails: () => boolean): StatePort {
  return {
    ...port,
    write: async (file, value, name) => {
      if (file.name === UnlocksFile.name && fails()) throw new Error('the disk refused the unlock ledger');
      await port.write(file, value, name);
    },
  };
}

function world(
  options: {
    readonly identity?: AccessHost['identity'];
    readonly folder?: MemoryStateFolder;
    readonly stages?: AccessRuntimeDeps['stages'];
    /** Makes the unlock ledger's writes reject while this answers true (a disk that refuses the write). */
    readonly unlockWritesFail?: () => boolean;
  } = {},
): World {
  const folder = options.folder ?? new MemoryStateFolder();
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
    state: failingUnlockWrites(
      folder.port([DevicesFile, PasskeysFile, UnlocksFile, PushFile, PushKeysFile, GrantAuditFile]),
      options.unlockWritesFail ?? (() => false),
    ),
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
  const runtime = new AccessRuntime({
    kernel,
    gate,
    connections: () => undefined,
    host,
    ...(options.stages === undefined ? {} : { stages: options.stages }),
  });
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
async function prepared(options: Parameters<typeof world>[0] = {}) {
  const w = world(options);
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

test('Access port holds checks the paired device and the registered credential', async () => {
  const p = await prepared();
  expect(await p.w.runtime.port.holds(p.device.deviceId, p.credentialId)).toBe(true);
  expect(await p.w.runtime.port.holds(p.device.deviceId, 'another-credential')).toBe(false);
  const another = await paired(p.w);
  expect(await p.w.runtime.port.holds(another.deviceId, p.credentialId)).toBe(false);
  await revoke(p.w, p.device.deviceId);
  expect(await p.w.runtime.port.holds(p.device.deviceId, p.credentialId)).toBe(false);
});

test('Access port verifies stored proofs offline at the credential own origin without moving its counter', async () => {
  const p = await prepared();
  const challenge = new Uint8Array(32).fill(7);
  const proof = { deviceId: p.device.deviceId, ...(await signed(p, { challenge: toBase64Url(challenge) })) };
  await p.wired.passkeyStore.updateSignCount(p.device.deviceId, p.credentialId, 99);
  const stored = await p.wired.passkeyStore.list(p.device.deviceId);
  const credential = stored[0];
  if (credential === undefined) throw new Error('expected registered credential');
  expect(await p.w.runtime.port.verifyStoredProof(proof, challenge)).toBe(true);
  expect(await p.w.runtime.port.verifyStoredProof(proof, challenge)).toBe(true);
  expect(await p.wired.passkeyStore.list(p.device.deviceId)).toEqual(stored);
  expect(await p.w.runtime.port.verifyStoredProof(proof, new Uint8Array(32).fill(8))).toBe(false);
  const foreignOrigin = await assertion(p.authenticator, {
    client: clientData('webauthn.get', { challenge: toBase64Url(challenge), origin: 'https://other.example.test' }),
    auth: { rpId: 'other.example.test' },
  });
  expect(
    await p.w.runtime.port.verifyStoredProof(
      {
        ...proof,
        clientDataJSON: toBase64Url(foreignOrigin.clientDataJSON),
        authenticatorData: toBase64Url(foreignOrigin.authenticatorData),
        signature: toBase64Url(foreignOrigin.signature),
      },
      challenge,
    ),
  ).toBe(false);
  await p.wired.passkeyStore.forgetDevice(p.device.deviceId);
  expect(await p.w.runtime.port.verifyStoredProof(proof, challenge)).toBe(false);
  await p.wired.passkeyStore.add(credential);
  await revoke(p.w, p.device.deviceId);
  // A failed passkey purge must not restore authority to an unpaired device.
  await p.wired.passkeyStore.add(credential);
  expect(await p.w.runtime.port.holds(p.device.deviceId, p.credentialId)).toBe(false);
  expect(await p.w.runtime.port.verifyStoredProof(proof, challenge)).toBe(false);
});

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

// ─── rows Access owns with Gate: through the real runtime (production path) ───────────────────────────────────────

const ORIGIN = 'https://app.example.test';

/** A person-route call made as a paired device, through the runtime's own handler. */
async function asDevice(
  w: World,
  key: string,
  deviceId: string,
  body: unknown,
  extra: Partial<Parameters<typeof call>[0]> = {},
) {
  const [method, path] = key.split(' ') as [string, string];
  return await w.runtime.handler(key)(
    call({ method, path, device: { deviceId, appSession: 'page' }, body: JSON.stringify(body), ...extra }),
  );
}

test('G76 an unlock is kept as a device id and an instant only, and a restarted runtime restores it for a device still paired', async () => {
  const p = await prepared();
  const options = await asDevice(p.w, 'POST /v1/unlock/options', p.device.deviceId, { origin: ORIGIN });
  expect(options.status).toBe(200);
  const unlocked = await asDevice(
    p.w,
    'POST /v1/unlock',
    p.device.deviceId,
    await signed(p, { challenge: String(jsonBody(options).challenge) }),
  );
  expect(unlocked.status).toBe(200);
  const stored = JSON.parse(p.w.folder.raw(UnlocksFile) ?? 'null');
  expect(stored.unlocks).toEqual([{ deviceId: p.device.deviceId, unlockedAt: p.w.clock.now() }]);
  expect(Object.keys(stored.unlocks[0]).sort()).toEqual(['deviceId', 'unlockedAt']);
  expect(p.w.folder.raw(UnlocksFile)).not.toContain(p.device.key);
  // A restart: a second runtime over the same state restores the unlock for the device that is still paired.
  const again = world({ folder: p.w.folder });
  await again.runtime.ready();
  const standing = again.runtime.credentials.standing(p.device.deviceId as HolderId, again.clock.now());
  expect(typeof standing === 'object' && standing.unlockedUntil).toBeTruthy();
  // ... and not for a device nobody paired: a ledger row for it restores nothing.
  const stranger = `fy_device_id_${'z'.repeat(22)}`;
  p.w.folder.plant(
    UnlocksFile,
    JSON.stringify({
      format: 1,
      daemonId: stored.daemonId,
      unlocks: [{ deviceId: stranger, unlockedAt: p.w.clock.now() }],
    }),
  );
  const restarted = world({ folder: p.w.folder });
  await restarted.runtime.ready();
  expect(restarted.runtime.credentials.standing(stranger as HolderId, restarted.clock.now())).toBe('unknown');
  const withoutUnlock = restarted.runtime.credentials.standing(p.device.deviceId as HolderId, restarted.clock.now());
  expect(typeof withoutUnlock === 'object' && withoutUnlock.unlockedUntil).toBeUndefined();
});

test('G86 standing-rule options answer only the device the stage waits on; anyone else, or a stage not waiting, gets 404 stage_not_found and no challenge', async () => {
  const STAGE = `srs_${'a'.repeat(24)}`;
  const DERIVED = new Uint8Array(32).fill(9);
  let waiting = '';
  const p = await prepared({
    stages: act =>
      act === 'approve-sign-in-rule'
        ? { challengeOf: (stage, deviceId) => (stage === STAGE && deviceId === waiting ? DERIVED : undefined) }
        : undefined,
  });
  waiting = p.device.deviceId;
  const other = await paired(p.w);
  const body = (subject: string) => ({ origin: ORIGIN, act: STEP_UP_ACTS.approveSignInRule, subject });
  const refusals = [
    await asDevice(p.w, 'POST /v1/step-up/options', other.deviceId, body(STAGE)),
    await asDevice(p.w, 'POST /v1/step-up/options', p.device.deviceId, body(`srs_${'b'.repeat(24)}`)),
    await p.w.runtime.handler('POST /v1/step-up/options')(
      call({ host: true, method: 'POST', path: '/v1/step-up/options', body: JSON.stringify(body(STAGE)) }),
    ),
  ];
  for (const refused of refusals) {
    expect([refused.status, jsonBody(refused).code]).toEqual([404, 'stage_not_found']);
    expect(jsonBody(refused)).not.toHaveProperty('challenge');
  }
  const answered = await asDevice(p.w, 'POST /v1/step-up/options', p.device.deviceId, body(STAGE));
  expect(answered.status).toBe(200);
  expect(jsonBody(answered).challenge).toBe(toBase64Url(DERIVED));
});

test('G102 a device without a passkey registers one within its pairing window, and losing every passkey is repaired at the machine', async () => {
  const w = world();
  const device = await paired(w);
  const options = () => asDevice(w, 'POST /v1/passkeys/options', device.deviceId, { origin: ORIGIN });
  expect((await options()).status).toBe(200);
  await w.clock.advance(11 * 60_000);
  const closed = await options();
  expect([closed.status, jsonBody(closed).code]).toEqual([403, 'step_up_registration_closed']);
  // Only the owner at the machine re-opens it.
  const fromDevice = await asDevice(w, 'POST /v1/passkeys/registration-window', device.deviceId, {
    deviceId: device.deviceId,
  });
  expect(fromDevice.status).toBe(403);
  const reopened = await w.runtime.handler('POST /v1/passkeys/registration-window')(
    call({
      host: true,
      method: 'POST',
      path: '/v1/passkeys/registration-window',
      body: JSON.stringify({ deviceId: device.deviceId }),
    }),
  );
  expect(reopened.status).toBe(200);
  expect((await options()).status).toBe(200);
});

test('G137 a full code minted by a device is refused unless that device holds everything; a limited code is not', async () => {
  const w = world();
  const holder = async (grants?: 'full' | 'limited') => {
    const device = await paired(w, grants);
    const standing = w.runtime.credentials.standing(device.deviceId as HolderId, w.clock.now());
    if (typeof standing !== 'object') throw new Error('expected a standing');
    return { deviceId: device.deviceId, grants: standing.grants };
  };
  const mintAs = async (device: Awaited<ReturnType<typeof holder>>, grants: 'full' | 'limited') =>
    await asDevice(
      w,
      'POST /v1/pair/code',
      device.deviceId,
      { grants },
      {
        deviceGrants: device.grants,
        presentation: { stepUp: true, freshStepUp: true },
        // Each mint is its own request, admitted on its own fresh proof, which the route TAKES.
        standing: { claimFreshStepUp: oneFreshProof().claim },
      },
    );
  const everything = await holder();
  const fleetOnly = await holder('limited');
  const full = await mintAs(fleetOnly, 'full');
  expect([full.status, jsonBody(full).code]).toEqual([403, 'grant_forbidden']);
  expect((await mintAs(fleetOnly, 'limited')).status).toBe(201);
  expect((await mintAs(everything, 'full')).status).toBe(201);
  // The choice is carried in the daemon and reported on the mint response, not encoded in the code itself.
  expect(jsonBody(await mintAs(everything, 'limited')).grants).toBe('limited');
});

test('G141 a malformed grants field fails the device document closed, and every write carries the field', async () => {
  const w = world();
  const device = await paired(w);
  const written = JSON.parse(w.folder.raw(DevicesFile) ?? '{}');
  expect(written.devices.every((record: { grants?: unknown }) => record.grants !== undefined)).toBe(true);
  const planted = (mutate: (record: Record<string, unknown>) => void) => {
    const folder = new MemoryStateFolder();
    const document = JSON.parse(w.folder.raw(DevicesFile) ?? '{}');
    mutate(document.devices[0]);
    folder.plant(DevicesFile, JSON.stringify(document));
    return world({ folder });
  };
  for (const damaged of [
    planted(record => {
      record.grants = { fleet: { use: 'yes' } };
    }),
    planted(record => {
      delete record.grants;
    }),
  ]) {
    const response = await damaged.runtime.handler('GET /v1/pair/devices')(call({ host: true }));
    expect([response.status, jsonBody(response).code]).toEqual([503, 'plugin_failed']);
    expect(damaged.runtime.credentials.standing(device.deviceId as HolderId, damaged.clock.now())).toBe('unknown');
  }
});

// ─── Gate's StepUpWitness, answered by Access's REAL witness (production path; no fake) ───────────────────────────

/**
 * Gate's `step-up` conformance suite against `AccessRuntime.witness`: every copy of the app that "proved a passkey"
 * does so through the real ceremony (options, a software authenticator's assertion, the real WebAuthn verifier, the
 * real registry), on a copy with a live session.
 */
stepUpWitnessConformance('AccessRuntime.witness', async () => {
  const p = await prepared();
  let signCount = 0;
  let copies = 0;
  return {
    witness: p.w.runtime.witness,
    proved: async act => {
      copies += 1;
      const watch = watcher(`conformance-copy-${copies}`);
      p.w.runtime.deviceMode.watch?.(p.device.deviceId as HolderId, watch.watch);
      const subject = { deviceId: p.device.deviceId, appSession: watch.watch.appSession };
      const caller = { device: subject, hostLocal: false };
      const options = await p.wired.stepUp.stepUpOptions(caller, p.origin, act);
      if (!options.ok) throw new Error('options refused');
      signCount += 1;
      const done = await p.wired.stepUp.stepUp(caller, await signed(p, options.value, signCount));
      if (!done.ok) throw new Error('the ceremony was refused');
      return subject;
    },
  };
});

test('the witness hands a kept proof as its device, claims it once, and re-verifies it against the paired device', async () => {
  const STAGE = `srs_${'d'.repeat(24)}`;
  const CHALLENGE = new Uint8Array(32).fill(5);
  const p = await prepared();
  const watch = watcher('stored-proof-copy');
  const release = p.w.runtime.deviceMode.watch?.(p.device.deviceId as HolderId, watch.watch);
  const subject = { deviceId: p.device.deviceId, appSession: watch.watch.appSession };
  const caller = { device: subject, hostLocal: false };
  const options = await p.wired.stepUp.stepUpOptions(
    caller,
    p.origin,
    STEP_UP_ACTS.approveSignInRule,
    STAGE as never,
    CHALLENGE,
  );
  if (!options.ok) throw new Error('options refused');
  expect((await p.wired.stepUp.stepUp(caller, await signed(p, options.value))).ok).toBe(true);
  const witness = p.w.runtime.witness;
  // A different challenge, or a stage it was not proved for, takes nothing and spends nothing.
  expect(
    witness.claimStoredProof(subject, STEP_UP_ACTS.approveSignInRule, STAGE as never, new Uint8Array(32).fill(6)),
  ).toBeUndefined();
  expect(
    witness.claimStoredProof(subject, STEP_UP_ACTS.approveSignInRule, `srs_${'e'.repeat(24)}` as never, CHALLENGE),
  ).toBeUndefined();
  const kept = witness.claimStoredProof(subject, STEP_UP_ACTS.approveSignInRule, STAGE as never, CHALLENGE);
  if (kept === undefined) throw new Error('expected the kept proof');
  expect(kept.deviceId).toBe(p.device.deviceId);
  expect(Object.keys(kept).sort()).toEqual(
    ['authenticatorData', 'clientDataJSON', 'credentialId', 'deviceId', 'signature'].sort(),
  );
  expect(witness.claimStoredProof(subject, STEP_UP_ACTS.approveSignInRule, STAGE as never, CHALLENGE)).toBeUndefined();
  expect(await witness.verifyStoredProof(kept, CHALLENGE)).toBe(true);
  expect(await witness.verifyStoredProof(kept, new Uint8Array(32).fill(6))).toBe(false);
  // The holder must still be paired: the passkeys stay, only the pairing goes, and the same evidence verifies for nobody.
  await p.wired.pairing.revokeDevice(p.device.deviceId, 'host');
  await p.wired.passkeyStore.add({
    credentialId: p.credentialId,
    deviceId: p.device.deviceId,
    algorithm: p.authenticator.algorithm,
    publicKeySpki: toBase64Url(p.authenticator.spki),
    signCount: 0,
    origin: p.origin,
    createdAt: p.w.clock.now(),
  });
  expect(await p.wired.passkeyStore.list(p.device.deviceId)).toHaveLength(1);
  expect(p.wired.pairing.deviceGrants(p.device.deviceId)).toBeUndefined();
  expect(await witness.verifyStoredProof(kept, CHALLENGE)).toBe(false);
  release?.();
});

// ─── `credentials:device` watch (Gate's optional push of a generation move; today's `recheckAll`) ──────────────────

test('a device grant change fires the credentials watch once, and a cancelled watch hears nothing', async () => {
  const w = world();
  const device = await paired(w);
  await w.runtime.ready();
  let heard = 0;
  let readWhenHeard: ReturnType<typeof w.runtime.credentials.standing> | undefined;
  const cancel = watchOf(w)(() => {
    heard += 1;
    readWhenHeard = w.runtime.credentials.standing(device.deviceId as HolderId, w.clock.now());
  });
  const generation = w.runtime.credentials.generation();
  const narrow = async (use: boolean) =>
    await w.runtime.handler('PATCH /v1/pair/devices/:deviceId/grants')(
      call({
        host: true,
        method: 'PATCH',
        path: `/v1/pair/devices/${device.deviceId}/grants`,
        params: { deviceId: device.deviceId },
        body: JSON.stringify({ terminal: { use } }),
      }),
    );
  expect((await narrow(false)).status).toBe(200);
  expect(heard).toBe(1);
  expect(w.runtime.credentials.generation()).toBeGreaterThan(generation);
  // The new standing was already readable INSIDE the listener, when it heard.
  expect(typeof readWhenHeard === 'object' && readWhenHeard.grants.terminal.use).toBe(false);
  cancel();
  expect((await narrow(true)).status).toBeLessThan(500);
  expect(heard).toBe(1);
});

test('a throwing credentials watcher never stops another from hearing', async () => {
  const w = world();
  const device = await paired(w);
  let heard = 0;
  watchOf(w)(() => {
    throw new Error('a listener fails');
  });
  watchOf(w)(() => {
    heard += 1;
  });
  const generation = w.runtime.credentials.generation();
  expect(await revoke(w, device.deviceId)).toBe(200);
  // A revoke is two moves (the grant going, and the device's unlock being forgotten): the healthy watcher hears each
  // exactly once, however often the other throws.
  expect(w.runtime.credentials.generation() - generation).toBe(2);
  expect(heard).toBe(2);
});

/** The runtime's credentials watch, which Access provides (Gate's member is optional in its type). */
function watchOf(w: World): (listener: () => void) => () => void {
  const watch = w.runtime.credentials.watch;
  if (watch === undefined) throw new Error('Access provides a credentials watch');
  return listener => watch.call(w.runtime.credentials, listener);
}

/** A watch on the runtime's credentials that counts what it hears, plus the standing it could read at each notice. */
function listen(w: World) {
  const heard = { count: 0 };
  const cancel = watchOf(w)(() => {
    heard.count += 1;
  });
  return { heard, cancel };
}

async function unlockCeremony(p: Awaited<ReturnType<typeof prepared>>) {
  const options = await asDevice(p.w, 'POST /v1/unlock/options', p.device.deviceId, { origin: ORIGIN });
  expect(options.status).toBe(200);
  return await asDevice(
    p.w,
    'POST /v1/unlock',
    p.device.deviceId,
    await signed(p, { challenge: String(jsonBody(options).challenge) }),
  );
}

test('an unlock ceremony fires the credentials watch once', async () => {
  const p = await prepared();
  const { heard } = listen(p.w);
  const generation = p.w.runtime.credentials.generation();
  expect((await unlockCeremony(p)).status).toBe(200);
  expect(heard.count).toBe(1);
  expect(p.w.runtime.credentials.generation()).toBe(generation + 1);
});

test('an unlock whose ledger write fails still moves the generation and fires the credentials watch once', async () => {
  let failing = false;
  const p = await prepared({ unlockWritesFail: () => failing });
  const { heard } = listen(p.w);
  const generation = p.w.runtime.credentials.generation();
  failing = true;
  // The ceremony the person completed stands: the failed write only costs the next restart's prompt.
  expect((await unlockCeremony(p)).status).toBe(200);
  expect(heard.count).toBe(1);
  expect(p.w.runtime.credentials.generation()).toBe(generation + 1);
  const standing = p.w.runtime.credentials.standing(p.device.deviceId as HolderId, p.w.clock.now());
  expect(typeof standing === 'object' && standing.unlockedUntil).toBeTruthy();
});

test('a device key rotation fires the credentials watch once', async () => {
  const p = await prepared();
  const { heard } = listen(p.w);
  const transcriptHash = new Uint8Array(32).fill(9);
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
  const caller = { device: { deviceId: p.device.deviceId, appSession: 'page' }, hostLocal: false, transcriptHash };
  // A step-up, not an unlock, so the only standing move is the rotation itself.
  const options = await p.wired.stepUp.stepUpOptions(caller, p.origin);
  if (!options.ok) throw new Error('options refused');
  const done = await p.wired.stepUp.stepUp(caller, {
    ...(await signed(p, options.value)),
    rotation: { deviceKey, proof },
  });
  expect(done.ok && done.value.keyRotated).toBe(true);
  expect(heard.count).toBe(1);
});

test('an idle device expiring fires the credentials watch once', async () => {
  const p = await prepared();
  const { heard } = listen(p.w);
  const generation = p.w.runtime.credentials.generation();
  await p.w.clock.advance(31 * DAY_MS);
  expect(await p.wired.pairing.deviceKey(p.device.deviceId)).toBeUndefined();
  expect(p.w.runtime.credentials.standing(p.device.deviceId as HolderId, p.w.clock.now())).toBe('revoked');
  // Once per generation move: the expiry is the grant going and the device's unlock being forgotten, two moves.
  const moves = p.w.runtime.credentials.generation() - generation;
  expect(moves).toBe(2);
  expect(heard.count).toBe(moves);
});
