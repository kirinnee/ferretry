import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DoctorChecks } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { bootHost, type RunningHost } from '../../../../../core/kernel/host/host.ts';
import { realAdapters } from '../../../../../core/kernel/host/wiring.ts';
import { openHome } from '../../../../../core/kernel/host/home.ts';
import { acceptedConfigFile, acceptedName } from '../../../../../core/kernel/host/config/accepted.ts';
import { buildConnections } from '../../../daemon/index.ts';
import { HOSTED_RELAY_DIRECTORY_ORIGIN } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';

const homes: string[] = [];
const running: RunningHost[] = [];
afterEach(async () => {
  for (const host of running.splice(0)) await host.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function boot(relay?: unknown, advertisement: unknown = { version: 1, relayUrl: null }) {
  const home = await mkdtemp(`${tmpdir()}/fy-connections-doctor-`);
  homes.push(home);
  const adapters = realAdapters(home, () => undefined, { binary: 'fy' });
  await openHome(adapters.fs, home, 'Connections diagnostic fixture', adapters.clock.now());
  await mkdir(`${home}/config`, { recursive: true });
  if (relay !== undefined) {
    const text = JSON.stringify({ relay });
    await writeFile(`${home}/config/connections.yaml`, text);
    const state = adapters.state({
      id: 'kernel',
      title: 'Kernel config fixture',
      version: '5.0.0',
      api: 5,
      core: true,
      kinds: [],
      data: { state: [acceptedConfigFile] },
    });
    await state.open();
    await state.port.write(
      acceptedConfigFile,
      { etag: createHash('sha256').update(text).digest('hex'), text, plugin: manifest.id },
      acceptedName('connections.yaml'),
    );
    await state.close();
  }
  const asked: { url: string; cache?: RequestCache }[] = [];
  const connections = implementDaemon(manifest, {
    build: ctx =>
      buildConnections(ctx, {
        identity: { daemonId: ctx.kernel.identity.daemonId, sign: request => ctx.kernel.signer.sign(request) },
        openSession: (layer, key, peer) => layer.open(key, peer),
        host: '127.0.0.1',
        port: 7431,
        socketFactory: () => ({
          binaryType: '',
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send: () => undefined,
          close: () => undefined,
        }),
      }),
  });
  // A later capability diagnostic proves ordering at the real host's contribution collector.
  const capabilityManifest = definePlugin({
    id: 'gate',
    title: 'Gate',
    version: '5.0.0',
    api: 5,
    core: true,
    kinds: [],
    doctor: ['capabilities'],
  });
  const capabilities = implementDaemon(capabilityManifest, {
    build: () => ({
      doctor: {
        capabilities: async () => ({ state: 'ok', detail: 'capability diagnostic follows reachability' }),
      },
    }),
  });
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    implementations: [capabilities, connections],
    adapters: {
      ...adapters,
      fetch: {
        request: async (url, init) => {
          asked.push({ url: String(url), cache: init?.cache });
          return advertisement instanceof Error ? Promise.reject(advertisement) : Response.json(advertisement);
        },
      },
      spawn: {
        run: async () => {
          throw new Error('no processes in this fixture');
        },
        runBytes: async () => {
          throw new Error('no processes in this fixture');
        },
        start: () => {
          throw new Error('no processes in this fixture');
        },
      },
      websocket: {
        connect: () => {
          throw new Error('no network in this fixture');
        },
      },
    },
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  running.push(outcome.host);
  const report = await outcome.host.doctor();
  const finding = report.find(line => line.plugin === 'connections.reachability');
  expect(finding).toBeDefined();
  return { finding: finding!, report, asked, host: outcome.host };
}

test('G158 R206 the production doctor states loopback reachability before posture and remedy with a failed directory', async () => {
  const { finding, asked, host } = await boot(undefined, new Error('directory down'));
  expect(host.hooks.contributions(DoctorChecks).map(check => check.id)).toEqual(['connections.reachability']);
  expect(asked).toEqual([{ url: `${HOSTED_RELAY_DIRECTORY_ORIGIN}/v1/default-relay`, cache: 'no-store' }]);
  expect(finding.state).toBe('warn');
  const lines = finding.detail.split('\n');
  expect(lines[0]).toBe('reachability nothing off this host can reach this daemon');
  expect(lines[1]).toContain(
    'direct-only — no relay could be discovered: this daemon could not reach the relay directory',
  );
  expect(finding.detail).toContain('another device cannot pair yet');
  expect(finding.detail).toContain('Restart to ask the hosted relay directory again');
  expect(finding.detail).toContain('"relay" entry in config/connections.yaml');
  expect(finding.detail).not.toMatch(/carriers|publicUrl|0\.0\.0\.0/u);
  expect(finding.detail).not.toMatch(/password|may use|change settings for/u);
});

test('G158 reachability contributions precede declared capability checks in the production doctor', async () => {
  const { report } = await boot(undefined, { version: 1, relayUrl: 'https://hosted.example' });
  expect(report.findIndex(line => line.plugin === 'connections.reachability')).toBeLessThan(
    report.findIndex(line => line.plugin === 'gate' && line.check === 'capabilities'),
  );
});

test('G158 R206 the production doctor counts the hosted relay on a loopback listener and does one guarded directory read', async () => {
  const { finding, asked, host } = await boot(undefined, { version: 1, relayUrl: 'https://hosted.example' });
  expect(finding.state).toBe('ok');
  expect(finding.detail.split('\n')[0]).toContain('other devices can reach');
  expect(finding.detail.split('\n')[1]).toContain('hosted — https://hosted.example, from Ferretry');
  expect(finding.detail).not.toContain('dials no relay');
  await host.doctor();
  expect(asked).toHaveLength(1);
});

test('G158 R206 the production doctor names every ordered configured relay and gives no global absence remedy beside an active sibling', async () => {
  const { finding, asked } = await boot([
    { url: 'https://off.example', enabled: false },
    { url: 'https://mine.example' },
  ]);
  expect(asked).toEqual([]);
  expect(finding.state).toBe('ok');
  const lines = finding.detail.split('\n');
  expect(lines[1]).toContain('direct-only — the relay https://off.example is switched off');
  expect(lines[2]).toContain('self-hosted — https://mine.example, from connections.yaml');
  expect(finding.detail).not.toContain('dials no relay');
});

test('R206 a configured relay switched off is diagnosed with its own remedy', async () => {
  const { finding } = await boot([{ url: 'https://mine.example', enabled: false }]);
  expect(finding.state).toBe('warn');
  expect(finding.detail).toContain('direct-only — the relay https://mine.example is switched off');
  expect(finding.detail).toContain('correct or remove the top-level "relay" entry in config/connections.yaml');
});
