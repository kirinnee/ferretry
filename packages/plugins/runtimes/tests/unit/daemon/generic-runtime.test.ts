import { afterEach, expect, test } from 'bun:test';
import type {
  HarnessFacts,
  HarnessRuntimeDescriptor,
  HarnessRuntimeModels,
  StartDecideInput,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { HarnessKeySchema } from '@ferretry/core-ferrets/contract';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { KernelPorts } from '@ferretry/kernel/contract';
import { testHost, type TestHost } from '@ferretry/kernel/testing';
import {
  fakeLogins,
  fakeLoginChanges,
  fakeLoginEnvImport,
  sampleLogin,
} from '@ferretry/plugin-logins/contract/testing';
import {
  RuntimesPort,
  RuntimeIdSchema,
  RUNTIMES_CONFIG,
  RUNTIME_ITEMS,
  PROFILE_ITEMS,
  MODEL_SET_ITEMS,
} from '../../../contract/index.ts';
import { hostAssembly, runtimesDaemon, type RuntimesAssembly } from '../../../daemon/index.ts';
import { GenericRuntimes } from '../../../daemon/lib/generic-runtime.ts';
import { cleanupWorlds, fleetWorld } from '../support/fleet-world.ts';

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  await cleanupWorlds();
});

async function fixture(
  options: {
    key?: string;
    configured?: boolean;
    allowWrite?: boolean;
    profile?: readonly string[];
    noInstall?: boolean;
    noManagers?: boolean;
    invalidState?: object;
  } = {},
) {
  const key = options.key ?? 'fourth';
  let installed = true;
  let detectFailure = false;
  let modelFailure = false;
  let enabled = true;
  let descriptor = true;
  let installExit = 0;
  let installThrows = false;
  let models: HarnessRuntimeModels = {
    choices: [{ id: 'provider/model', label: 'Real fixture model', context: 123_456, variants: ['native'] }],
    default: 'provider/model',
  };
  const spawns: string[] = [];
  const runtime: HarnessRuntimeDescriptor = {
    binary: 'fourth',
    homeEnv: { FOURTH_HOME: '' },
    ...(options.noInstall ? {} : { install: { npm: ['install', '-g', 'fixture-fourth'] } }),
    detect: async () => {
      if (detectFailure) throw new Error('private failure that must not be quoted');
      return installed
        ? { found: true, binary: '/fixture/bin/fourth', version: '1.0.0' }
        : { found: false, reason: 'Install Fourth' };
    },
    models: async () => {
      if (modelFailure) throw new Error('private failure that must not be quoted');
      return models;
    },
  };
  const facts: HarnessFacts = {
    displayName: 'Fourth',
    instructionFile: 'RULES.md',
    skillsDir: 'skills',
    mcp: { format: 'json', file: 'fourth.json' },
    transcriptFormat: 'fourth',
    catalogHalf: 'fourth',
  };
  class RegisteredFerrets extends FakeFerrets {
    override harnesses() {
      return enabled ? ['claude-code', 'codex', key] : ['claude-code', 'codex'];
    }
    override harnessFacts(given: string) {
      return given === key ? facts : super.harnessFacts(given);
    }
    harnessRuntime(given: string) {
      return descriptor && given === key ? runtime : undefined;
    }
  }
  const ferrets = new RegisteredFerrets();
  const logins = fakeLogins([sampleLogin('key', { store: 'environment', harnesses: ['claude-code', key] })]);
  logins.setTemplates([
    {
      id: 'key',
      kind: 'templates',
      harness: HarnessKeySchema.parse(key),
      env: { FOURTH_API_KEY: '${secret:FOURTH_API_KEY}' },
    },
  ]);
  const world = await fleetWorld();
  let kernel: KernelPorts | undefined;
  let base: RuntimesAssembly | undefined;
  const daemon = runtimesDaemon(ctx => {
    base = hostAssembly({ ...ctx, kernel: { ...ctx.kernel, roots: world.roots } } as never);
    return base;
  });
  const host = await testHost({
    plugins: [
      {
        ...daemon,
        build(ctx) {
          kernel = {
            ...ctx.kernel,
            config: {
              ...ctx.kernel.config,
              fileState: (def, name) =>
                Object.is(def, options.invalidState)
                  ? { state: 'invalid', inEffect: true, sentences: ['Invalid edit; last good version retained'] }
                  : ctx.kernel.config.fileState(def, name),
            },
          };
          return daemon.build!({ ...ctx, kernel } as Parameters<NonNullable<typeof daemon.build>>[0]);
        },
      },
    ],
    fakes: {
      ferrets,
      logins,
      loginChanges: fakeLoginChanges(),
      loginEnvImport: fakeLoginEnvImport(),
      vault: new FakeVault(),
    },
    gate: Object.assign(new StandInAdmission(() => ownerStanding()), {
      judgeConfigWrite: () => (options.allowWrite === false ? ('hold' as const) : ('apply' as const)),
    }),
    config: {
      runtimes: options.configured === false ? {} : { custom: { harness: key, login: 'key', profile: 'plain' } },
      profiles: { plain: { contents: [...(options.profile ?? [])] } },
      'model-sets': {
        pinned: { models: ['provider/model'], default: 'provider/model' },
        gone: { models: ['missing/model'], default: 'missing/model' },
      },
    },
    ownerHome: world.person,
    executables: [...(options.noManagers ? [] : ['/fixture/bin/npm']), '/fixture/bin/claude', '/fixture/bin/codex'],
    searchPath: '/fixture/bin',
    spawn: program => {
      if (program === 'uname') return { exitCode: 0, signal: null, stdout: 'Linux\n', stderr: '' };
      spawns.push(program);
      if (installThrows) throw new Error('private package-manager error');
      if (installExit === 0) installed = true;
      return {
        exitCode: installExit,
        signal: null,
        stdout: 'do not return unreviewed package-manager output',
        stderr: '',
      };
    },
  });
  hosts.push(host);
  if (kernel === undefined || base === undefined) throw new Error('the real Runtimes daemon did not build');
  const generic = new GenericRuntimes({ kernel, ferrets, logins });
  const api = host.provided(RuntimesPort);
  const start = (patch: Partial<StartDecideInput> = {}) =>
    generic.decide({
      runtime: 'custom',
      harness: key,
      model: 'provider/model',
      ferret: 'test',
      ...patch,
    } as StartDecideInput);
  const proposal = (change: unknown) => host.request('POST', '/v1/runtimes/proposals', { body: { change } });
  const apply = (id: string) => host.request('POST', `/v1/runtimes/proposals/${id}/apply`, { body: {} });
  return {
    host,
    kernel,
    generic,
    api,
    logins,
    runtime,
    facts,
    spawns,
    start,
    proposal,
    apply,
    base,
    models: (value: HarnessRuntimeModels) => {
      models = value;
    },
    installed: (value: boolean) => {
      installed = value;
    },
    enabled: (value: boolean) => {
      enabled = value;
    },
    descriptor: (value: boolean) => {
      descriptor = value;
    },
    detectFailure: (value: boolean) => {
      detectFailure = value;
    },
    modelFailure: (value: boolean) => {
      modelFailure = value;
    },
    installExit: (value: number) => {
      installExit = value;
    },
    installThrows: (value: boolean) => {
      installThrows = value;
    },
  };
}

