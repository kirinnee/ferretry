import { afterEach, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import type { ChildEnvironment, ChildEnvironmentOpener, FerretId, Log } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { HookEngine } from '@ferretry/kernel/host';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import {
  ChildEnvironmentPort,
  type MaskSource,
  RedactionPort,
  RedactionSources,
  SecretUseRequestSchema,
  VaultPort,
} from '../../../../contract/index.ts';
import vault from '../../../../daemon/index.ts';
import { DeclaredMaskSource, MaskSourceUnavailableError } from '../../../../daemon/lib/secrets/mask-source.ts';
import { combinedValues, SecretRedactor } from '../../../../daemon/lib/secrets/redaction.ts';
import { VaultRedaction } from '../../../../daemon/lib/secrets/read-scope.ts';

const LOGIN = 'saved-login-test-value';
const SEED = 'staged-two-factor-test-seed';
const LABEL = 'login:test:password';
const FERRET = 'test-ferret' as FerretId;
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

async function setup(declared = true, metadata = true) {
  let entries = new Map([
    [LABEL, LOGIN],
    ['2fa:test', SEED],
  ]);
  let throws = false;
  const source: MaskSource = {
    values: async () => {
      if (throws) throw new Error('source failed');
      return entries;
    },
  };
  const hooks = { 'redaction.sources:source': source };
  const accounts = implementDaemon(
    definePlugin({
      id: 'accounts',
      title: 'Accounts fixture',
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: RedactionSources, key: 'source' }] },
    }),
    { build: () => ({ hooks }) },
  );
  let opener: ChildEnvironmentOpener;
  let output = `${LOGIN} ${SEED}`;
  const environments: Readonly<Record<string, string>>[] = [];
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  // Exercise the real Vault composition, substituting only the kernel's process boundary.
  const instrumented = implementDaemon(vault.manifest, {
    build: ctx => {
      if (vault.build === undefined) throw new Error('Vault must have a daemon half');
      return vault.build({
        ...ctx,
        hooks: {
          ...ctx.hooks,
          // The approved kernel declaration seam; source presence is independent of its handler.
          ...(metadata ? { declaredProvider: () => (declared ? 'accounts' : undefined) } : {}),
        } as typeof ctx.hooks,
        kernel: {
          ...ctx.kernel,
          spawn: {
            ...ctx.kernel.spawn,
            start: (_program, _args, options) => {
              environments.push(opener.open(options?.env as ChildEnvironment) ?? {});
              return {
                pid: 1,
                stdout: stream(output),
                stderr: stream(output),
                write: () => {},
                kill: () => {},
                exited: Promise.resolve(0),
              };
            },
          },
        },
      });
    },
  });
  const host = await testHost({
    plugins: declared ? [instrumented, accounts] : [instrumented],
    fakes: { asks: new FakeAsks(), gate: new FakeGate() },
  });
  hosts.push(host);
  opener = host.provided(ChildEnvironmentPort);
  await host.runJob('inputs-restore');
  const api = host.provided(VaultPort);
  const redaction = host.provided(RedactionPort);
  const run = async () => await api.run(SecretUseRequestSchema.parse({ command: ['fixture'], cwd: '/tmp' }));
  return {
    host,
    api,
    redaction,
    run,
    environments,
    fail: () => {
      throws = true;
    },
    remove: () => {
      Reflect.deleteProperty(hooks, 'redaction.sources:source');
    },
    replace: (values: Map<string, string>) => {
      throws = false;
      entries = values;
      hooks['redaction.sources:source'] = source;
    },
    output: (text: string) => {
      output = text;
    },
  };
}

