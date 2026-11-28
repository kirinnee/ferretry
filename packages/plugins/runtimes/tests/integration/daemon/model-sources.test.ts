import { describe, expect, test } from 'bun:test';
import type { LoginsApi } from '@ferretry/plugin-logins/contract';
import { loginsLaunchStores, loginsModelCatalogs } from '../../../daemon/adapters/model-sources.ts';
import { REAL_KITS, REAL_SIGN_IN } from '../../support/real-kits.ts';

type Sources = Awaited<ReturnType<LoginsApi['modelSources']>>;

const view = (parts: Partial<Sources> = {}): Sources => ({ catalogs: {}, presets: [], ...parts }) as Sources;

describe('the model catalogs Runtimes reads from Logins (the real adapter)', () => {
  test('hands the catalogs back as they are and each preset as the variable NAMES its halves take', async () => {
    const said: string[] = [];
    const read = loginsModelCatalogs(
      {
        modelSources: async () =>
          view({
            catalogs: { zai: { id: 'zai', origin: 'built-in' } as never },
            presets: [
              { id: 'zai-glm', catalog: 'zai', variables: { claude: ['ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL'] } },
              { id: 'plain', variables: {} },
            ],
          }),
      },
      () => REAL_KITS,
      sentence => void said.push(sentence),
    );

    const sources = await read();

    expect(Object.keys(sources.catalogs)).toEqual(['zai']);
    expect(sources.signIn).toEqual(REAL_SIGN_IN);
    expect(sources.presets).toEqual([
      {
        id: 'zai-glm',
        catalog: 'zai',
        halves: { claude: { env: { ANTHROPIC_MODEL: true, ANTHROPIC_BASE_URL: true } } },
      },
      { id: 'plain', halves: {} },
    ]);
    expect('local' in sources).toBe(false);
    expect(said).toEqual([]);
  });

  test('carries what the last read of a local server found', async () => {
    const local = { ollama: { models: [] } } as unknown as NonNullable<Sources['local']>;
    const read = loginsModelCatalogs(
      { modelSources: async () => view({ local }) },
      () => REAL_KITS,
      () => {},
    );

    expect((await read()).local).toBe(local);
  });

  test('says once per failure that runtimes show their model set only, and throws nothing into a catalogue read', async () => {
    const said: string[] = [];
    const read = loginsModelCatalogs(
      {
        modelSources: async () => {
          throw new Error('logins is not answering');
        },
      },
      () => REAL_KITS,
      sentence => void said.push(sentence),
    );

    expect(await read()).toEqual({ catalogs: {}, presets: [], signIn: REAL_SIGN_IN });
    expect(await read()).toEqual({ catalogs: {}, presets: [], signIn: REAL_SIGN_IN });
    expect(said).toEqual([
      'Runtimes could not read the model catalogs from Logins, so runtimes show their model set only.',
      'Runtimes could not read the model catalogs from Logins, so runtimes show their model set only.',
    ]);
  });
});

describe('where Logins keeps each login, read for a publish (the real adapter)', () => {
  test('hands the stores through as Logins answered them', async () => {
    const stores = [{ id: 'claude-work', variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fy/claude-work' } }];
    const read = loginsLaunchStores({ launchStores: async () => stores });

    expect(await read()).toBe(stores);
  });

  test('refuses the publish in its own sentence, quoting nothing Logins said, when the read fails', async () => {
    const read = loginsLaunchStores({
      launchStores: async () => {
        throw new Error('secret detail /home/person/.ssh');
      },
    });

    const refusal = (await read().catch((error: Error) => error)) as Error;

    expect(refusal.message).toBe('Logins could not say where its logins are kept, so the runtimes were not published');
  });
});