test('a fourth registered harness lists its real discovery separately, and key claude is never the Claude family', async () => {
  for (const key of ['fourth', 'claude']) {
    const f = await fixture({ key });
    const listed = await f.host.request('GET', '/v1/runtimes');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const row = listed
      .json<{
        runtimes: {
          name: string;
          harness: string;
          harnessDisplayName: string;
          discovery: unknown;
          fixedLayer?: unknown;
        }[];
      }>()
      .runtimes.find(row => row.name === 'custom');
    expect(row).toMatchObject({
      harness: key,
      harnessDisplayName: 'Fourth',
      discovery: {
        default: 'provider/model',
        choices: [{ id: 'provider/model', context: 123_456, efforts: ['native'] }],
      },
    });
    expect(row?.fixedLayer).toBeUndefined();
    const machine = await f.host.request('GET', '/v1/runtimes/machine');
    expect(machine.status).toBe(200);
    expect(machine.json<{ tools: unknown[] }>().tools).toContainEqual({
      harness: key,
      label: 'Fourth',
      installed: true,
      command: '/fixture/bin/fourth',
    });
    expect((await f.api.resolve(RuntimeIdSchema.parse('custom'))).ok).toBe(true);
    expect((await f.host.request('GET', '/v1/runtimes/profiles')).json()).toMatchObject({
      profiles: expect.arrayContaining([expect.objectContaining({ name: 'plain' })]),
    });
    expect(await f.start()).toEqual({ allow: true });
  }
});