test('S10 I126 provided login and staged 2FA values are masked in Redaction.read and run output', async () => {
  const { redaction, run, environments } = await setup();
  expect(await redaction.read(scope => scope.text(`${LOGIN} ${SEED}`))).toBe(
    '[redacted:login:test:password] [redacted:2fa:test]',
  );
  expect(await redaction.read(scope => scope.lines([LOGIN, SEED]))).toEqual([
    '*'.repeat(LOGIN.length),
    '*'.repeat(SEED.length),
  ]);
  const result = await run();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected a successful use');
  expect(result.value.stdout).toBe('[redacted:login:test:password] [redacted:2fa:test]');
  expect(result.value.stderr).toBe(result.value.stdout);
  expect(environments).toEqual([{}]);
});

for (const state of ['throwing', 'removed'] as const) {
  test(`S20 I126 a ${state} declared provider refuses reads and runs after an earlier success, and keeps nothing`, async () => {
    const fixture = await setup();
    expect(await fixture.redaction.read(scope => scope.text(LOGIN))).toBe('[redacted:login:test:password]');
    expect(await fixture.run()).toMatchObject({ ok: true });
    const spawned = fixture.environments.length;
    if (state === 'throwing') fixture.fail();
    else fixture.remove();
    let called = false;
    await expect(
      fixture.redaction.read(scope => {
        called = true;
        return scope.text(LOGIN);
      }),
    ).rejects.toThrow('mask source unavailable');
    expect(called).toBe(false);
    expect(await fixture.run()).toEqual({ ok: false, error: 'masks_unavailable' });
    expect(fixture.environments.length).toBe(spawned);
    fixture.replace(new Map([['login:new:password', 'replacement-value']]));
    expect(await fixture.redaction.read(scope => scope.text(`${LOGIN} replacement-value`))).toBe(
      `${LOGIN} [redacted:login:new:password]`,
    );
    fixture.replace(new Map());
    expect(await fixture.redaction.read(scope => scope.text('replacement-value'))).toBe('replacement-value');
  });
}

test('S20 I126 nothing is cached between reads: every read and run asks the provider again', async () => {
  const fixture = await setup();
  expect(await fixture.redaction.read(scope => scope.text(LOGIN))).toBe('[redacted:login:test:password]');
  fixture.replace(new Map([['login:other:password', 'other-value']]));
  expect(await fixture.redaction.read(scope => scope.text(`${LOGIN} other-value`))).toBe(
    `${LOGIN} [redacted:login:other:password]`,
  );
  fixture.output(`${LOGIN} other-value`);
  const result = await fixture.run();
  expect(result.ok && result.value.stdout).toBe(`${LOGIN} [redacted:login:other:password]`);
});

test('S19 I126 a declared unavailable provider refuses secrets/use with a typed refusal and never spawns', async () => {
  const fixture = await setup();
  fixture.fail();
  expect(await fixture.run()).toEqual({ ok: false, error: 'masks_unavailable' });
  expect(fixture.environments).toEqual([]);
  const response = await fixture.host.request('POST', '/v1/secrets/use', {
    body: { command: ['fixture'], cwd: '/tmp' },
  });
  expect(response.status).toBe(503);
  expect(response.body).toContain('masks_unavailable');
  expect(response.body).not.toContain(LOGIN);
  expect(fixture.environments).toEqual([]);
  fixture.replace(new Map([[LABEL, LOGIN]]));
  expect(await fixture.run()).toMatchObject({ ok: true });
  expect(fixture.environments.length).toBe(1);
});

