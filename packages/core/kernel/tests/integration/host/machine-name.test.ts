import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { type Admission, AdmissionPort } from '../../../contract/bound.ts';
import { jsonResponse, queryFrom } from '../../../contract/http.ts';
import { bootHost, type RunningHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, route } from '../../../manifest/index.ts';
import { recordingAdmission, request } from '../../unit/host/fixtures.ts';

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