test('add/remove use the existing reviewed change routes and kernel config writer, without legacy materialisation', async () => {
  const f = await fixture({ configured: false });
  const proposed = await f.proposal({
    kind: 'runtime.put',
    name: 'custom',
    credential: 'key',
    profile: 'plain',
    harness: 'fourth',
    create: true,
  });
  expect(proposed.status).toBe(200);
  const id = proposed.json<{ id: string }>().id;
  expect((await f.host.request('GET', `/v1/runtimes/proposals/${id}`)).status).toBe(200);
  expect((await f.api.list()).some(row => row.id === 'custom')).toBe(false);
  const applied = await f.apply(id);
  expect(applied.status).toBe(200);
  expect(applied.json()).toMatchObject({ outcome: 'executed', executor: 'runtime' });
  expect((await f.api.list()).some(row => row.id === 'custom')).toBe(true);
  expect((await f.apply(id)).status).toBe(409);
  expect(
    (
      await f.proposal({
        kind: 'runtime.put',
        name: 'custom',
        credential: 'key',
        profile: 'plain',
        harness: 'fourth',
        create: true,
      })
    ).status,
  ).toBe(409);
  const removed = await f.proposal({ kind: 'runtime.remove', name: 'custom' });
  expect(removed.status).toBe(200);
  expect((await f.apply(removed.json<{ id: string }>().id)).status).toBe(200);
  expect(await f.api.get(RuntimeIdSchema.parse('custom'))).toBeUndefined();
  expect(f.spawns).toEqual([]);
});

test('a held native config change remains pending and never creates a runtime or a pane', async () => {
  const f = await fixture({ allowWrite: false });
  const proposed = await f.proposal({ kind: 'runtime.remove', name: 'custom' });
  expect(proposed.status).toBe(200);
  const id = proposed.json<{ id: string }>().id;
  expect((await f.apply(id)).status).toBe(409);
  expect((await f.host.request('GET', `/v1/runtimes/proposals/${id}`)).json()).toMatchObject({ state: 'pending' });
  expect(await f.api.get(RuntimeIdSchema.parse('custom'))).toBeDefined();
});

test('unavailable registry, login, installation and malformed discovery are typed refusals', async () => {
  const f = await fixture();
  f.enabled(false);
  expect(await f.start()).toMatchObject({ allow: false, reason: expect.stringContaining('not registered') });
  f.enabled(true);
  f.descriptor(false);
  expect((await f.api.resolve(RuntimeIdSchema.parse('custom'))).ok).toBe(false);
  f.descriptor(true);
  f.installed(false);
  expect(await f.start()).toEqual({ allow: false, reason: 'Install Fourth' });
  f.installed(true);
  f.modelFailure(true);
  expect(await f.start()).toEqual({ allow: false, reason: 'Fourth could not report its installation and models' });
  f.modelFailure(false);
  f.models({
    choices: [
      { id: 'x', label: 'X' },
      { id: 'x', label: 'X again' },
    ],
  });
  expect(await f.start()).toMatchObject({ allow: false, reason: expect.stringContaining('invalid model list') });
  f.logins.setLogins([]);
  expect(await f.start()).toEqual({ allow: false, reason: 'Login key does not exist' });
  expect((await f.host.request('GET', '/v1/runtimes')).status).toBe(200);
});

