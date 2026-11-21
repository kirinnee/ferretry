import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { type Admission, AdmissionPort } from '../../../contract/bound.ts';
import { jsonResponse, queryFrom } from '../../../contract/http.ts';
import type { CarrierKey } from '../../../contract/ids.ts';
import { SessionModes } from '../../../contract/kernel.ts';
import { bootHost, type RunningHost } from '../../../host/host.ts';
import {
  devicePairMessage,
  SESSION_PROTOCOL_ID,
  sessionIdFromBytes,
  signDeviceProof,
  toBase64Url,
} from '../../../host/session/index.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, route } from '../../../manifest/index.ts';
import { recordingAdmission, request } from '../../unit/host/fixtures.ts';
import { TestClient } from '../../unit/host-session/harness.ts';
import { relayCrypto } from '../../unit/host-session/identities.ts';

const homes: string[] = [];
const running: RunningHost[] = [];
afterEach(async () => {
  for (const host of running.splice(0)) await host.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const HOSTNAME = 'pebox-hostname';

/** The stand-in admission, which also lets a config file be read and written (the real Gate judges that per file). */
const admitsConfig = (): Admission => ({ ...recordingAdmission(), judgeConfigAccess: () => ({ allowed: true }) });

/** A gate that admits everything, and a plugin whose route answers what a mint would read: `kernel.identity.daemonName`. */
function plugins() {
  const gate = definePlugin({
    id: 'gate',
    title: 'Gate',
    version: '5.0.0',
    api: 5,
    core: true,
    kinds: [],
    provides: { admission: AdmissionPort },
  });
  const minter = definePlugin({
    id: 'minter',
    title: 'Minter',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    actions: {
      routes: [
        route('GET /v1/minter/name', {
          minimum: 'authenticated',
          caller: 'any',
          audit: { skip: 'test' },
          guard: { none: 'test' },
        }),
      ],
    },
  });
  return [
    implementDaemon(gate, { build: () => ({ provides: { admission: admitsConfig() } }) }),
    implementDaemon(minter, {
      build: ctx => ({
        routes: { 'GET /v1/minter/name': async () => jsonResponse({ daemonName: ctx.kernel.identity.daemonName }) },
      }),
    }),
  ];
}

async function boot(): Promise<{ readonly host: RunningHost; readonly home: string }> {
  const parent = await mkdtemp(`${tmpdir()}/fy-machine-name-`);
  homes.push(parent);
  const home = `${parent}/home`;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    implementations: plugins(),
    adapters: { ...realAdapters(home, () => {}, { binary: 'fy' }), hostname: () => HOSTNAME },
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  running.push(outcome.host);
  return { host: outcome.host, home };
}

const json = (response: { readonly body: string }): Record<string, unknown> =>
  JSON.parse(response.body) as Record<string, unknown>;

const inventoryName = async (host: RunningHost): Promise<unknown> =>
  json(await host.dispatch(request('GET', '/v1/plugins'))).daemonName;
const mintedName = async (host: RunningHost): Promise<unknown> =>
  json(await host.dispatch(request('GET', '/v1/minter/name'))).daemonName;

const until = async (condition: () => Promise<boolean>, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`waited 5000 ms for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

const hostFile = async (host: RunningHost): Promise<Record<string, unknown>> =>
  json(await host.dispatch({ ...request('GET', '/v1/config/file'), query: queryFrom([['path', 'host.yaml']]) }));

const put = async (host: RunningHost, text: string) => {
  const file = await hostFile(host);
  return await host.dispatch(
    request('PUT', '/v1/config/file', {
      body: JSON.stringify({ path: 'host.yaml', text, etag: file.etag }),
    }),
  );
};

describe('the machine name is the owner’s, else the host name, with no restart', () => {
  test('no host.yaml: the inventory and a mint name the host name', async () => {
    const { host } = await boot();
    expect(await inventoryName(host)).toBe(HOSTNAME);
    expect(await mintedName(host)).toBe(HOSTNAME);
  });

  test('writing host.yaml changes the inventory and the next mint, and deleting it returns the host name', async () => {
    const { host } = await boot();
    expect((await put(host, 'name: "pebox"\n')).status).toBe(200);
    await until(async () => (await inventoryName(host)) === 'pebox', 'the inventory to carry the new name');
    expect(await mintedName(host)).toBe('pebox');

    expect((await put(host, 'name: "Büro 🦫"\n')).status).toBe(200);
    await until(async () => (await mintedName(host)) === 'Büro 🦫', 'the next mint to carry the second name');
    expect(await inventoryName(host)).toBe('Büro 🦫');

    const file = await hostFile(host);
    const removed = await host.dispatch({
      ...request('DELETE', '/v1/config/file'),
      query: queryFrom([
        ['path', 'host.yaml'],
        ['etag', String(file.etag)],
      ]),
    });
    expect(removed.status).toBe(200);
    await until(async () => (await inventoryName(host)) === HOSTNAME, 'the host name to return');
    expect(await mintedName(host)).toBe(HOSTNAME);
  });

  test('a name the schema refuses is never written, and a broken host.yaml keeps the last good name', async () => {
    const { host, home } = await boot();
    expect((await put(host, 'name: "pebox"\n')).status).toBe(200);
    await until(async () => (await inventoryName(host)) === 'pebox', 'the owner name to be in effect');

    const refused = await put(host, `name: ${JSON.stringify('bell\u0007')}\n`);
    expect(refused.status).toBe(422);
    expect(await inventoryName(host)).toBe('pebox');

    // Edited by hand into something that does not parse: the file is broken, the name that was good stays.
    await writeFile(`${home}/config/host.yaml`, 'name: [unterminated\n');
    await until(async () => {
      const status = json(await host.dispatch(request('GET', '/v1/config/status')));
      return JSON.stringify(status.issues ?? []).includes('host.yaml');
    }, 'the broken file to be seen');
    expect(await inventoryName(host)).toBe('pebox');
    expect(await mintedName(host)).toBe('pebox');
  });
});

/** A `pair` mode that accepts every code and answers the name this machine goes by at that moment, as Access's does. */
function pairingPlugin() {
  const pairer = definePlugin({
    id: 'access',
    title: 'Access',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    hooks: { takes: [{ hook: SessionModes, key: 'pair' }] },
  });
  return implementDaemon(pairer, {
    build: ctx => ({
      hooks: {
        'session.modes:pair': {
          principalKind: 'none' as const,
          redeem: async attempt => {
            const proved = await attempt.prove();
            return proved
              ? {
                  outcome: 'paired',
                  fields: { response: { deviceId: 'dev', daemonName: ctx.kernel.identity.daemonName } },
                }
              : 'refused';
          },
        },
      },
    }),
  });
}

describe('a machine name typed while pairing is the machine’s name from the answer on', () => {
  async function pairAs(host: RunningHost, machineName: string | undefined): Promise<Record<string, unknown>> {
    const id = sessionIdFromBytes(crypto.getRandomValues(new Uint8Array(16)));
    if (id === null) throw new Error('fixture id');
    const client = new TestClient(host.sessionLayer.open('direct' as CarrierKey, { address: '192.0.2.9' }), id);
    await client.handshake(host.identity.daemonId);
    const key = await relayCrypto.generateDeviceKey();
    const deviceKey = toBase64Url(key.publicKeySpki);
    const proof = await signDeviceProof(
      relayCrypto,
      relayCrypto.deviceKeyHandle(key.privateKey),
      devicePairMessage(client.transcript ?? new Uint8Array(), deviceKey),
    );
    await client.send({
      t: 'pair',
      protocol: SESSION_PROTOCOL_ID,
      code: 'ABCD-1234',
      deviceName: 'phone',
      ...(machineName === undefined ? {} : { machineName }),
      deviceKey,
      proof,
    });
    // Saving the name writes a file, so the answer comes after the disk, not after one turn of the loop.
    await until(async () => (await client.pump(), client.last('paired') !== undefined), 'the paired answer');
    return (client.last('paired') as { response: Record<string, unknown> }).response;
  }

  async function bootPairing() {
    const parent = await mkdtemp(`${tmpdir()}/fy-machine-name-pair-`);
    homes.push(parent);
    const home = `${parent}/home`;
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      implementations: [...plugins(), pairingPlugin()],
      adapters: { ...realAdapters(home, () => {}, { binary: 'fy' }), hostname: () => HOSTNAME },
    });
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    running.push(outcome.host);
    return outcome.host;
  }

  test('the name is saved in host.yaml, answered, and read by the next mint', async () => {
    const host = await bootPairing();
    expect((await pairAs(host, 'Studio box'))['daemonName']).toBe('Studio box');
    expect(await mintedName(host)).toBe('Studio box');
    expect(await inventoryName(host)).toBe('Studio box');
  });

  test('no name typed: the host name stays; an owner’s own name is never replaced', async () => {
    const host = await bootPairing();
    expect((await pairAs(host, undefined))['daemonName']).toBe(HOSTNAME);
    expect((await put(host, 'name: "pebox"\n')).status).toBe(200);
    await until(async () => (await mintedName(host)) === 'pebox', 'the owner name to be in effect');
    expect((await pairAs(host, 'Studio box'))['daemonName']).toBe('pebox');
    expect(await mintedName(host)).toBe('pebox');
  });

  test('a name the daemon’s rule refuses is not saved', async () => {
    const host = await bootPairing();
    expect((await pairAs(host, 'bell\u0007'))['daemonName']).toBe(HOSTNAME);
    expect(await mintedName(host)).toBe(HOSTNAME);
  });
});
