import { describe, it } from 'bun:test';
import should from 'should';
import {
  CLAUDE_SECURE_STORAGE_VARIABLE,
  claudeStorageDirectory,
  codexCredentialLink,
  credentialLaunchArguments,
  credentialLaunchEnvironment,
  ferretryCredentialDirectory,
  HOST_CLAUDE_SECURE_STORAGE,
  hostCodexCredentialFile,
  hostCodexHome,
  resolveCredentialStore,
} from '../../src/lib/account/credentials.ts';
import { type Credential, CredentialSchema } from '../../src/lib/account/schema.ts';

const FLEET = '/fy/fleet';
const USER = '/people/placeholder';
const PATHS = { fleetRoot: FLEET, userHome: USER, hostCodexHome: `${USER}/.codex` } as const;

/** Parse rather than hand-build, so every case is a credential a person could write. */
const credential = (input: Record<string, unknown>): Credential => CredentialSchema.parse(input);

describe('resolveCredentialStore — Claude', () => {
  it('should give a ferretry credential its own directory as the secure-storage value', () => {
    // Act
    const actual = resolveCredentialStore('claude-work', credential({ harness: 'claude', store: 'ferretry' }), PATHS);

    // Assert — one string exported AND hashed for the keychain, so it is the store directory itself.
    should(actual).deepEqual({
      harness: 'claude',
      store: 'ferretry',
      secureStorage: '/fy/fleet/credentials/claude-work',
      storageDirectory: '/fy/fleet/credentials/claude-work',
      credentialFile: '/fy/fleet/credentials/claude-work/.credentials.json',
      ownedDirectory: '/fy/fleet/credentials/claude-work',
    });
  });

  it("should give the person's own login the EMPTY value, never the absolute ~/.claude", () => {
    // Act
    const actual = resolveCredentialStore('claude-you', credential({ harness: 'claude', store: 'host' }), PATHS);

    // Assert — measured: "" selects the bare keychain item and `<home>/.claude` for the file. A path
    // would hash to a different item than the person's own `claude` uses.
    should(actual).deepEqual({
      harness: 'claude',
      store: 'host',
      secureStorage: '',
      storageDirectory: '/people/placeholder/.claude',
      credentialFile: '/people/placeholder/.claude/.credentials.json',
    });
    should(HOST_CLAUDE_SECURE_STORAGE).equal('');
  });

  it('should default an unspecified store to ferretry', () => {
    should(resolveCredentialStore('c', credential({ harness: 'claude' }), PATHS).store).equal('ferretry');
  });
});

describe('resolveCredentialStore — Codex', () => {
  it('should keep a ferretry credential in one canonical auth.json under its directory', () => {
    const actual = resolveCredentialStore('codex-work', credential({ harness: 'codex', store: 'ferretry' }), PATHS);

    should(actual).deepEqual({
      harness: 'codex',
      store: 'ferretry',
      canonicalFile: '/fy/fleet/credentials/codex-work/auth.json',
      ownedDirectory: '/fy/fleet/credentials/codex-work',
    });
  });

  it("should share the person's own auth.json in place for a host credential", () => {
    const actual = resolveCredentialStore('codex-you', credential({ harness: 'codex', store: 'host' }), PATHS);

    should(actual).deepEqual({
      harness: 'codex',
      store: 'host',
      canonicalFile: '/people/placeholder/.codex/auth.json',
    });
  });

  it('should say a host credential is unavailable when the Codex home could not be named', () => {
    const actual = resolveCredentialStore('codex-you', credential({ harness: 'codex', store: 'host' }), {
      fleetRoot: FLEET,
      userHome: USER,
    });

    should(actual)
      .have.property('unavailable')
      .match(/CODEX_HOME/u);
    should(codexCredentialLink('/fy/fleet/homes/r1', actual)).be.undefined();
    should(credentialLaunchEnvironment(actual)).deepEqual({});
  });
});

