import { describe, expect, it } from 'bun:test';
import {
  checkAccountPickerHealth,
  pickerAccount,
  readAccountPickerCatalog,
  readAccountPickerHealth,
} from '../../../app/lib/account-picker-catalog.ts';
import type { RuntimesClient } from '../../../app/lib/client.ts';
import { localModelsFixture } from './support/local-models.ts';
import { loginList, loginStatus, loginView, runtimeCatalog, runtimeView } from './support/picker.ts';

const runtimes = runtimeCatalog(
  runtimeView({ wrapper: 'claude-auto-a', name: 'Claude Atelier' }),
  runtimeView({ wrapper: 'codex-auto-b', name: 'Codex Forge' }),
);

const logins = loginList(loginView('login-claude-auto-a'), loginView('login-codex-auto-b', 'needs_sign_in'));

interface ClientFixture {
  readonly client: RuntimesClient;
  /** Every route key called, so a read cannot quietly become a write. */
  readonly routes: string[];
}

const clientFixture = (overrides: Partial<Record<string, unknown>> = {}): ClientFixture => {
  const routes: string[] = [];
  const responses: Record<string, unknown> = {
    'GET /v1/runtimes': runtimes,
    'GET /v1/logins': logins,
    'POST /v1/logins/login-claude-auto-a/check': loginView('login-claude-auto-a'),
    'POST /v1/logins/login-codex-auto-b/check': loginView('login-codex-auto-b'),
    ...overrides,
  };
  return {
    routes,
    client: {
      call: async <Answer = unknown>(
        route: string,
        init?: { readonly params?: Readonly<Record<string, string>> },
      ): Promise<Answer> => {
        const concrete = route.replace(/:(\w+)/gu, (_, name: string) => init?.params?.[name] ?? `:${name}`);
        routes.push(concrete);
        const response = responses[concrete];
        if (response instanceof Error) throw response;
        if (response === undefined) throw new Error(`no route ${concrete}`);
        return response as Answer;
      },
    },
  };
};

describe('readAccountPickerCatalog', () => {
  it('reads this machine’s runtimes from one daemon-bound client', async () => {
    const fixture = clientFixture();
    const catalog = await readAccountPickerCatalog(fixture.client);

    expect(fixture.routes).toEqual(['GET /v1/runtimes']);
    expect(catalog.accounts.map(row => row.wrapper)).toEqual(['claude-auto-a', 'codex-auto-b']);
  });

  it('keeps a positively empty roster distinct from a rejected read', async () => {
    const empty = clientFixture({ 'GET /v1/runtimes': runtimeCatalog() });
    expect((await readAccountPickerCatalog(empty.client)).accounts).toEqual([]);

    const broken = clientFixture({ 'GET /v1/runtimes': new Error('catalogue damaged') });
    await expect(readAccountPickerCatalog(broken.client)).rejects.toThrow('catalogue damaged');
    expect(broken.routes).toEqual(['GET /v1/runtimes']);
  });
});

describe('pickerAccount', () => {
  it('reads a runtime’s id, wrapper, name, harness, agent flag and login verbatim', () => {
    expect(pickerAccount(runtimeView({ wrapper: 'claude-auto-a', name: 'Claude Atelier' }))).toEqual({
      id: 'rt-claude-auto-a',
      wrapper: 'claude-auto-a',
      displayName: 'Claude Atelier',
      kind: 'claude-code',
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
    const fastModels = pickerAccount(
      runtimeView({
        wrapper: 'claude-auto-a',
        models: {
          catalog: {
            id: 'anthropic',
            label: 'Anthropic',
            origin: 'built-in',
            customIds: false,
            docs: 'https://x.test',
          },
          choices: [
            { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: [], fast: true, available: true },
            { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: [], fast: false, available: true },
          ],
        },
      }),
    );
    expect(fastModels.models.map(model => model.fast)).toEqual([true, false]);
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
  it('reads every login’s status with a plain GET, keyed by login id', async () => {
    const fixture = clientFixture();
    const result = await readAccountPickerHealth(fixture.client);

    // A GET, and only a GET: the daemon calls no provider to answer it, so the store may hydrate it on mount.
    expect(fixture.routes).toEqual(['GET /v1/logins']);
    expect(result.error).toBeNull();
    expect(result.health.get('login-claude-auto-a')).toMatchObject({
      credentialId: 'login-claude-auto-a',
      word: 'ready',
    });
    expect(result.health.get('login-codex-auto-b')?.word).toBe('needs_sign_in');
  });

  it('refuses a status word this build does not have', async () => {
    const fixture = clientFixture({
      'GET /v1/logins': {
        ...logins,
        logins: [{ ...loginView('login-claude-auto-a'), status: { ...loginStatus(), word: 'fine' } }],
      },
    });
    await expect(readAccountPickerHealth(fixture.client)).rejects.toThrow();
  });
});

describe('checkAccountPickerHealth', () => {
  it('reads the list, then POSTs one check per login that offers one', async () => {
    const fixture = clientFixture();
    const result = await checkAccountPickerHealth(fixture.client);

    expect(fixture.routes).toEqual([
      'GET /v1/logins',
      'POST /v1/logins/login-claude-auto-a/check',
      'POST /v1/logins/login-codex-auto-b/check',
    ]);
    expect(result.error).toBeNull();
    // The check's own answer replaces what the list read.
    expect(result.health.get('login-codex-auto-b')?.word).toBe('ready');
  });

  it('skips a login the machine offers no check for', async () => {
    const fixture = clientFixture({
      'GET /v1/logins': loginList(
        loginView('login-claude-auto-a'),
        loginView('login-env', 'ready', { checkNow: { available: false, reason: 'From the environment' } }),
      ),
    });
    const result = await checkAccountPickerHealth(fixture.client);

    expect(fixture.routes).toEqual(['GET /v1/logins', 'POST /v1/logins/login-claude-auto-a/check']);
    expect(result.health.get('login-env')?.word).toBe('ready');
  });

  it('keeps the listed status for a login whose check failed, and says why beside the rows', async () => {
    const fixture = clientFixture({
      'POST /v1/logins/login-codex-auto-b/check': new Error('this machine refused the check'),
    });
    const result = await checkAccountPickerHealth(fixture.client);

    expect(result.health.get('login-claude-auto-a')?.word).toBe('ready');
    expect(result.health.get('login-codex-auto-b')?.word).toBe('needs_sign_in');
    expect(result.error).toBe('this machine refused the check');
  });

  it('names a failure that is not an Error in words', async () => {
    const fixture = clientFixture();
    const original = fixture.client.call;
    const client: RuntimesClient = {
      call: async <Answer = unknown>(route: string, init?: Parameters<typeof original>[1]): Promise<Answer> => {
        if (route.endsWith('/check')) throw 'refused';
        return await original<Answer>(route, init);
      },
    };
    const result = await checkAccountPickerHealth(client);

    expect(result.error).toBe('refused; refused');
  });

  it('fails as a whole when the list itself cannot be read', async () => {
    const fixture = clientFixture({ 'GET /v1/logins': new Error('machine asleep') });
    await expect(checkAccountPickerHealth(fixture.client)).rejects.toThrow('machine asleep');
  });
});