test('S6 S7 S10 I2 I126 mask values never become names, usable secrets, child environments or route answers', async () => {
  const { host, api, redaction, environments } = await setup();
  await redaction.read(scope => scope.text(LOGIN));
  expect(await api.names()).toEqual([]);
  expect(await api.has(LABEL)).toBe(false);
  const env = await api.childEnvironment(FERRET, { TOKEN: '${secret:SOURCE}' });
  expect(env).toEqual({ ok: false, error: { unknown: ['SOURCE'] } });
  const run = await api.run(SecretUseRequestSchema.parse({ command: ['fixture'], cwd: '/tmp', secrets: ['SOURCE'] }));
  expect(run).toEqual({ ok: false, error: 'unknown_secret' });
  expect(environments).toEqual([]);
  const requests = [
    ['GET', '/v1/secrets', undefined],
    ['POST', '/v1/secrets/use', { command: ['fixture'], cwd: '/tmp' }],
    ['POST', '/v1/secrets', { name: 'LOCAL', value: 'local-fixture-value' }],
    ['DELETE', '/v1/secrets/LOCAL', undefined],
    ['POST', '/v1/secrets/imports', undefined],
    ['POST', '/v1/secrets/imports/not-an-import', { bundle: {} }],
    ['POST', '/v1/secrets/exports/not-an-import', {}],
    ['GET', '/v1/secrets/source', undefined],
    ['GET', '/v1/input-requests', undefined],
    ['GET', `/v1/ferrets/${FERRET}/input-requests`, undefined],
    ['GET', `/v1/ferrets/${FERRET}/input-quarantines`, undefined],
    ['GET', `/v1/ferrets/${FERRET}/input-requests/missing/shot`, undefined],
    ['POST', `/v1/ferrets/${FERRET}/input-requests/missing/deliver`, {}],
    ['POST', `/v1/ferrets/${FERRET}/input-requests/missing/cancel`, {}],
    ['POST', `/v1/ferrets/${FERRET}/input-quarantines/missing/end`, {}],
  ] as const;
  for (const [method, path, body] of requests) {
    const response = await host.request(method, path, { body });
    for (const value of [LOGIN, SEED]) expect(response.body).not.toContain(value);
  }
  expect(environments).toEqual([{}]);
});

test('S18 S20 mask sources use the vault longest-first policy, skipping empty values', async () => {
  const fixture = await setup();
  fixture.replace(
    new Map([
      ['login:short:password', 'part'],
      ['login:test:password', 'part-and-rest'],
      ['2fa:test', ''],
    ]),
  );
  fixture.output('part-and-rest part');
  expect(await fixture.redaction.read(scope => scope.text('part-and-rest part'))).toBe(
    '[redacted:login:test:password] [redacted:login:short:password]',
  );
  const result = await fixture.run();
  expect(result.ok && result.value.stdout).toBe('[redacted:login:test:password] [redacted:login:short:password]');
});

test('S10 I126 an initial provider failure refuses the read without exposing its error', async () => {
  const fixture = await setup();
  fixture.fail();
  let called = false;
  await expect(
    fixture.redaction.read(() => {
      called = true;
    }),
  ).rejects.toThrow('mask source unavailable');
  expect(called).toBe(false);
});

for (const state of ['failed', 'skeleton'] as const) {
  test(`S19 I126 a declared ${state} Accounts provider refuses the first read`, async () => {
    const offerer = definePlugin({
      id: 'vault',
      title: 'Vault fixture',
      version: '1.0.0',
      api: 5,
      core: true,
      kinds: [],
      hooks: { offers: [{ hook: RedactionSources }] },
    });
    const accounts = definePlugin({
      id: 'accounts',
      title: 'Accounts fixture',
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: RedactionSources, key: 'source' }] },
    });
    const log: Log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log };
    const { engine, refusals } = HookEngine.plan([offerer, accounts], log, () => ({
      promise: new Promise<'timeout'>(() => {}),
      cancel: () => {},
    }));
    expect(refusals).toEqual([]);
    if (state === 'failed') engine.markFailed('accounts');
    const accountMasks = new DeclaredMaskSource(() => engine.invokerFor('vault').provider(RedactionSources, 'source'));
    let called = false;
    await expect(
      new SecretRedactor(accountMasks).batch(scrub => {
        called = true;
        return scrub.text(LOGIN);
      }),
    ).rejects.toThrow('mask source unavailable');
    expect(called).toBe(false);
  });
}

