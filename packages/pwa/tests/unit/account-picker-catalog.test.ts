import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';

import {
  checkAccountPickerHealth,
  type PickerCatalogClient,
  pickerAccount,
  readAccountPickerCatalog,
  readAccountPickerHealth,
  recentProjectPaths,
} from '../../src/lib/account-picker-catalog.ts';
import { localModelsFixture } from '../support/local-models.ts';
import { sessionView } from '../support/sessions.ts';
import { credentialList, credentialStatus, credentialView, runtimeCatalog, runtimeView } from './picker-support.ts';

const runtimes = runtimeCatalog(
  runtimeView({ wrapper: 'claude-auto-a', name: 'Claude Atelier' }),
  runtimeView({ wrapper: 'codex-auto-b', name: 'Codex Forge' }),
);

const credentials = credentialList(
  credentialView('login-claude-auto-a'),
  credentialView('login-codex-auto-b', 'needs_sign_in'),
);

interface ClientFixture {
  readonly client: PickerCatalogClient;
  readonly paths: string[];
  /** The verb each call used, so a read cannot quietly become a write. */
  readonly methods: (string | undefined)[];
}

const clientFixture = (overrides: Partial<Record<string, unknown>> = {}): ClientFixture => {
  const paths: string[] = [];
  const responses: Record<string, unknown> = {
    '/v1/fleet/runtimes': runtimes,
    '/v1/fleet/credentials': credentials,
    '/v1/fleet/credentials/login-claude-auto-a/check': credentialView('login-claude-auto-a'),
    '/v1/fleet/credentials/login-codex-auto-b/check': credentialView('login-codex-auto-b'),
    ...overrides,
  };
  const methods: (string | undefined)[] = [];
  return {
    paths,
    methods,
    client: {
      // Parses through the caller's own schema, so a fixture cannot smuggle in a shape the real
      // daemon reader would have refused — or refuse one it accepts.
      request: async (path, schema, init) => {
        paths.push(path);
        methods.push(init?.method);
        const response = responses[path];
        if (response instanceof Error) throw response;
        return schema.parse(response);
      },
    },
  };
};

describe('recentProjectPaths', () => {
  it('deduplicates canonical paths, ignores blanks, and orders the newest evidence first', () => {
    const sessions: SessionView[] = [
      sessionView('a', {
        config: { cwd: '/work/same', updatedAt: '2026-08-01T00:00:00.000Z' },
        state: { lastActivityAt: '2026-08-01T00:00:00.000Z' },
      }),
      sessionView('blank', {
        config: { cwd: '   ', updatedAt: '2026-08-04T00:00:00.000Z' },
        state: { lastActivityAt: '2026-08-04T00:00:00.000Z' },
      }),
      sessionView('b', {
        config: { cwd: '/work/other', updatedAt: '2026-08-02T00:00:00.000Z' },
        state: { lastActivityAt: '2026-08-02T00:00:00.000Z' },
      }),
      sessionView('c', {
        config: { cwd: ' /work/same/ ', updatedAt: '2026-08-03T00:00:00.000Z' },
        state: { lastActivityAt: '2026-08-03T00:00:00.000Z' },
      }),
    ];

    expect(recentProjectPaths(sessions)).toEqual([
      { path: '/work/same', lastActivity: '2026-08-03T00:00:00.000Z' },
      { path: '/work/other', lastActivity: '2026-08-02T00:00:00.000Z' },
    ]);
  });

  it('uses the path as a deterministic tiebreaker', () => {
    const sessions = [
      sessionView('z', { config: { cwd: '/work/z', updatedAt: '2026-08-01T00:00:00.000Z' } }),
      sessionView('a', { config: { cwd: '/work/a', updatedAt: '2026-08-01T00:00:00.000Z' } }),
    ];

    expect(recentProjectPaths(sessions).map(row => row.path)).toEqual(['/work/a', '/work/z']);
  });
});