test('a native default is used only on an exact discovery match; absent metadata is never invented', async () => {
  const f = await fixture();
  f.models({ choices: [{ id: 'provider/model', label: 'Model' }], default: 'removed/model' });
  expect(await f.start({ model: undefined })).toMatchObject({
    allow: false,
    reason: expect.stringContaining('Choose a model'),
  });
  const row = (await f.host.request('GET', '/v1/runtimes'))
    .json<{ runtimes: { name: string; discovery: { default?: string; choices: unknown[] } }[] }>()
    .runtimes.find(row => row.name === 'custom');
  expect(row?.discovery.default).toBeUndefined();
  expect(row?.discovery.choices).toEqual([{ id: 'provider/model', label: 'Model', available: true, efforts: [] }]);
  expect(await f.start({ model: 'provider/model' })).toEqual({ allow: true });
  expect(await f.start({ model: 'other/model' })).toMatchObject({ allow: false });
  expect(await f.start({ harness: 'claude-code' })).toMatchObject({
    allow: false,
    reason: expect.stringContaining('harness changed'),
  });
  expect(await f.start({ runtime: undefined })).toBeUndefined();
  expect(await f.start({ runtime: 'unknown' })).toBeUndefined();
});

test('settings, MCP, owned assets, history/clone and fixed-layer paths refuse before launching', async () => {
  for (const layer of [
    'settings/custom',
    'mcp/custom',
    'skills/custom',
    'instructions/custom',
    'hooks/custom',
    'profile/custom',
  ]) {
    const f = await fixture({ profile: [layer] });
    expect(await f.start()).toEqual({ allow: false, reason: 'Fourth: not supported by Ferretry yet' });
    const listed = await f.host.request('GET', '/v1/runtimes');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(f.spawns).toEqual([]);
  }
  const f = await fixture();
  expect(await f.start({ compactAt: 100_000 })).toEqual({
    allow: false,
    reason: 'Fourth: not supported by Ferretry yet',
  });
  const settings = await f.proposal({
    kind: 'component.put',
    name: 'custom',
    component: { kind: 'settings', harness: 'fourth', flags: [] },
    create: true,
  });
  expect(settings.status).toBe(409);
  const imported = await f.proposal({ kind: 'setup.import', include: ['fourth'] });
  expect(imported.status).toBe(409);
  expect((await f.proposal({ kind: 'runtime.rename', name: 'custom', to: 'renamed' })).status).toBe(409);
  expect((await f.host.request('GET', '/v1/runtimes/export')).status).toBe(409);
  await expect(f.generic.assembly(f.base).setup.reviewClone({ bundle: {} } as never)).rejects.toMatchObject({
    status: 409,
  });
});

test('profile model pins are exact, and missing model sets refuse rather than changing the choice', async () => {
  const f = await fixture({ profile: ['modelSets/pinned'] });
  expect(await f.start()).toEqual({ allow: true });
  const gone = await fixture({ profile: ['modelSets/gone'] });
  expect(await gone.start()).toMatchObject({ allow: false, reason: expect.stringContaining('chosen model') });
  const missing = await fixture({ profile: ['modelSets/missing'] });
  expect(await missing.start()).toMatchObject({ allow: false, reason: expect.stringContaining('does not exist') });
});