test('S10 I126 only an undeclared provider masks nothing and does not affect the vault', async () => {
  const fixture = await setup(false);
  expect(await fixture.redaction.read(scope => scope.text('ordinary text'))).toBe('ordinary text');
  const source = combinedValues(
    { values: async () => new Map([['KEY', 'vault-fixture-value']]) },
    new DeclaredMaskSource(() => 'absent'),
  );
  expect(await new VaultRedaction(source).read(scope => scope.text('vault-fixture-value'))).toBe('[redacted:KEY]');
});

test('S19 I126 a declared provider missing its handler refuses a composed read before the first snapshot', async () => {
  const fixture = await setup();
  fixture.remove();
  let called = false;
  await expect(
    fixture.redaction.read(() => {
      called = true;
    }),
  ).rejects.toThrow('mask source unavailable');
  expect(called).toBe(false);
});

test('S19 I126 missing declaration metadata refuses a composed read', async () => {
  const fixture = await setup(true, false);
  await expect(fixture.redaction.read(scope => scope.text(LOGIN))).rejects.toThrow('mask source unavailable');
});

test('S20 I126 absence masks nothing, and an unavailable declared source refuses every time with no memory of success', async () => {
  let provider: MaskSource | 'unavailable' | 'absent' = 'absent';
  const source = new DeclaredMaskSource(() => provider);
  expect(await source.values()).toEqual(new Map());
  provider = 'unavailable';
  await expect(source.values()).rejects.toThrow('mask source unavailable');
  provider = { values: async () => new Map() };
  expect(await source.values()).toEqual(new Map());
  provider = 'unavailable';
  await expect(source.values()).rejects.toThrow('mask source unavailable');
});

test('S20 I126 a provider that throws refuses without exposing its error, even after a success', async () => {
  let throws = false;
  const source = new DeclaredMaskSource(() => ({
    values: async () => {
      if (throws) throw new Error(`failed opening ${LOGIN}`);
      return new Map([[LABEL, LOGIN]]);
    },
  }));
  expect(await source.values()).toEqual(new Map([[LABEL, LOGIN]]));
  throws = true;
  const error = await source.values().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MaskSourceUnavailableError);
  expect(String((error as Error).message)).not.toContain(LOGIN);
  const thrown = new DeclaredMaskSource(() => {
    throw new Error(LOGIN);
  });
  await expect(thrown.values()).rejects.toThrow('mask source unavailable');
});

test('S20 I126 a returned snapshot is a copy, and the next read opens the provider fresh', async () => {
  const entries = new Map([[LABEL, LOGIN]]);
  let provider: MaskSource | 'unavailable' = { values: async () => entries };
  const source = new DeclaredMaskSource(() => provider);
  const read = await source.values();
  entries.clear();
  (read as Map<string, string>).set('login:mutated:password', 'mutated');
  expect(await source.values()).toEqual(new Map());
  provider = 'unavailable';
  await expect(new SecretRedactor(source).redact(LOGIN)).rejects.toThrow('mask source unavailable');
});

test('S10 I126 contributed masks cover truncated child output prefixes with the same policy', async () => {
  const accountMasks = new DeclaredMaskSource(() => ({ values: async () => new Map([[LABEL, LOGIN]]) }));
  const redactor = new SecretRedactor(combinedValues(accountMasks));
  expect(await redactor.batch(scrub => scrub.text(`before ${LOGIN.slice(0, 7)}\uFFFD`, true))).toBe(
    'before [redacted:login:test:password]',
  );
});

test('S19 vault failures still refuse reads even with Accounts masks available', async () => {
  const accountMasks = new DeclaredMaskSource(() => ({ values: async () => new Map([[LABEL, LOGIN]]) }));
  const source = combinedValues(
    {
      values: async () => {
        throw new Error('vault unavailable');
      },
    },
    accountMasks,
  );
  await expect(new VaultRedaction(source).read(scope => scope.text(LOGIN))).rejects.toThrow('vault unavailable');
});
