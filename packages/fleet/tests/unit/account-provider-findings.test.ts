/**
 * Which provider each CLI is set up for, read from its settings and the login shell, and the
 * environment login it becomes (docs/provider-presets.md § Detect). The catalogue is the real built-in
 * one: the table is the preset files' own `detect:` blocks, so a preset edit that breaks a case fails here.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  codexConfigProvider,
  findProvider,
  type ProviderFindingView,
  providerCredential,
  providerFindingView,
  shellVariableFilter,
} from '../../src/lib/account/provider-findings.ts';
import type { HarnessKind } from '../../src/lib/manifest.ts';
import { builtInPresets } from '../../src/lib/presets/catalog.ts';

const PRESETS = builtInPresets();

const claude = (shell: Record<string, string>, settingsEnv: Record<string, string> = {}) =>
  findProvider({ harness: 'claude', presets: PRESETS, shell, settingsEnv });

const codex = (shell: Record<string, string>, config?: Parameters<typeof findProvider>[0]['codexConfig']) =>
  findProvider({ harness: 'codex', presets: PRESETS, shell, ...(config === undefined ? {} : { codexConfig: config }) });

describe('findProvider: the detection matrix', () => {
  it('should find Amazon Bedrock on an AWS profile from the shell, with its region and profile as facts', () => {
    // Act
    const actual = claude({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'work', AWS_REGION: 'us-east-1' });

    // Assert
    should(actual?.preset.id).equal('amazon-bedrock');
    should(actual?.source).equal('shell');
    should(actual?.cloudCredential).equal('aws-profile:work');
    should(actual?.facts).deepEqual([
      { name: 'AWS_REGION', value: 'us-east-1' },
      { name: 'AWS_PROFILE', value: 'work' },
    ]);
    should(actual?.secrets).deepEqual([]);
  });

  it('should find the Bedrock API key preset when the shell holds the key, naming it and never showing it', () => {
    // Arrange
    const key = 'ABSKbedrock-api-key-value-0123456789';

    // Act
    const actual = claude({ CLAUDE_CODE_USE_BEDROCK: 'true', AWS_BEARER_TOKEN_BEDROCK: key, AWS_REGION: 'us-west-2' });

    // Assert
    should(actual?.preset.id).equal('amazon-bedrock-api-key');
    should(actual?.secrets).deepEqual(['AWS_BEARER_TOKEN_BEDROCK']);
    should(JSON.stringify(providerFindingView(actual as never))).not.containEql(key);
  });

  it('should find Google Vertex AI from settings.json, saying where it came from', () => {
    // Act
    const actual = claude(
      {},
      { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'acme-dev', CLOUD_ML_REGION: 'us-east5' },
    );

    // Assert
    should(actual?.preset.id).equal('google-vertex');
    should(actual?.source).equal('settings.json');
    should(actual?.fromSettings.toSorted()).deepEqual([
      'ANTHROPIC_VERTEX_PROJECT_ID',
      'CLAUDE_CODE_USE_VERTEX',
      'CLOUD_ML_REGION',
    ]);
    should(actual?.cloudCredential).equal('gcloud-adc');
  });

  it('should say settings.json+shell when the switch is in one and the profile in the other', () => {
    // Act
    const actual = claude({ AWS_PROFILE: 'work' }, { CLAUDE_CODE_USE_BEDROCK: '1' });

    // Assert
    should(actual?.preset.id).equal('amazon-bedrock');
    should(actual?.source).equal('settings.json+shell');
  });

  it('should let settings.json win over the shell for the same variable, as Claude Code applies it', () => {
    // Act
    const actual = claude({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' }, { AWS_REGION: 'eu-central-1' });

    // Assert
    should(actual?.facts).containEql({ name: 'AWS_REGION', value: 'eu-central-1' });
  });

  it('should show no fact for a blank value, and read no variable whose name no CLI could have', () => {
    // Act
    const actual = claude({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: '   ' }, { 'ANTHROPIC_ODD NAME': 'x' });

    // Assert
    should(actual?.facts).deepEqual([]);
    should(actual?.fromSettings).not.containEql('ANTHROPIC_ODD NAME');
    should(Object.keys(actual?.values ?? {})).not.containEql('ANTHROPIC_ODD NAME');
  });

  it('should find a bare Anthropic API key, the commonest setup', () => {
    // Act
    const actual = claude({ ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnop' });

    // Assert
    should(actual?.preset.id).equal('anthropic-api-key');
    should(actual?.secrets).deepEqual(['ANTHROPIC_API_KEY']);
  });

  it("should let a gateway's deliberately empty ANTHROPIC_API_KEY lose to the gateway's host", () => {
    // Act
    const actual = claude({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-abcdefghijklmnop',
      ANTHROPIC_API_KEY: '',
    });

    // Assert
    should(actual?.preset.id).equal('openrouter');
    should(actual?.facts).containEql({ name: 'ANTHROPIC_BASE_URL', value: 'openrouter.ai' });
  });

  it('should call a base URL on a host no preset declares a custom gateway, showing its host only', () => {
    // Act — a URL with a user and a password, and a key the anthropic preset would otherwise claim
    const actual = claude({
      ANTHROPIC_BASE_URL: 'https://svc:hunter2@llm.corp.example/v1',
      ANTHROPIC_AUTH_TOKEN: 'corp-gateway-token-value',
      ANTHROPIC_API_KEY: 'not-empty-either',
    });

    // Assert
    should(actual?.preset.id).equal('custom-gateway');
    should(actual?.facts).deepEqual([]);
    should(actual?.secrets).containEql('ANTHROPIC_BASE_URL');
    const view = JSON.stringify(providerFindingView(actual as never));
    should(view).not.containEql('hunter2');
    should(view).not.containEql('corp-gateway-token-value');
  });

  it('should show a plain gateway address as its host', () => {
    // Act
    const actual = claude({ ANTHROPIC_BASE_URL: 'http://localhost:4000/path?q=1', ANTHROPIC_AUTH_TOKEN: 'abc12345' });

    // Assert
    should(actual?.preset.id).equal('custom-gateway');
    should(actual?.facts).deepEqual([{ name: 'ANTHROPIC_BASE_URL', value: 'localhost' }]);
  });

  it('should find nothing for Claude Code when the shell only HAS cloud variables it does not use', () => {
    // Act + Assert
    should(claude({ AWS_PROFILE: 'work', AWS_REGION: 'us-east-1' })).be.undefined();
    should(claude({ OPENROUTER_API_KEY: 'sk-or-v1-abcdefghijklmnop' })).be.undefined();
    should(claude({ CLAUDE_CODE_USE_BEDROCK: '0', AWS_PROFILE: 'work' })).be.undefined();
    should(claude({})).be.undefined();
  });

  it('should keep a switch that is on deciding the family, whatever else is set', () => {
    // Act
    const actual = claude({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnop' });

    // Assert
    should(actual?.preset.id).startWith('amazon-bedrock');
    // The Anthropic key is Claude Code identity: the login takes it over from settings, it is not lost.
    should(claude({ CLAUDE_CODE_USE_BEDROCK: '1' }, { ANTHROPIC_API_KEY: 'x'.repeat(20) })?.fromSettings).containEql(
      'ANTHROPIC_API_KEY',
    );
  });

  it('should find a Codex provider table in config.toml whose key lives in the shell', () => {
    // Act
    const actual = codex(
      { OR_KEY: 'sk-or-v1-abcdefghijklmnop' },
      { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OR_KEY' },
    );

    // Assert
    should(actual?.preset.id).equal('openrouter');
    should(actual?.source).equal('config.toml+shell');
    should(actual?.codexConfigProvider).equal('openrouter');
    // The preset's own key variable carries the key the table's env_key named.
    should(actual?.values.OPENROUTER_API_KEY).equal('sk-or-v1-abcdefghijklmnop');
    should(actual?.facts).containEql({ name: 'model_providers.openrouter.base_url', value: 'openrouter.ai' });
  });

  it('should find an OpenAI API key for Codex from the shell, and nothing for an unknown provider table', () => {
    // Act + Assert
    should(codex({ OPENAI_API_KEY: 'sk-proj-abcdefghijklmnop' })?.preset.id).equal('openai-api-key');
    should(
      codex({ OPENAI_API_KEY: 'sk-proj-abcdefghijklmnop' }, { id: 'corp', baseUrl: 'https://llm.corp.example' }),
    ).be.undefined();
    should(codex({ OPENROUTER_API_KEY: 'sk-or-v1-abcdefghijklmnop' })).be.undefined();
  });
});

describe('codexConfigProvider', () => {
  it('should read the active table, and say nothing for Codex’s own provider', () => {
    should(
      codexConfigProvider({
        model_provider: 'openrouter',
        model_providers: { openrouter: { base_url: 'https://openrouter.ai/api/v1', env_key: 'OPENROUTER_API_KEY' } },
      }),
    ).deepEqual({ id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY' });
    should(codexConfigProvider({ model_provider: 'openai' })).be.undefined();
    should(codexConfigProvider({})).be.undefined();
    // A table id that could not be reported as a clue name is named, never read.
    const odd = codexConfigProvider({
      model_provider: 'my provider',
      model_providers: { 'my provider': { base_url: 'https://openrouter.ai/api/v1', env_key: 'K' } },
    });
    should(odd).deepEqual({ id: 'my provider' });
    should(codex({ K: 'sk-or-v1-abcdefghijklmnop' }, odd)).be.undefined();
    should(codexConfigProvider({ model_provider: 'x', model_providers: { x: { env_key: 'not a name' } } })).deepEqual({
      id: 'x',
    });
  });
});

describe('shellVariableFilter', () => {
  it('should keep what a provider can be told by and drop everything else unread', () => {
    // Arrange
    const keep = shellVariableFilter(PRESETS, ['MY_CODEX_KEY']);

    // Act + Assert
    for (const name of [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_SOMETHING_NEW',
      'AWS_PROFILE',
      'AWS_REGION',
      'AWS_BEARER_TOKEN_BEDROCK',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'AZURE_OPENAI_RESOURCE',
      'MY_CODEX_KEY',
    ]) {
      should(keep(name)).be.true(`${name} should be kept`);
    }
    for (const name of [
      'HOME',
      'PATH',
      'GITHUB_TOKEN',
      'NPM_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'ANTHROPIC_CUSTOM_HEADERS',
      'ssh-agent',
    ]) {
      should(keep(name)).be.false(`${name} should be dropped`);
    }
  });
});

describe('providerCredential', () => {
  it('should make the environment login --from-env makes: plain values, a profile reference, no secret', () => {
    // Arrange
    const finding = claude({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'work', AWS_REGION: 'eu-west-1' });
    const claimed: string[] = [];

    // Act
    const made = providerCredential(finding as never, name => {
      claimed.push(name);
      return name;
    });

    // Assert
    should(made).deepEqual({
      credential: {
        harness: 'claude',
        store: 'environment',
        preset: 'amazon-bedrock',
        cloudCredential: 'aws-profile:work',
        env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1' },
      },
    });
    should(claimed).deepEqual([]);
  });

  it('should hand each secret value to the store and keep only its reference', () => {
    // Arrange
    const key = 'sk-or-v1-abcdefghijklmnop';
    const finding = claude({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: key });
    const stored: [string, string][] = [];

    // Act
    const made = providerCredential(finding as never, (name, value) => {
      stored.push([name, value]);
      return `${name}_2`;
    });

    // Assert
    should(stored).deepEqual([['OPENROUTER_API_KEY', key]]);
    should(JSON.stringify(made)).not.containEql(key);
    should(made).containDeep({ credential: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:OPENROUTER_API_KEY_2}' } } });
  });

  it('should refuse a finding that lacks a required secret, and claim nothing', () => {
    // Arrange — OpenRouter by its host, with no token anywhere
    const finding = claude({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_API_KEY: 'x'.repeat(12) });
    let claims = 0;

    // Act
    const made = providerCredential(finding as never, name => {
      claims += 1;
      return name;
    });

    // Assert
    should(made).have.property('refusal');
    should(claims).equal(0);
  });
});

describe('ProviderFindingView: no field can hold a value', () => {
  it('should have exactly the fields that hold names, a label and plain facts', () => {
    // Arrange — a compile-time check that the view grew no field: a new key fails to type-check here.
    type Keys = keyof ProviderFindingView;
    const keys: Record<Keys, true> = {
      preset: true,
      label: true,
      source: true,
      clues: true,
      facts: true,
      secrets: true,
    };
    const finding = claude({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 'ABSKkey-value-0123456789' });

    // Act
    const view = providerFindingView(finding as never);

    // Assert
    should(Object.keys(view).toSorted()).deepEqual(Object.keys(keys).toSorted());
    should(view).not.have.property('values');
    should(JSON.stringify(view)).not.containEql('ABSKkey-value');
  });

  it('should find nothing for a harness with no presets that drive it', () => {
    // Act
    const harness: HarnessKind = 'claude';
    const actual = findProvider({ harness, presets: [], shell: { CLAUDE_CODE_USE_BEDROCK: '1' } });

    // Assert
    should(actual).be.undefined();
  });
});
