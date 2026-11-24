import { describe, expect, test } from 'bun:test';
import type { HostFactsPort } from '@ferretry/kernel/contract';
import { ferret, owner, testHost, warden } from '@ferretry/kernel/testing';
import { CAPABILITY_NAMES, FULL_DEVICE_GRANTS, type CapabilityGrants } from '@ferretry/core-gate/contract';
import { deviceStanding, FakeGate, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { ReplyVoiceViewSchema } from '../../../contract/index.ts';
import voice from '../../../daemon/index.ts';
import { nativeTargetFor } from '../../../daemon/lib/native/catalog.ts';
import { REPLY_FILES, REPLY_NATIVE_MODEL } from '../../../daemon/lib/reply/catalog.ts';
import manifest from '../../../manifest.ts';

const refused = (url: URL): Response => new Response(`no ${url.pathname}`, { status: 503 });

async function host(fetch: (url: URL) => Response | Promise<Response> = refused) {
  return await testHost({
    plugins: [voice],
    fakes: { vault: new FakeVault(), gate: new FakeGate(), ferrets: new FakeFerrets() },
    fetch,
    hostFacts: {
      platform: process.platform,
      cpus: 4,
      diskFreeBytes: async () => undefined,
    } as unknown as HostFactsPort,
  });
}

describe('the reply voice routes', () => {
  test('are declared like the engine’s: a read is voice.use; install and remove are a person’s voice.configure', () => {
    const routes = manifest.actions.routes.filter(
      candidate => candidate.path === '/v1/voice/reply-voice' || candidate.path === '/v1/voice/reply-voice/install',
    );
    expect(routes.map(candidate => `${candidate.method} ${candidate.path}`)).toEqual([
      'GET /v1/voice/reply-voice',
      'POST /v1/voice/reply-voice/install',
      'DELETE /v1/voice/reply-voice',
    ]);
    const [read, install, remove] = routes;
    expect(read?.capability).toMatchObject({ capability: 'voice', axis: 'use' });
    expect(install?.capability).toMatchObject({ capability: 'voice', axis: 'configure' });
    expect(remove?.capability).toMatchObject({ capability: 'voice', axis: 'configure' });
    expect([install?.caller, remove?.caller]).toEqual(['person', 'person']);
    expect(routes.every(candidate => candidate.noStore === true)).toBe(true);
    expect(manifest.workers).toEqual(['speech', 'reply', 'speech-host']);
  });

  test('the files it downloads come only from hosts the manifest declares', () => {
    const declared = manifest.permissions?.network ?? [];
    for (const file of REPLY_FILES) {
      const hostname = new URL(file.url).hostname;
      expect(
        declared.some(entry => entry === hostname || (entry.startsWith('*.') && hostname.endsWith(entry.slice(1)))),
      ).toBe(true);
    }
  });

  test('a fresh machine reads as not installed, with what Install would download', async () => {
    const response = await (await host()).request('GET', '/v1/voice/reply-voice', { as: owner() });
    expect(response.status).toBe(200);
    const view = ReplyVoiceViewSchema.parse(response.json());
    expect(view).toMatchObject({ state: 'not_installed', doneBytes: 0, loaded: false });
    // The native engine's plan where this machine has one (the library, the fp32 model, the shared files), else WebAssembly's.
    const target = nativeTargetFor(process.platform, process.arch);
    expect(view.sizeBytes).toBe(
      target === undefined
        ? REPLY_FILES.reduce((total, file) => total + file.bytes, 0)
        : REPLY_FILES.filter(file => ['voices', 'tokens', 'lexicon'].includes(file.role)).reduce(
            (total, file) => total + file.bytes,
            0,
          ) +
            REPLY_NATIVE_MODEL.bytes +
            target.files.reduce((total, file) => total + file.bytes, 0),
    );
  });

  test('Install answers 202 at once; a server that is down reads back as failed, with a sentence', async () => {
    const h = await host();
    const started = await h.request('POST', '/v1/voice/reply-voice/install', { as: owner() });
    expect(started.status).toBe(202);
    let view = ReplyVoiceViewSchema.parse((await h.request('GET', '/v1/voice/reply-voice', { as: owner() })).json());
    for (let attempt = 0; attempt < 100 && view.state === 'installing'; attempt += 1) {
      await Bun.sleep(10);
      view = ReplyVoiceViewSchema.parse((await h.request('GET', '/v1/voice/reply-voice', { as: owner() })).json());
    }
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('download_failed');
  });

  test('Remove on a machine with nothing installed answers the not-installed view; while installing it is refused (409)', async () => {
    const h = await host();
    const response = await h.request('DELETE', '/v1/voice/reply-voice', { as: owner() });
    expect(response.status).toBe(200);
    expect(ReplyVoiceViewSchema.parse(response.json()).state).toBe('not_installed');
    await h.request('POST', '/v1/voice/reply-voice/install', { as: owner() });
    const busy = await h.request('DELETE', '/v1/voice/reply-voice', { as: owner() });
    expect([200, 409]).toContain(busy.status);
    if (busy.status === 409) expect(busy.json()).toMatchObject({ code: 'not_ready' });
  });

  test('a ferret and a warden may neither install nor remove', async () => {
    const h = await host();
    for (const caller of [ferret('f1'), warden()]) {
      expect((await h.request('POST', '/v1/voice/reply-voice/install', { as: caller })).status).toBe(403);
      expect((await h.request('DELETE', '/v1/voice/reply-voice', { as: caller })).status).toBe(403);
    }
  });
});

describe('the voice capability governs the reply voice routes', () => {
  const grantsWith = (name: (typeof CAPABILITY_NAMES)[number], grant: { use: boolean; configure: boolean }) =>
    ({ ...FULL_DEVICE_GRANTS, [name]: grant }) as CapabilityGrants;

  async function gated(grants: CapabilityGrants) {
    return await testHost({
      plugins: [voice],
      fakes: { vault: new FakeVault(), gate: new FakeGate(), ferrets: new FakeFerrets() },
      fetch: refused,
      gate: new StandInAdmission(() => deviceStanding('phone', grants, true)),
    });
  }

  test('a phone whose voice.configure is off cannot Install or Remove, but may read; with voice.use off it cannot read', async () => {
    const h = await gated(grantsWith('voice', { use: true, configure: false }));
    expect((await h.request('POST', '/v1/voice/reply-voice/install')).status).toBe(403);
    expect((await h.request('DELETE', '/v1/voice/reply-voice')).status).toBe(403);
    expect((await h.request('GET', '/v1/voice/reply-voice')).status).toBe(200);
    const none = await gated(grantsWith('voice', { use: false, configure: false }));
    expect((await none.request('GET', '/v1/voice/reply-voice')).status).toBe(403);
  });
});
