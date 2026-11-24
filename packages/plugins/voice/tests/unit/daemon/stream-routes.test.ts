import { describe, expect, test } from 'bun:test';
import { ApiError, type SocketDownstream } from '@ferretry/kernel/contract';
import { ferret, owner, testHost, warden } from '@ferretry/kernel/testing';
import { CAPABILITY_NAMES, FULL_DEVICE_GRANTS, type CapabilityGrants } from '@ferretry/core-gate/contract';
import { deviceStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { fixedClock } from '@ferretry/kernel/testing';
import voice from '../../../daemon/index.ts';
import { voiceStreamAccept } from '../../../daemon/lib/stream/accept.ts';
import { StreamRegistry } from '../../../daemon/lib/stream/registry.ts';
import manifest from '../../../manifest.ts';

const refused = (url: URL): Response => new Response(`no ${url.pathname}`, { status: 503 });
const host = async () => await testHost({ plugins: [voice], fakes: { vault: new FakeVault() }, fetch: refused });

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
      fakes: { vault: new FakeVault() },
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
