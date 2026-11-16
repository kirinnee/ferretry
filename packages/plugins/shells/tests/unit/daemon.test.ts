import { describe, expect, test } from 'bun:test';
import { device, ferret, testHost } from '@ferretry/kernel/testing';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import type { LaunchPartSource } from '@ferretry/core-ferrets/contract';
import { NixFactsSchema, SHELL_CODES, ShellsPort, ShellListSchema } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { shellsRoutes } from '../../daemon/lib/routes.ts';
import manifest from '../../manifest.ts';
import { flakeFacts, HASH_A, REV_A, shellsHarness } from './support.ts';
import type { ApiRequest, CallContext } from '@ferretry/kernel/contract';

const nixPresent = (args: readonly string[]) => ({
  exitCode: 0,
  signal: null,
  stderr: '',
  stdout: args.includes('--version') ? 'nix (Nix) 2.24.1' : '{}',
});

describe('shells on the test host', () => {
  test('nix present or absent is reported by GET /v1/shells/nix', async () => {
    const present = await testHost({ plugins: [daemon], spawn: (_p, args) => nixPresent(args) });
    const facts = (await present.request('GET', '/v1/shells/nix', { as: device('phone') })).json();
    expect(NixFactsSchema.parse(facts)).toMatchObject({ present: true, version: '2.24.1' });
    await present.stop();

    const absent = await testHost({
      plugins: [daemon],
      spawn: () => {
        throw new Error('ENOENT');
      },
    });
    const missing = (await absent.request('GET', '/v1/shells/nix')).json();
    expect(NixFactsSchema.parse(missing)).toMatchObject({ present: false });
    await absent.stop();
  });

  test('the list is read from config, with an unknown name 404', async () => {
    const host = await testHost({
      plugins: [daemon],
      config: { shells: { web: { flake: `github:me/shells/${REV_A}#web` } } },
    });
    const list = ShellListSchema.parse((await host.request('GET', '/v1/shells')).json());
    expect(list.shells).toEqual([
      { name: 'web', kind: 'flake', locked: false, floating: false, build: 'not-built', usedBy: [] },
    ]);
    expect((await host.request('GET', '/v1/shells/nope')).status).toBe(404);
    expect((await host.provided(ShellsPort).list()).length).toBe(1);
    await host.stop();
  });

  test('a ferret cannot add a shell or build one (person acts); the owner’s add goes through the kernel’s writer and is held for them', async () => {
    const spawn = (_program: string, args: readonly string[]) =>
      args.includes('metadata')
        ? {
            exitCode: 0,
            signal: null,
            stderr: '',
            stdout: JSON.stringify({
              url: `github:me/shells/${REV_A}`,
              locked: { rev: REV_A, narHash: HASH_A },
            }),
          }
        : nixPresent(args);
    const host = await testHost({ plugins: [daemon], spawn });
    const body = { name: 'web', item: { flake: `github:me/shells/${REV_A}#web` } };
    expect((await host.request('POST', '/v1/shells', { body, as: ferret('F1') })).status).toBe(403);
    expect((await host.request('POST', '/v1/shells/web/build', { as: ferret('F1') })).status).toBe(403);
    expect((await host.request('GET', '/v1/shells/web')).status).toBe(404);
    const added = await host.request('POST', '/v1/shells', { body });
    // the kernel judges a new shell loosening: it is held for the owner, and nothing is in effect yet
    expect(added.status).toBe(202);
    expect(added.json<{ held: string[] }>().held.length).toBeGreaterThan(0);
    expect((await host.request('GET', '/v1/shells/web')).status).toBe(404);
    await host.stop();
  });

  test('the daemon takes launch.parts and contributes the shell of the runtime that names one', async () => {
    const h = shellsHarness();
    h.nix.metadata.set(`github:me/shells/${REV_A}`, flakeFacts());
    h.nix.metadata.set(flakeFacts().url, flakeFacts());
    await h.service.add({ name: 'claude-default', item: { flake: `github:me/shells/${REV_A}#web`, floating: false } });
    // The same half, built over the fakes' ports.
    const half = daemon.build?.({
      manifest,
      needs: {},
      uses: {},
      hooks: {} as never,
      kernel: {
        config: h.tree.port,
        state: h.state.port,
        clock: { now: () => '2026-11-07T10:00:00.000Z' },
        events: { publish() {} },
        log: {
          debug() {},
          info() {},
          warn() {},
          error() {},
          child() {
            return this;
          },
        },
        spawn: {
          run: async (_p: string, args: readonly string[]) => ({
            exitCode: 0,
            signal: null,
            stderr: '',
            stdout: args.includes('--version')
              ? 'nix (Nix) 2.24.1'
              : JSON.stringify({ variables: { PATH: { type: 'exported', value: '/nix/store/s/bin' } } }),
          }),
        },
      } as unknown as DaemonContext<typeof manifest>['kernel'],
    } as DaemonContext<typeof manifest>);
    const [contribution] = half?.hooks?.['launch.parts']() ?? [];
    expect(contribution?.id).toBe('shells');
    const source = contribution?.item as LaunchPartSource;
    const parts = await source.parts({ runtime: 'claude-default' } as never);
    expect(parts).toEqual([{ kind: 'shell', name: 'claude-default', env: { PATH: '/nix/store/s/bin' } }]);
    expect(await source.parts({ runtime: 'other' } as never)).toEqual([]);
    expect(manifest.hooks?.takes?.map(take => take.hook.name)).toEqual(['launch.parts']);
  });
});

