import { describe, expect, test } from 'bun:test';
import { ApiError, type SocketDownstream } from '@ferretry/kernel/contract';
import { ferret, owner, testHost, warden } from '@ferretry/kernel/testing';
import {
  CAPABILITY_NAMES,
  decideCapability,
  FULL_DEVICE_GRANTS,
  type CallerGovernance,
  type CapabilityGrants,
} from '@ferretry/core-gate/contract';
import { decodeDownlinkUnit, STREAM_CLOSES } from '../../../contract/index.ts';
import { deviceStanding, FakeGate, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { fixedClock } from '@ferretry/kernel/testing';
import voice from '../../../daemon/index.ts';
import { auditActorOf, sentAuditDraft, sentRecorder, voiceStreamAccept } from '../../../daemon/lib/stream/accept.ts';
import { StreamRegistry } from '../../../daemon/lib/stream/registry.ts';
import manifest from '../../../manifest.ts';

const refused = (url: URL): Response => new Response(`no ${url.pathname}`, { status: 503 });
const host = async () =>
  await testHost({
    plugins: [voice],
    fakes: { vault: new FakeVault(), gate: new FakeGate(), ferrets: new FakeFerrets() },
    fetch: refused,
  });

describe('GET /v1/voice/stream is declared as the owner decided (O3, unit 4)', () => {
  test('a person-only socket on voice.use', () => {
    const declared = manifest.actions.sockets?.filter(candidate => candidate.path === '/v1/voice/stream') ?? [];
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({
      method: 'GET',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'voice', axis: 'use' },
    });
  });

  test('a ferret and a warden are refused: their credentials are not grant callers, so only caller:person stops them', async () => {
    const h = await host();
    for (const caller of [ferret('f1'), warden()]) {
      const opened = await h.socket('/v1/voice/stream', { as: caller });
      expect(opened.response?.status).toBe(403);
    }
  });

  test('on a machine without speech installed the owner is told so BEFORE the stream opens (409 voice_not_ready)', async () => {
    const opened = await (await host()).socket('/v1/voice/stream', { as: owner() });
    expect(opened.response?.status).toBe(409);
    expect(opened.response?.json()).toMatchObject({ code: 'voice_not_ready' });
  });

  test('a phone whose voice.use is switched off cannot open it, whatever else it holds', async () => {
    const grants = { ...FULL_DEVICE_GRANTS, voice: { use: false, configure: true } } as CapabilityGrants;
    const h = await testHost({
      plugins: [voice],
      fakes: { vault: new FakeVault(), gate: new FakeGate(), ferrets: new FakeFerrets() },
      fetch: refused,
      gate: new StandInAdmission(() => deviceStanding('phone', grants, true)),
    });
    const opened = await h.socket('/v1/voice/stream');
    expect(opened.response?.status).toBe(403);
    expect(CAPABILITY_NAMES).toContain('voice');
  });
});

describe('the accept step (everything said as a status before the protocol switches)', () => {
  const engine = (state: 'ready' | 'not_installed') => ({
    view: async () => ({ state, machine: 'the-box' }) as never,
    transcribe: async () => ({ text: '', decodeMs: 0, realTimeFactor: 0 }),
    detectSpeech: async () => [],
  });
  const deps = (state: 'ready' | 'not_installed', registry = new StreamRegistry()) => ({
    engine: engine(state),
    clock: fixedClock(),
    send: () => undefined,
    resolveFerret: async (reference: string) => reference,
    fleetUseGranted: () => true,
    audit: async () => undefined,
    log: { info: () => undefined },
    registry,
  });
  const downstream: SocketDownstream = { send: () => 0, close: () => undefined, bufferedBytes: () => 0 };
  const callOf = (holder: string) =>
    ({
      request: {},
      params: new Map(),
      credential: { kind: 'authenticated', tokenClass: 'device', principal: { kind: 'device', holder } },
    }) as never;

  test('one stream per device and two per machine: the next is 429 voice_busy and names which', async () => {
    const registry = new StreamRegistry();
    const accept = voiceStreamAccept(deps('ready', registry));
    const first = await (await accept(callOf('phone')))(downstream);
    await expect(accept(callOf('phone'))).rejects.toMatchObject({ status: 429, code: 'voice_busy' });
    const second = await (await accept(callOf('laptop')))(downstream);
    await expect(accept(callOf('tablet'))).rejects.toMatchObject({ status: 429, code: 'voice_busy' });
    expect(first).toBeDefined();
    // Ending a stream frees its place.
    second.close();
    const again = await (await accept(callOf('tablet')))(downstream);
    expect(again).toBeDefined();
  });

  test('speech not installed is 409 voice_not_ready, naming the machine', async () => {
    const accept = voiceStreamAccept(deps('not_installed'));
    const refusal = await accept(callOf('phone')).catch(error => error as ApiError);
    expect(refusal).toBeInstanceOf(ApiError);
    expect((refusal as ApiError).status).toBe(409);
    expect((refusal as ApiError).message).toContain('the-box');
  });
});