describe('readAccountPickerCatalog', () => {
  it('reads this machine’s runtimes from one daemon-bound client', async () => {
    const fixture = clientFixture();
    const catalog = await readAccountPickerCatalog(fixture.client);

    expect(fixture.paths).toEqual(['/v1/fleet/runtimes']);
    expect(fixture.methods).toEqual([undefined]);
    expect(catalog.accounts.map(row => row.wrapper)).toEqual(['claude-auto-a', 'codex-auto-b']);
  });

  it('keeps a positively empty roster distinct from a rejected read', async () => {
    const empty = clientFixture({ '/v1/fleet/runtimes': runtimeCatalog() });
    expect((await readAccountPickerCatalog(empty.client)).accounts).toEqual([]);

    const broken = clientFixture({ '/v1/fleet/runtimes': new Error('catalogue damaged') });
    await expect(readAccountPickerCatalog(broken.client)).rejects.toThrow('catalogue damaged');
    expect(broken.paths).toEqual(['/v1/fleet/runtimes']);
  });
});

describe('pickerAccount', () => {
  it('reads a runtime’s id, wrapper, name, harness, agent flag and login verbatim', () => {
    expect(pickerAccount(runtimeView({ wrapper: 'claude-auto-a', name: 'Claude Atelier' }))).toEqual({
      id: 'rt-claude-auto-a',
      wrapper: 'claude-auto-a',
      displayName: 'Claude Atelier',
      kind: 'claude',
      agent: true,
      credentialId: 'login-claude-auto-a',
      defaultModel: null,
      models: [],
      available: true,
      unavailableReason: null,
    });
  });

  it('offers a model set’s models and its resolved default', () => {
    const account = pickerAccount(
      runtimeView({
        wrapper: 'claude-auto-a',
        modelSet: {
          source: 'model-set',
          name: 'Claude models',
          models: [
            { id: 'opus', available: true },
            { id: 'haiku', available: false },
          ],
          declaredDefault: 'opus',
          default: 'opus',
        },
      }),
    );
    expect(account.defaultModel).toBe('opus');
    expect(account.models).toEqual([
      { id: 'opus', available: true },
      { id: 'haiku', available: false },
    ]);
  });

  it('leaves the default blank when the login can use none of a set’s models', () => {
    const account = pickerAccount(
      runtimeView({
        wrapper: 'claude-auto-a',
        modelSet: {
          source: 'model-set',
          name: 'Claude models',
          models: [{ id: 'opus', available: false }],
          declaredDefault: 'opus',
        },
      }),
    );
    expect(account.defaultModel).toBeNull();
  });

  it("offers exactly the login's catalog when it reads one, with each model's name, tier and efforts", () => {
    const account = pickerAccount(
      runtimeView({
        wrapper: 'claude-auto-a',
        models: {
          catalog: { id: 'zai', label: 'GLM / Z.ai', origin: 'built-in', customIds: false, docs: 'https://docs.z.ai' },
          choices: [
            {
              id: 'glm-5.3',
              label: 'GLM-5.3',
              tier: 'best',
              context: 1_000_000,
              efforts: ['low'],
              defaultEffort: 'low',
              available: true,
            },
            { id: 'glm-x', label: 'GLM X', efforts: [], available: false },
          ],
          default: 'glm-5.3',
        },
      }),
    );
    expect(account.defaultModel).toBe('glm-5.3');
    expect(account.modelCatalog).toEqual({ id: 'zai', label: 'GLM / Z.ai', customIds: false });
    expect(account.models).toEqual([
      {
        id: 'glm-5.3',
        available: true,
        label: 'GLM-5.3',
        tier: 'best',
        context: 1_000_000,
        efforts: ['low'],
        defaultEffort: 'low',
      },
      { id: 'glm-x', available: false, label: 'GLM X', efforts: [] },
    ]);
    const unset = pickerAccount(
      runtimeView({
        wrapper: 'claude-auto-a',
        models: {
          catalog: { id: 'zai', label: 'GLM / Z.ai', origin: 'file', customIds: true, docs: 'https://docs.z.ai' },
          choices: [],
        },
      }),
    );
    expect(unset.defaultModel).toBeNull();
  });

  it('carries the machine’s own reason a runtime cannot launch', () => {
    const account = pickerAccount(
      runtimeView({ wrapper: 'claude-auto-a', launch: { available: false, reason: 'Sign in to launch' } }),
    );
    expect(account).toMatchObject({ available: false, unavailableReason: 'Sign in to launch' });
  });

  it('carries the models Ollama has installed, and what the daemon last read from it', () => {
    const local = localModelsFixture('found');
    const account = pickerAccount(
      runtimeView({
        wrapper: 'codex-auto-ollama',
        harness: 'codex',
        models: {
          catalog: {
            id: 'ollama',
            label: 'Ollama',
            origin: 'built-in',
            customIds: true,
            docs: 'https://docs.ollama.com',
            detect: 'ollama',
          },
          choices: [
            { id: 'gpt-oss:20b', label: 'gpt-oss:20b', tier: 'best', efforts: [], available: true, local: true },
            { id: 'qwen3-coder:30b', label: 'qwen3-coder:30b', efforts: [], available: true, local: true },
            { id: 'llama3', label: 'llama3', efforts: [], available: true },
          ],
          local,
        },
      }),
    );
    expect(account.models.map(model => model.local)).toEqual([true, true, undefined]);
    expect(account.modelCatalog).toEqual({
      id: 'ollama',
      label: 'Ollama',
      customIds: true,
      detect: 'ollama',
      local,
    });
  });
});