const call = (body?: unknown, params: Record<string, string> = {}): CallContext =>
  ({
    request: { text: async () => JSON.stringify(body ?? {}) } as unknown as ApiRequest,
    params: new Map(Object.entries(params)),
  }) as CallContext;
const json = (response: { body: string }): any => JSON.parse(response.body);

describe('shell routes', () => {
  const setup = () => {
    const h = shellsHarness();
    h.nix.metadata.set(`github:me/shells/${REV_A}`, flakeFacts());
    h.nix.metadata.set(flakeFacts().url, flakeFacts());
    return { h, r: shellsRoutes(h.service) };
  };
  const web = { name: 'web', item: { flake: `github:me/shells/${REV_A}#web` } };

  test('preview answers the lock and writes nothing; add answers 201 and the lock', async () => {
    const { h, r } = setup();
    const preview = await r['POST /v1/shells/preview'](call(web));
    expect(json(preview).lock.source.narHash).toBe(HASH_A);
    expect(h.tree.calls).toEqual([]);
    const added = await r['POST /v1/shells'](call(web));
    expect(added.status).toBe(201);
    expect(json(added).name).toBe('web');
  });

  test('add held for the owner answers 202 with the sentences', async () => {
    const h = shellsHarness({ hold: ['a new shell will build x'] });
    h.nix.metadata.set(`github:me/shells/${REV_A}`, flakeFacts());
    const added = await shellsRoutes(h.service)['POST /v1/shells'](call(web));
    expect([added.status, json(added).held]).toEqual([202, ['a new shell will build x']]);
  });

  test('a body that is not a shell is 422, not JSON is 400', async () => {
    const { r } = setup();
    await expect(r['POST /v1/shells'](call({ name: 'web', item: {} }))).rejects.toMatchObject({ status: 422 });
    await expect(r['POST /v1/shells'](call({ name: 'Web', item: { packages: ['git'] } }))).rejects.toMatchObject({
      status: 422,
    });
    const broken = { request: { text: async () => '{x' }, params: new Map() } as unknown as CallContext;
    await expect(r['POST /v1/shells'](broken)).rejects.toMatchObject({ status: 400 });
  });

  test('build, relock, get and delete by name; a bad or unknown name is 404', async () => {
    const { r } = setup();
    await r['POST /v1/shells'](call(web));
    expect(json(await r['POST /v1/shells/:name/build'](call(undefined, { name: 'web' }))).outcome).toBe('built');
    expect(json(await r['POST /v1/shells/:name/relock'](call({ expectedHash: HASH_A }, { name: 'web' }))).name).toBe(
      'web',
    );
    expect(json(await r['GET /v1/shells/:name'](call(undefined, { name: 'web' }))).summary.build).toBe('built');
    expect(json(await r['DELETE /v1/shells/:name'](call(undefined, { name: 'web' })))).toEqual({
      name: 'web',
      removed: true,
    });
    for (const name of ['web', '..%2Fx', 'Bad Name'])
      expect((await r['GET /v1/shells/:name'](call(undefined, { name }))).status).toBe(404);
  });
});

test('relock refuses a direct request with no preview hash or a malformed hash', async () => {
  const routes = shellsRoutes(shellsHarness().service);
  for (const body of [{}, { expectedHash: 'anything' }, { expectedHash: HASH_A, approved: true }])
    await expect(routes['POST /v1/shells/:name/relock'](call(body, { name: 'web' }))).rejects.toMatchObject({
      status: 422,
    });
});

test('a refusal from the service comes back as its status and code, not as a thrown error', async () => {
  const routes = shellsRoutes(shellsHarness().service);
  const response = await routes['POST /v1/shells/:name/build'](call(undefined, { name: 'web' }));
  expect(response.status).toBe(404);
  expect(json(response).code).toBe(SHELL_CODES.unknown);
});