test('login capability, sign-in and empty discovery prevent native launch, and invalid config stays refused', async () => {
  const f = await fixture();
  f.logins.setLogins([sampleLogin('key', { store: 'environment', harnesses: ['codex'] })]);
  expect(await f.start()).toEqual({ allow: false, reason: 'Login key cannot be spent by Fourth' });
  const ready = sampleLogin('key', { store: 'environment', harnesses: ['fourth'] });
  f.logins.setLogins([{ ...ready, status: { ...ready.status, word: 'needs_sign_in' } }]);
  expect(await f.start()).toEqual({ allow: false, reason: 'Login key needs sign-in' });
  f.logins.setLogins([sampleLogin('key', { store: 'environment', harnesses: ['fourth'] })]);
  f.models({ choices: [] });
  expect(await f.start()).toEqual({ allow: false, reason: 'Fourth has no models available' });
  const invalidProfile = await fixture({ invalidState: PROFILE_ITEMS });
  expect(await invalidProfile.start()).toEqual({ allow: false, reason: 'Profile plain could not be read' });
  const invalidRuntime = await fixture({ invalidState: RUNTIME_ITEMS });
  expect(await invalidRuntime.start()).toEqual({ allow: false, reason: 'Runtime custom could not be read' });
  const invalidSet = await fixture({ profile: ['modelSets/pinned'], invalidState: MODEL_SET_ITEMS });
  expect(await invalidSet.start()).toMatchObject({
    allow: false,
    reason: expect.stringContaining('could not be read'),
  });
});

test('native runtime compatibility is checked before any login status or credential-store read', async () => {
  const f = await fixture();
  let reads = 0;
  const destinations: string[] = [];
  f.logins.get = async () => {
    reads += 1;
    throw new Error('status/store must not be read');
  };
  f.logins.list = async () => {
    reads += 1;
    throw new Error('status/store must not be read');
  };
  f.logins.launchRefusal = async (_login, destination) => {
    destinations.push(destination);
    return 'Subscription sign-ins cannot be spent by this native harness';
  };
  expect(await f.api.resolve(RuntimeIdSchema.parse('custom'))).toMatchObject({
    ok: false,
    sentence: expect.stringContaining('Subscription'),
  });
  expect(await f.start()).toEqual({
    allow: false,
    reason: 'Subscription sign-ins cannot be spent by this native harness',
  });
  expect(await f.api.resolve(RuntimeIdSchema.parse('custom'), 'opencode')).toMatchObject({
    ok: false,
    refusal: 'not_signed_in',
  });
  expect(destinations).toEqual(['fourth', 'fourth', 'opencode']);
  expect(reads).toBe(0);
});

test('a machine with no native runtime files still delegates profile proposals, export and self-copy refusal', async () => {
  const f = await fixture({ configured: false });
  expect(
    (await f.proposal({ kind: 'profile.put', name: 'other', layers: ['modelSets/pinned'], create: true })).status,
  ).toBe(200);
  const exported = await f.host.request('GET', '/v1/runtimes/export');
  expect(exported.status).toBe(200);
  const reviewed = await f.host.request('POST', '/v1/runtimes/clone/review', { body: { bundle: exported.json() } });
  expect(reviewed.status).toBe(409);
  expect(JSON.stringify(reviewed.body)).toContain('itself');
});

test('reviewing a native model-set edit preserves runtime fields and rejects stale model-set snapshots', async () => {
  const f = await fixture({ profile: ['modelSets/pinned'] });
  expect(await f.api.layers(RuntimeIdSchema.parse('custom'))).toBeDefined();
  const change = { kind: 'runtime.put', name: 'custom', credential: 'key', profile: 'plain', create: false };
  const staged = await f.proposal(change);
  expect(staged.status).toBe(200);
  f.host.setConfig('model-sets', { pinned: { models: ['provider/model', 'changed/model'], default: 'changed/model' } });
  expect((await f.apply(staged.json<{ id: string }>().id)).status).toBe(409);
  f.host.setConfig('model-sets', { pinned: { models: ['provider/model'], default: 'provider/model' } });
  const next = await f.proposal(change);
  expect((await f.apply(next.json<{ id: string }>().id)).status).toBe(200);
  expect(await f.api.changeProfileLayers({ kind: 'remove-everywhere', layer: 'mcp/missing' })).toBeDefined();
});