describe('readAccountPickerHealth', () => {
  it('reads every login’s status with a plain GET, keyed by credential id', async () => {
    const fixture = clientFixture();
    const result = await readAccountPickerHealth(fixture.client);

    // A GET, and only a GET: the daemon calls no provider to answer it, so the store may hydrate it on
    // mount. The reader that CHECKS is a different function on a different verb, below.
    expect(fixture.paths).toEqual(['/v1/fleet/credentials']);
    expect(fixture.methods).toEqual([undefined]);
    expect(result.error).toBeNull();
    expect(result.health.get('login-claude-auto-a')).toMatchObject({
      credentialId: 'login-claude-auto-a',
      word: 'ready',
    });
    expect(result.health.get('login-codex-auto-b')?.word).toBe('needs_sign_in');
  });

  it('refuses a status word this build does not have', async () => {
    const fixture = clientFixture({
      '/v1/fleet/credentials': {
        ...credentials,
        credentials: [{ ...credentialView('login-claude-auto-a'), status: { ...credentialStatus(), word: 'fine' } }],
      },
    });
    await expect(readAccountPickerHealth(fixture.client)).rejects.toThrow();
  });
});

describe('checkAccountPickerHealth', () => {
  it('reads the list, then POSTs one check per login that offers one', async () => {
    const fixture = clientFixture();
    const result = await checkAccountPickerHealth(fixture.client);

    expect(fixture.paths).toEqual([
      '/v1/fleet/credentials',
      '/v1/fleet/credentials/login-claude-auto-a/check',
      '/v1/fleet/credentials/login-codex-auto-b/check',
    ]);
    expect(fixture.methods).toEqual([undefined, 'POST', 'POST']);
    expect(result.error).toBeNull();
    // The check's own answer replaces what the list read.
    expect(result.health.get('login-codex-auto-b')?.word).toBe('ready');
  });

  it('skips a login the machine offers no check for', async () => {
    const fixture = clientFixture({
      '/v1/fleet/credentials': credentialList(
        credentialView('login-claude-auto-a'),
        credentialView('login-env', 'ready', { checkNow: { available: false, reason: 'From the environment' } }),
      ),
    });
    const result = await checkAccountPickerHealth(fixture.client);

    expect(fixture.paths).toEqual(['/v1/fleet/credentials', '/v1/fleet/credentials/login-claude-auto-a/check']);
    expect(result.health.get('login-env')?.word).toBe('ready');
  });

  it('keeps the listed status for a login whose check failed, and says why beside the rows', async () => {
    const fixture = clientFixture({
      '/v1/fleet/credentials/login-codex-auto-b/check': new Error('this machine refused the check'),
    });
    const result = await checkAccountPickerHealth(fixture.client);

    expect(result.health.get('login-claude-auto-a')?.word).toBe('ready');
    expect(result.health.get('login-codex-auto-b')?.word).toBe('needs_sign_in');
    expect(result.error).toBe('this machine refused the check');
  });

  it('names a failure that is not an Error in words', async () => {
    const fixture = clientFixture();
    const original = fixture.client.request;
    const client: PickerCatalogClient = {
      request: async (path, schema, init) => {
        if (path.endsWith('/check')) throw 'refused';
        return await original(path, schema, init);
      },
    };
    const result = await checkAccountPickerHealth(client);

    expect(result.error).toBe('refused; refused');
  });

  it('fails as a whole when the list itself cannot be read', async () => {
    const fixture = clientFixture({ '/v1/fleet/credentials': new Error('machine asleep') });
    await expect(checkAccountPickerHealth(fixture.client)).rejects.toThrow('machine asleep');
  });
});