describe('resolveCredentialStore — environment', () => {
  it('should carry the credential env and nothing on disk', () => {
    const actual = resolveCredentialStore(
      'claude-key',
      credential({ harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } }),
      PATHS,
    );

    should(actual).deepEqual({
      harness: 'claude',
      store: 'environment',
      env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' },
    });
    should(credentialLaunchEnvironment(actual)).deepEqual({ ANTHROPIC_API_KEY: '${secret:WORK_KEY}' });
    should(codexCredentialLink('/fy/fleet/homes/r1', actual)).be.undefined();
  });
});

describe('credentialLaunchEnvironment', () => {
  it('should export the empty secure-storage value as a value, not drop it', () => {
    const resolution = resolveCredentialStore('claude-you', credential({ harness: 'claude', store: 'host' }), PATHS);

    should(credentialLaunchEnvironment(resolution)).deepEqual({ [CLAUDE_SECURE_STORAGE_VARIABLE]: '' });
    should(CLAUDE_SECURE_STORAGE_VARIABLE).equal('CLAUDE_SECURESTORAGE_CONFIG_DIR');
  });

  it('should export the store directory for a ferretry Claude credential and never HOME', () => {
    const resolution = resolveCredentialStore('w', credential({ harness: 'claude', store: 'ferretry' }), PATHS);

    const actual = credentialLaunchEnvironment(resolution);

    should(actual).deepEqual({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fy/fleet/credentials/w' });
    should(actual).not.have.property('HOME');
  });

  it('should export nothing for Codex, whose credential arrives through the link', () => {
    const resolution = resolveCredentialStore('w', credential({ harness: 'codex', store: 'ferretry' }), PATHS);

    should(credentialLaunchEnvironment(resolution)).deepEqual({});
  });
});

describe('codexCredentialLink', () => {
  it("should link a runtime's own auth.json to the canonical file", () => {
    const resolution = resolveCredentialStore('w', credential({ harness: 'codex', store: 'ferretry' }), PATHS);

    should(codexCredentialLink('/fy/fleet/homes/r1', resolution)).deepEqual({
      path: '/fy/fleet/homes/r1/auth.json',
      target: '/fy/fleet/credentials/w/auth.json',
    });
  });

  it('should offer no link at all for a Claude credential', () => {
    const resolution = resolveCredentialStore('w', credential({ harness: 'claude', store: 'ferretry' }), PATHS);

    should(codexCredentialLink('/fy/fleet/homes/r1', resolution)).be.undefined();
  });
});

describe('hostCodexHome', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('should be <home>/.codex when CODEX_HOME is %s', (_label, value) => {
    should(hostCodexHome(value, USER)).equal('/people/placeholder/.codex');
  });

  it('should honour an absolute CODEX_HOME the way Codex does', () => {
    should(hostCodexHome('/elsewhere/codex/', USER)).equal('/elsewhere/codex/');
    should(hostCodexCredentialFile('/elsewhere/codex', USER)).equal('/elsewhere/codex/auth.json');
  });

  it('should refuse a relative CODEX_HOME rather than guess what it was relative to', () => {
    should(hostCodexHome('codex', USER)).be.undefined();
    should(hostCodexCredentialFile('codex', USER)).be.undefined();
  });
});

describe('claudeStorageDirectory and ferretryCredentialDirectory', () => {
  it('should normalise to NFC, because the keychain item is a hash of this exact string', () => {
    const decomposed = '/fy/café';

    should(claudeStorageDirectory(decomposed, USER)).equal('/fy/café');
    should(ferretryCredentialDirectory('/fy/café', 'c')).equal('/fy/café/credentials/c');
  });

  it('should drop a trailing separator from the fleet root', () => {
    should(ferretryCredentialDirectory('/fy/fleet/', 'c')).equal('/fy/fleet/credentials/c');
  });
});

describe('resolveCredentialStore — environment extras', () => {
  it('should hand a cloud credential over as its variable, beside the login’s own', () => {
    // Act
    const actual = resolveCredentialStore(
      'bedrock',
      credential({
        harness: 'claude',
        store: 'environment',
        env: { CLAUDE_CODE_USE_BEDROCK: '1' },
        cloudCredential: 'aws-profile:acme',
      }),
      PATHS,
    );

    // Assert
    should(credentialLaunchEnvironment(actual)).deepEqual({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'acme' });
    should(credentialLaunchArguments(actual)).deepEqual([]);
  });

  it('should give a Codex login its model provider as launch flags', () => {
    // Act
    const actual = resolveCredentialStore(
      'kimi',
      credential({
        harness: 'codex',
        store: 'environment',
        env: { KIMI_API_KEY: '${secret:MOONSHOT_API_KEY}' },
        codexProvider: { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1', keyVariable: 'KIMI_API_KEY' },
      }),
      PATHS,
    );

    // Assert
    should(credentialLaunchArguments(actual)).containEql('model_provider="kimi"');
    should(actual).not.have.property('problem');
  });

  it('should say why a Codex provider cannot be put together, and launch with no flags', () => {
    // Act
    const actual = resolveCredentialStore(
      'azure',
      credential({
        harness: 'codex',
        store: 'environment',
        env: { RESOURCE: 'not a host', AZURE_OPENAI_API_KEY: '${secret:AZURE_OPENAI_API_KEY}' },
        codexProvider: {
          id: 'azure-openai',
          name: 'Azure',
          baseUrl: 'https://{RESOURCE}.openai.azure.com/openai/v1',
          keyVariable: 'AZURE_OPENAI_API_KEY',
        },
      }),
      PATHS,
    );

    // Assert
    should(actual)
      .have.property('problem')
      .match(/RESOURCE/u);
    should(credentialLaunchArguments(actual)).deepEqual([]);
  });

  it('should give a login that is not an environment no launch flags', () => {
    const actual = resolveCredentialStore('claude-work', credential({ harness: 'claude', store: 'ferretry' }), PATHS);
    should(credentialLaunchArguments(actual)).deepEqual([]);
  });
});

describe('resolveCredentialStore — halves (docs/provider-presets.md § One login, both CLIs)', () => {
  const dual = credential({
    harness: 'claude',
    store: 'environment',
    env: { SHARED: 'everyone' },
    claude: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
    codex: {
      env: { OPENROUTER_API_KEY: '${secret:S}' },
      codexProvider: {
        id: 'openrouter',
        name: 'OpenRouter',
        keyVariable: 'OPENROUTER_API_KEY',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
    },
  });

  it('should give the Claude half its own environment, the shared variable included', () => {
    const actual = resolveCredentialStore('glm', dual, PATHS, 'claude');
    should(credentialLaunchEnvironment(actual)).deepEqual({
      SHARED: 'everyone',
      ANTHROPIC_AUTH_TOKEN: '${secret:S}',
    });
    should(credentialLaunchArguments(actual)).deepEqual([]);
  });

  it('should give the Codex half its own environment and its model-provider flags', () => {
    const actual = resolveCredentialStore('glm', dual, PATHS, 'codex');
    should(credentialLaunchEnvironment(actual)).deepEqual({ SHARED: 'everyone', OPENROUTER_API_KEY: '${secret:S}' });
    should(credentialLaunchArguments(actual)).containEql('model_provider="openrouter"');
  });

  it("should default to the login's own harness when none is given", () => {
    const actual = resolveCredentialStore('glm', dual, PATHS);
    should(actual.harness).equal('claude');
  });

  it('should give a CLI the login does not drive no variables at all', () => {
    // Only a hand-built model reaches this: the schema refuses a runtime naming a half its login lacks.
    const claudeOnly = credential({
      harness: 'claude',
      store: 'environment',
      claude: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
    });
    const actual = resolveCredentialStore('glm', claudeOnly, PATHS, 'codex');
    should(credentialLaunchEnvironment(actual)).deepEqual({});
  });
});
