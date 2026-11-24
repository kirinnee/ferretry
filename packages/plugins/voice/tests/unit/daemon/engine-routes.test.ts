import { describe, expect, test } from 'bun:test';
import type { HostFactsPort } from '@ferretry/kernel/contract';
import { ferret, owner, testHost, warden } from '@ferretry/kernel/testing';
import { CAPABILITY_NAMES, FULL_DEVICE_GRANTS, type CapabilityGrants } from '@ferretry/core-gate/contract';
import { deviceStanding, FakeGate, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { ENGINE_HOSTS, VoiceEngineViewSchema } from '../../../contract/index.ts';
import voice from '../../../daemon/index.ts';
import { ENGINE_FILES } from '../../../daemon/lib/engine/catalog.ts';
import { nativeTargetFor } from '../../../daemon/lib/native/catalog.ts';
import manifest from '../../../manifest.ts';

const refused = (url: URL): Response => new Response(`no ${url.pathname}`, { status: 503 });

async function host(fetch: (url: URL) => Response | Promise<Response> = refused) {
  return await testHost({
    plugins: [voice],
    fakes: { vault: new FakeVault(), gate: new FakeGate(), ferrets: new FakeFerrets() },
    fetch,
  });
}

describe('the machine speech engine routes', () => {
  test('are declared with the owner’s grants: a read is voice.use; install and remove are a person’s voice.configure', () => {
    const routes = manifest.actions.routes.filter(
      candidate => candidate.path === '/v1/voice/engine' || candidate.path === '/v1/voice/engine/install',
    );
    expect(routes.map(candidate => `${candidate.method} ${candidate.path}`)).toEqual([
      'GET /v1/voice/engine',
      'POST /v1/voice/engine/install',
      'DELETE /v1/voice/engine',
    ]);
    const [read, install, remove] = routes;
    expect(read?.capability).toMatchObject({ capability: 'voice', axis: 'use' });
    expect(install?.capability).toMatchObject({ capability: 'voice', axis: 'configure' });
    expect(remove?.capability).toMatchObject({ capability: 'voice', axis: 'configure' });
    expect([install?.caller, remove?.caller]).toEqual(['person', 'person']);
    expect(routes.every(candidate => candidate.noStore === true)).toBe(true);
  });

  test('the hosts Install may reach are declared, and no file is fetched from anywhere else', () => {
    const declared = manifest.permissions?.network ?? [];
    for (const entry of ENGINE_HOSTS) expect(declared).toContain(entry);
    expect(manifest.workers).toEqual(['speech', 'reply']);
    expect(
      ENGINE_FILES.every(file => ['huggingface.co', 'cdn.jsdelivr.net'].includes(new URL(file.url).hostname)),
    ).toBe(true);
  });

  test('a fresh machine reads as not installed, with the size Install would download', async () => {
    const response = await (await host()).request('GET', '/v1/voice/engine', { as: owner() });
    expect(response.status).toBe(200);
    const view = VoiceEngineViewSchema.parse(response.json());
    expect(view).toMatchObject({ state: 'not_installed', doneBytes: 0, loaded: false });
    // What Install downloads on THIS machine: the native engine's library beside the models where there is one (the
    // WebAssembly runtime is then not fetched), the whole WebAssembly set where there is not.
    const target = nativeTargetFor(process.platform, process.arch);
    const wasm = ENGINE_FILES.reduce((total, file) => total + file.bytes, 0);
    expect(view.sizeBytes).toBe(
      target === undefined
        ? wasm
        : ENGINE_FILES.filter(file => file.role !== 'sherpa-wasm').reduce((total, file) => total + file.bytes, 0) +
            target.files.reduce((total, file) => total + file.bytes, 0),
    );
    expect(view.sizeBytes).toBeGreaterThan(680_000_000);
  });

  test('Install answers 202 at once and a failed download is read back as failed, with a sentence', async () => {
    const h = await host();
    const started = await h.request('POST', '/v1/voice/engine/install', { as: owner() });
    expect(started.status).toBe(202);
    expect(['installing', 'failed']).toContain(VoiceEngineViewSchema.parse(started.json()).state);
    let view = VoiceEngineViewSchema.parse((await h.request('GET', '/v1/voice/engine', { as: owner() })).json());
    for (let attempt = 0; attempt < 50 && view.state === 'installing'; attempt += 1) {
      await Bun.sleep(10);
      view = VoiceEngineViewSchema.parse((await h.request('GET', '/v1/voice/engine', { as: owner() })).json());
    }
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('download_failed');
  });

  test('a ferret and a warden may neither install nor remove', async () => {
    const h = await host();
    for (const caller of [ferret('f1'), warden()]) {
      expect((await h.request('POST', '/v1/voice/engine/install', { as: caller })).status).toBe(403);
      expect((await h.request('DELETE', '/v1/voice/engine', { as: caller })).status).toBe(403);
    }
  });

  test('Remove on a machine with nothing installed answers the not-installed view', async () => {
    const response = await (await host()).request('DELETE', '/v1/voice/engine', { as: owner() });
    expect(response.status).toBe(200);
    expect(VoiceEngineViewSchema.parse(response.json()).state).toBe('not_installed');
  });
});

describe('the voice capability governs the engine routes (owner decision O3)', () => {
  const grantsWith = (name: (typeof CAPABILITY_NAMES)[number], grant: { use: boolean; configure: boolean }) =>
    ({ ...FULL_DEVICE_GRANTS, [name]: grant }) as CapabilityGrants;

  async function gated(grants: CapabilityGrants) {
    return await testHost({
      plugins: [voice],
      fakes: { vault: new FakeVault(), gate: new FakeGate(), ferrets: new FakeFerrets() },
      fetch: refused,
      // A paired phone, with the passkey step-up already done: only the grants decide here.
      gate: new StandInAdmission(() => deviceStanding('phone', grants, true)),
    });
  }

  test('a phone whose voice.configure is switched off cannot Install or Remove, but may still read', async () => {
    const h = await gated(grantsWith('voice', { use: true, configure: false }));
    const install = await h.request('POST', '/v1/voice/engine/install');
    expect(install.status).toBe(403);
    expect(install.json()).toMatchObject({ code: 'grant_device_not_granted' });
    expect((await h.request('DELETE', '/v1/voice/engine')).status).toBe(403);
    expect((await h.request('GET', '/v1/voice/engine')).status).toBe(200);
  });

  test('a phone whose voice.use is switched off cannot even read the engine', async () => {
    const h = await gated(grantsWith('voice', { use: false, configure: false }));
    expect((await h.request('GET', '/v1/voice/engine')).status).toBe(403);
  });

  test('narrowing fleet no longer governs the engine: a phone with only fleet switched off still installs', async () => {
    const h = await gated(grantsWith('fleet', { use: false, configure: false }));
    expect((await h.request('GET', '/v1/voice/engine')).status).toBe(200);
    expect((await h.request('POST', '/v1/voice/engine/install')).status).toBe(202);
  });
});

describe('Install checks the disk through the host', () => {
  const withFree = async (free: number | undefined) =>
    await testHost({
      plugins: [voice],
      fakes: { vault: new FakeVault(), gate: new FakeGate(), ferrets: new FakeFerrets() },
      fetch: refused,
      hostFacts: { diskFreeBytes: async () => free } as unknown as HostFactsPort,
    });

  async function installed(free: number | undefined) {
    const h = await withFree(free);
    await h.request('POST', '/v1/voice/engine/install', { as: owner() });
    let view = VoiceEngineViewSchema.parse((await h.request('GET', '/v1/voice/engine', { as: owner() })).json());
    for (let attempt = 0; attempt < 50 && view.state === 'installing'; attempt += 1) {
      await Bun.sleep(10);
      view = VoiceEngineViewSchema.parse((await h.request('GET', '/v1/voice/engine', { as: owner() })).json());
    }
    return view;
  }

  test('a disk short of the files plus 1 GB fails as no_disk, with the sizes in the sentence', async () => {
    const view = await installed(900_000_000);
    expect(view.state).toBe('failed');
    expect(view.failure?.code).toBe('no_disk');
    expect(view.failure?.sentence).toContain('1.7 GB free');
    expect(view.failure?.sentence).toContain('has 900 MB free');
  });

  test('a disk with the room goes on to download (here the fake server refuses, so it fails there instead)', async () => {
    const view = await installed(50_000_000_000);
    expect(view.failure?.code).toBe('download_failed');
  });
});