test('installation comes only from the registered descriptor and verifies the resulting binary', async () => {
  const f = await fixture();
  f.installed(false);
  const scan = await f.host.request('GET', '/v1/runtimes/setup/scan');
  expect(scan.status, JSON.stringify(scan.body)).toBe(200);
  expect(scan.json<{ tools: unknown[] }>().tools).toContainEqual({
    harness: 'fourth',
    label: 'Fourth',
    installed: false,
    install: { kind: 'runnable', command: 'npm install -g fixture-fourth' },
  });
  const changed = await f.host.request('POST', '/v1/runtimes/machine/tools/install', {
    body: { harnesses: ['fourth'], shown: [{ harness: 'fourth', command: 'npm install different' }] },
  });
  expect(changed.status).toBe(409);
  expect(f.spawns).toEqual([]);
  const installed = await f.host.request('POST', '/v1/runtimes/machine/tools/install', {
    body: { harnesses: ['fourth'] },
  });
  expect(installed.status).toBe(200);
  expect(installed.json()).toMatchObject({ outcomes: [{ harness: 'fourth', outcome: 'installed', output: [] }] });
  const again = await f.host.request('POST', '/v1/runtimes/machine/tools/install', { body: { harnesses: ['fourth'] } });
  expect(again.json()).toMatchObject({ outcomes: [{ harness: 'fourth', outcome: 'already-installed' }] });
  expect(f.spawns).toEqual(['/fixture/bin/npm']);
});

test('the generic port resolves the configured default and its catalog without legacy model translation', async () => {
  const f = await fixture();
  f.host.setConfig('runtimes.yaml', { defaultRuntime: 'custom' });
  expect(await f.api.default()).toBe(RuntimeIdSchema.parse('custom'));
  expect((await f.api.resolve()).ok).toBe(true);
  const api = f.generic.api({ ...f.api, listFor: async () => [] });
  const logins = (await f.logins.list()).logins;
  expect(await api.listFor(logins)).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: RuntimeIdSchema.parse('custom'), harness: 'fourth' })]),
  );
  expect(await api.listFor([])).toEqual([]);
  const source = f.generic.start({
    resolve: async () => ({ ok: true, harness: 'fourth', login: 'key' }),
    login: async () => ({ ok: true }),
  });
  expect(await source.catalog?.('custom')).toMatchObject({
    harness: 'fourth',
    choices: [{ value: 'provider/model', context: 123_456, reasoningEfforts: [{ value: 'native' }], isDefault: true }],
  });
  expect(await source.catalog?.('missing')).toBeUndefined();
  f.models({ choices: [{ id: 'provider/model', label: 'Model' }] });
  expect(await source.catalog?.('custom')).toEqual({
    harness: 'fourth',
    source: 'wrapper-inventory',
    choices: [{ value: 'provider/model', label: 'Model', reasoningEfforts: [] }],
  });
  f.installed(false);
  expect((await f.api.resolve(RuntimeIdSchema.parse('custom'))).ok).toBe(false);
});

