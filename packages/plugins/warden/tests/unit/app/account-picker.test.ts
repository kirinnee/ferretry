import { describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import { KERNEL_REFUSALS } from '@ferretry/kernel/contract';
import { RuntimeCatalogSchema, type RuntimeView } from '@ferretry/plugin-runtimes/contract';
import { readAccountPickerCatalog } from '../../../app/lib/account-picker.ts';

/** One runtime as `GET /v1/runtimes` publishes it, to the wire schema so a contract change fails here. */
const runtime = (wrapper: string, overrides: Partial<RuntimeView> = {}): RuntimeView => ({
  id: `rt-${wrapper}`,
  name: wrapper,
  wrapper,
  harness: 'claude-code',
  credential: { id: `login-${wrapper}`, store: 'host', status: 'ready' },
  profile: 'Default',
  agent: true,
  stack: {
    harness: 'claude-code',
    available: { available: true },
    applied: [],
    skipped: [],
    conflicts: [],
    partial: [],
  },
  modelSet: { source: 'harness-default' },
  launch: { available: true },
  sameAs: [],
  ...overrides,
});

const clientAnswering = (answer: () => unknown) => ({
  call: async <Answer = unknown>(): Promise<Answer> => answer() as Answer,
});

const read = async (...runtimes: readonly RuntimeView[]) => {
  const answer = await readAccountPickerCatalog(
    clientAnswering(() => RuntimeCatalogSchema.parse({ format: 'present', runtimes })),
  );
  if (answer === 'off') throw new Error('expected a catalog');
  return answer.accounts;
};

describe('the account picker catalog', () => {
  it('should offer no models and no default for a harness default', async () => {
    const [account] = await read(runtime('claude-auto-a'));
    expect(account).toMatchObject({ wrapper: 'claude-auto-a', defaultModel: null, models: [], available: true });
    expect(account?.unavailableReason).toBeNull();
  });

  it('should offer a model set’s models and its resolved default', async () => {
    const [account] = await read(
      runtime('claude-auto-a', {
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
    expect(account?.defaultModel).toBe('opus');
    expect(account?.models.map(model => model.id)).toEqual(['opus', 'haiku']);
  });

  it('should leave the default blank when none of a set’s models is usable', async () => {
    const [account] = await read(
      runtime('claude-auto-a', {
        modelSet: {
          source: 'model-set',
          name: 'Claude models',
          models: [{ id: 'opus', available: false }],
          declaredDefault: 'opus',
        },
      }),
    );
    expect(account?.defaultModel).toBeNull();
  });

  it('should offer exactly the login’s catalog, and the reason a runtime cannot launch', async () => {
    const [account] = await read(
      runtime('claude-auto-a', {
        launch: { available: false, reason: 'Sign in to launch' },
        models: {
          catalog: { id: 'zai', label: 'GLM / Z.ai', origin: 'built-in', customIds: true, docs: 'https://docs.z.ai' },
          choices: [
            {
              id: 'glm-5.3',
              label: 'GLM-5.3',
              tier: 'best',
              context: 1_000_000,
              efforts: ['low'],
              defaultEffort: 'low',
              fast: true,
              available: true,
            },
            { id: 'glm-x', label: 'GLM X', efforts: [], available: false },
          ],
          default: 'glm-5.3',
        },
      }),
    );
    expect(account?.defaultModel).toBe('glm-5.3');
    expect(account?.modelCatalog).toEqual({ id: 'zai', label: 'GLM / Z.ai', customIds: true });
    expect(account?.models[0]).toMatchObject({ tier: 'best', context: 1_000_000, defaultEffort: 'low', fast: true });
    expect(account?.models[1]).toEqual({ id: 'glm-x', available: false, label: 'GLM X', efforts: [] });
    expect(account).toMatchObject({ available: false, unavailableReason: 'Sign in to launch' });
  });

  it('should answer off when Runtimes is paused on that machine, and rethrow any other failure', async () => {
    const paused = new DaemonCallError(503, KERNEL_REFUSALS.pluginPaused.code, 'paused');
    expect(
      await readAccountPickerCatalog(
        clientAnswering(() => {
          throw paused;
        }),
      ),
    ).toBe('off');
    await expect(
      readAccountPickerCatalog(
        clientAnswering(() => {
          throw new Error('catalogue damaged');
        }),
      ),
    ).rejects.toThrow('catalogue damaged');
  });
});