describe('voice chat needs fleet.use as well as voice.use (review 2481, blocking 1)', () => {
  const ready = {
    view: async () => ({ state: 'ready', machine: 'the-box' }) as never,
    transcribe: async () => ({ text: '', decodeMs: 0, realTimeFactor: 0 }),
    detectSpeech: async () => [],
  };
  /** The caller's governance as the grant rule answers it for a device holding `device`. */
  const governanceOf = (device: () => CapabilityGrants): CallerGovernance => ({
    governed: true,
    decide: demand =>
      decideCapability(demand, {
        grants: FULL_DEVICE_GRANTS,
        governed: true,
        hostLocal: false,
        stepUp: true,
        device: device(),
      }),
  });
  const open = async (governance: CallerGovernance | undefined, machineFleetUse = true) => {
    const frames: Uint8Array[] = [];
    const closes: { code: number; reason: string }[] = [];
    const downstream: SocketDownstream = {
      send: frame => (frames.push(frame as Uint8Array), (frame as Uint8Array).byteLength),
      close: (code, reason) => void closes.push({ code, reason }),
      bufferedBytes: () => 0,
    };
    const accept = voiceStreamAccept({
      engine: ready,
      clock: fixedClock(),
      send: () => async () => ({ ok: true }),
      resolveFerret: async reference => reference,
      fleetUseGranted: () => machineFleetUse,
      audit: async () => undefined,
      log: { info: () => undefined },
      registry: new StreamRegistry(),
    });
    const call = {
      request: {},
      params: new Map(),
      credential: { kind: 'authenticated', tokenClass: 'device', principal: { kind: 'device', holder: 'phone' } },
      ...(governance === undefined ? {} : { governance }),
    } as never;
    const stream = await (await accept(call))(downstream);
    await stream.open();
    return { stream, frames, closes };
  };
  const chat = JSON.stringify({ t: 'start', v: 1, purpose: 'chat', ferretId: 'fer-1', session: 'vm-test-session' });
  const test_ = JSON.stringify({ t: 'start', v: 1, purpose: 'test' });
  const error = (frames: Uint8Array[]) => frames.map(decodeDownlinkUnit).find(snapshot => snapshot.error)?.error;

  test('RED→GREEN: fleet.use off, voice.use on: a chat start is refused with a sentence and closed', async () => {
    const grants = { ...FULL_DEVICE_GRANTS, fleet: { use: false, configure: false } } as CapabilityGrants;
    const { stream, frames, closes } = await open(governanceOf(() => grants));
    stream.fromClient(chat);
    expect(error(frames)).toMatchObject({ code: 'fleet_not_granted' });
    expect(closes.at(-1)).toEqual(STREAM_CLOSES.forbidden);
  });

  test('fleet.use on: the chat start is taken; Talk to test needs only voice.use', async () => {
    const full = await open(governanceOf(() => FULL_DEVICE_GRANTS));
    full.stream.fromClient(chat);
    expect(error(full.frames)).toBeUndefined();
    expect(full.closes).toEqual([]);
    const grants = { ...FULL_DEVICE_GRANTS, fleet: { use: false, configure: false } } as CapabilityGrants;
    const testOnly = await open(governanceOf(() => grants));
    testOnly.stream.fromClient(test_);
    expect(error(testOnly.frames)).toBeUndefined();
  });

  test('a call with no governance on its standing is refused: nothing is sent for a caller nobody could judge', async () => {
    const { stream, frames } = await open(undefined);
    stream.fromClient(chat);
    expect(error(frames)).toMatchObject({ code: 'fleet_not_granted' });
  });

  test('the machine-wide grant is read live: a device that held it at the start is refused once the machine narrows', async () => {
    const { stream, frames } = await open(
      governanceOf(() => FULL_DEVICE_GRANTS),
      false,
    );
    stream.fromClient(chat);
    expect(error(frames)).toMatchObject({ code: 'fleet_not_granted' });
  });

  test("the audit record is the typed send's: agent.prompted, the ferret as subject, never the words", () => {
    const draft = sentAuditDraft({ kind: 'device', deviceId: 'phone' }, 'fer-1');
    expect(draft).toMatchObject({
      event: 'agent.prompted',
      actor: { kind: 'device', deviceId: 'phone' },
      subject: 'fer-1',
      outcome: 'succeeded',
      detail: { action: 'send', status: 200 },
    });
    expect(JSON.stringify(draft)).not.toContain('voice)');
  });

  test("the audit actor is the device that spoke, or this computer for the host's own token", () => {
    const device = { credential: { tokenClass: 'device', principal: { holder: 'phone' } } };
    expect(auditActorOf(device)).toEqual({ kind: 'device', deviceId: 'phone' });
    expect(auditActorOf({ credential: { tokenClass: 'admin' } })).toEqual({ kind: 'host' });
    expect(auditActorOf({})).toEqual({ kind: 'host' });
  });

  test('a sent message is recorded once; a record that cannot be written is said and does not throw', async () => {
    const written: unknown[] = [];
    const said: string[] = [];
    const log = { info: (message: string) => void said.push(message) };
    sentRecorder({ audit: async draft => void written.push(draft), log }, { kind: 'host' }, 's1')('fer-1');
    await Promise.resolve();
    expect(written).toHaveLength(1);
    sentRecorder(
      {
        audit: async () => {
          throw new Error('the log is full');
        },
        log,
      },
      { kind: 'host' },
      's1',
    )('fer-1');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(said).toEqual(['voice.stream.audit_failed']);
  });
});
