import { describe, expect, test } from 'bun:test';
import { ferret, owner, testHost, warden } from '@ferretry/kernel/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { ENGINE_HOSTS, VoiceEngineViewSchema } from '../../../contract/index.ts';
import voice from '../../../daemon/index.ts';
import { ENGINE_FILES } from '../../../daemon/lib/engine/catalog.ts';
import manifest from '../../../manifest.ts';

const refused = (url: URL): Response => new Response(`no ${url.pathname}`, { status: 503 });

async function host(fetch: (url: URL) => Response | Promise<Response> = refused) {
  return await testHost({ plugins: [voice], fakes: { vault: new FakeVault() }, fetch });
}

describe('the machine speech engine routes', () => {
  test('are declared with the owner’s grants: a read is fleet.use; install and remove are a person’s fleet.configure', () => {
    const routes = manifest.actions.routes.filter(
      candidate => candidate.path === '/v1/voice/engine' || candidate.path === '/v1/voice/engine/install',
    );
    expect(routes.map(candidate => `${candidate.method} ${candidate.path}`)).toEqual([
      'GET /v1/voice/engine',
      'POST /v1/voice/engine/install',
      'DELETE /v1/voice/engine',
    ]);
    const [read, install, remove] = routes;
    expect(read?.capability).toMatchObject({ capability: 'fleet', axis: 'use' });
    expect(install?.capability).toMatchObject({ capability: 'fleet', axis: 'configure' });
    expect(remove?.capability).toMatchObject({ capability: 'fleet', axis: 'configure' });
    expect([install?.caller, remove?.caller]).toEqual(['person', 'person']);
    expect(routes.every(candidate => candidate.noStore === true)).toBe(true);
  });

  test('the hosts Install may reach are declared, and no file is fetched from anywhere else', () => {
    const declared = manifest.permissions?.network ?? [];
    for (const entry of ENGINE_HOSTS) expect(declared).toContain(entry);
    expect(manifest.workers).toEqual(['speech']);
    expect(
      ENGINE_FILES.every(file => ['huggingface.co', 'cdn.jsdelivr.net'].includes(new URL(file.url).hostname)),
    ).toBe(true);
  });

  test('a fresh machine reads as not installed, with the size Install would download', async () => {
    const response = await (await host()).request('GET', '/v1/voice/engine', { as: owner() });
    expect(response.status).toBe(200);
    const view = VoiceEngineViewSchema.parse(response.json());
    expect(view).toMatchObject({ state: 'not_installed', doneBytes: 0, loaded: false });
    expect(view.sizeBytes).toBe(ENGINE_FILES.reduce((sum, file) => sum + file.bytes, 0));
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