test('an aborted or stale apply writes nothing, stays reviewable, and shares the legacy apply serialisation', async () => {
  const f = await fixture({ configured: false });
  const native = f.generic.assembly(f.base);
  const staged = await native.catalog.propose({
    kind: 'runtime.put',
    name: 'custom',
    credential: 'key',
    profile: 'plain',
    harness: 'fourth',
    create: true,
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    native.catalog.apply(staged.id, undefined, undefined, { signal: controller.signal }),
  ).rejects.toMatchObject({ status: 499 });
  expect((await native.catalog.read(staged.id)).state).toBe('pending');
  f.host.setConfig('runtimes', {
    custom: { harness: 'fourth', login: 'key', profile: 'plain', disabled: { reason: 'changed after review' } },
  });
  await expect(native.catalog.apply(staged.id, undefined)).rejects.toMatchObject({ status: 409 });
  expect((await native.catalog.read(staged.id)).state).toBe('pending');
  expect((await f.api.get(RuntimeIdSchema.parse('custom')))?.launch).toMatchObject({ available: false });
});

test('a profile edit after review conflicts atomically, and removing a native default preserves other settings', async () => {
  const f = await fixture({ configured: false });
  const staged = await f.proposal({
    kind: 'runtime.put',
    name: 'custom',
    credential: 'key',
    profile: 'plain',
    harness: 'fourth',
    create: true,
  });
  f.host.setConfig('profiles', { plain: { contents: ['modelSets/pinned'] } });
  expect((await f.apply(staged.json<{ id: string }>().id)).status).toBe(409);
  expect(await f.api.get(RuntimeIdSchema.parse('custom'))).toBeUndefined();
  const ready = await fixture();
  ready.host.setConfig('runtimes.yaml', { defaultRuntime: 'custom', browserPorts: 'random' });
  expect(await ready.api.changeProfileLayers({ kind: 'add', profile: 'plain', layer: 'mcp/custom' })).toMatchObject({
    kind: 'refused',
    sentence: 'Fourth: not supported by Ferretry yet',
  });
  expect(
    (await ready.proposal({ kind: 'profile.put', name: 'plain', layers: ['modelSets/pinned'], create: false })).status,
  ).toBe(409);
  const remove = await ready.proposal({ kind: 'runtime.remove', name: 'custom' });
  expect((await ready.apply(remove.json<{ id: string }>().id)).status).toBe(200);
  expect(ready.kernel.config.file(RUNTIMES_CONFIG as never)).toEqual({ browserPorts: 'random' });
});

test('install failure and missing install capability are typed, with no package output returned', async () => {
  const f = await fixture();
  f.installed(false);
  f.installExit(1);
  const failed = await f.host.request('POST', '/v1/runtimes/machine/tools/install', {
    body: { harnesses: ['fourth'] },
  });
  expect(failed.status).toBe(200);
  expect(failed.json()).toMatchObject({ outcomes: [{ outcome: 'failed', output: [] }] });
  f.installThrows(true);
  expect(
    (await f.host.request('POST', '/v1/runtimes/machine/tools/install', { body: { harnesses: ['fourth'] } })).status,
  ).toBe(200);
  f.detectFailure(true);
  expect((await f.host.request('GET', '/v1/runtimes/machine')).status).toBe(409);
  const unsupported = await fixture({ noInstall: true });
  unsupported.installed(false);
  const scan = await unsupported.host.request('GET', '/v1/runtimes/setup/scan');
  expect(scan.json<{ tools: unknown[] }>().tools).toContainEqual({
    harness: 'fourth',
    label: 'Fourth',
    installed: false,
    install: { kind: 'no-package-manager', reason: 'Fourth: not supported by Ferretry yet', manualCommand: 'fourth' },
  });
  expect(
    (await unsupported.host.request('POST', '/v1/runtimes/machine/tools/install', { body: { harnesses: ['fourth'] } }))
      .status,
  ).toBe(409);
  expect(unsupported.spawns).toEqual([]);
  const unavailableManager = await fixture({ noManagers: true });
  unavailableManager.installed(false);
  expect((await unavailableManager.host.request('GET', '/v1/runtimes/setup/scan')).json()).toMatchObject({
    tools: expect.arrayContaining([
      expect.objectContaining({
        harness: 'fourth',
        install: {
          kind: 'no-package-manager',
          reason: 'No supported package manager is available for Fourth',
          manualCommand: 'npm install -g fixture-fourth',
        },
      }),
    ]),
  });
  f.detectFailure(false);
  f.installThrows(false);
  f.installExit(0);
  const mixed = await f.host.request('POST', '/v1/runtimes/machine/tools/install', {
    body: { harnesses: ['fourth', 'codex'] },
  });
  expect(mixed.status).toBe(200);
  expect(mixed.json()).toMatchObject({
    outcomes: expect.arrayContaining([
      expect.objectContaining({ harness: 'fourth', outcome: 'installed' }),
      expect.objectContaining({ harness: 'codex' }),
    ]),
  });
});
