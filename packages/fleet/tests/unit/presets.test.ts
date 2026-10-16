import { describe, it } from 'bun:test';
import { secretReference } from '@ferretry/protocol';
import should from 'should';
import { CredentialSchema } from '../../src/lib/account/schema.ts';
import { findRawSecrets } from '../../src/lib/config-files/secrets.ts';
import { readConfigText } from '../../src/lib/config-files/yaml-text.ts';
import {
  BUILT_IN_PRESET_TEXTS,
  BuiltInPresetError,
  builtInPresets,
  parsePresetText,
  presetCatalog,
  presetFileText,
} from '../../src/lib/presets/catalog.ts';
import {
  credentialFromPreset,
  presetDefaultEnv,
  presetLoginRefusal,
  presetSecrets,
} from '../../src/lib/presets/login.ts';
import {
  PresetVariableSchema,
  type ProviderPreset,
  type ProviderPresetFile,
  ProviderPresetFileSchema,
  presetFromFile,
  presetHarnesses,
} from '../../src/lib/presets/schema.ts';

const PRESETS = builtInPresets();
const preset = (id: string): ProviderPreset => PRESETS.find(entry => entry.id === id) as ProviderPreset;

/** A value for every variable a preset leaves for the person to fill in, so its login can be made. */
const filledEnv = (entry: ProviderPreset): Record<string, string> =>
  Object.fromEntries(
    Object.entries(presetDefaultEnv(entry)).map(([name, value]) => [
      name,
      value === '' && entry.env[name]?.required === true && entry.env[name]?.allowEmpty !== true
        ? name.endsWith('_URL')
          ? 'https://gateway.example.com'
          : 'acme'
        : value,
    ]),
  );

describe('the built-in preset catalogue', () => {
  it('should ship every preset the plan lists, Claude Code first', () => {
    should(PRESETS.map(entry => entry.id)).deepEqual(Object.keys(BUILT_IN_PRESET_TEXTS));
    should(PRESETS.findIndex(entry => entry.harness === 'codex')).equal(
      PRESETS.filter(entry => entry.harness === 'claude').length,
    );
  });

  it.each(Object.keys(BUILT_IN_PRESET_TEXTS))('should ship %s as a file that checks and holds no raw secret', id => {
    // Arrange
    const text = BUILT_IN_PRESET_TEXTS[id] as string;
    const read = readConfigText(text);

    // Assert — the same detector a machine's own copy in config/presets/ would meet
    should(read.ok).be.true();
    should(read.ok && findRawSecrets(read.read.value)).deepEqual([]);
    should(ProviderPresetFileSchema.safeParse(read.ok ? read.read.value : undefined).success).be.true();
  });

  it.each(PRESETS.filter(entry => entry.unavailable === undefined).map(entry => entry.id))(
    'should make a login from %s that the account model accepts',
    id => {
      // Arrange
      const entry = preset(id);
      const input = {
        env: filledEnv(entry),
        ...(entry.cloudCredential === undefined ? {} : { cloudCredential: entry.cloudCredential.suggested }),
      };

      // Act
      const refusal = presetLoginRefusal(entry, input);
      const credential = CredentialSchema.safeParse(credentialFromPreset(entry, input));

      // Assert
      should(refusal).be.undefined();
      should(credential.error?.issues ?? []).deepEqual([]);
    },
  );

  it('should hide a preset whose Codex half cannot run, with the reason, while Claude Code stays usable', () => {
    // Act
    const glm = preset('zai-glm');

    // Assert
    should(glm.unavailable).be.undefined();
    should(glm.halves.codex?.unavailable).match(/model catalogue file/u);
    should(presetHarnesses(glm)).deepEqual(['claude']);
    should(presetLoginRefusal(glm, { env: presetDefaultEnv(glm), harness: 'codex' })).match(
      /does not drive Codex: Z\.ai serves the Responses API/u,
    );
  });

  it('should keep every secret a NAME and every test key a secret', () => {
    for (const entry of PRESETS) {
      for (const variable of Object.values(entry.env)) {
        if (variable.secretName !== undefined) should(variable.value).be.undefined();
      }
      if (entry.test.kind === 'request' || entry.test.kind === 'inference') {
        should(entry.env[entry.test.keyVariable]?.secretName).be.a.String();
      }
    }
  });

  it('should file the presets under the grid’s headings, leaving the two nobody asked to group under none', () => {
    const grouped = (group: string | undefined) =>
      PRESETS.filter(entry => entry.group === group).map(entry => entry.id);
    should(grouped('popular')).deepEqual([
      'anthropic-api-key',
      'zai-glm',
      'kimi',
      'minimax',
      'deepseek',
      'openrouter',
      'openai-api-key',
    ]);
    should(grouped('cloud')).deepEqual([
      'amazon-bedrock',
      'amazon-bedrock-api-key',
      'bedrock-mantle',
      'google-vertex',
      'microsoft-foundry-api-key',
      'microsoft-foundry-azure-cli',
      'azure-openai',
    ]);
    should(grouped('self-hosted')).deepEqual(['litellm', 'custom-gateway', 'ollama-codex']);
    should(grouped(undefined)).deepEqual(['qwen-coding-plan', 'vercel-ai-gateway']);
    should(ProviderPresetFileSchema.safeParse({ group: 'favourite' }).error?.issues.map(i => i.path[0])).containEql(
      'group',
    );
  });

  it('should give the text to start a copy from, and nothing for an unknown id', () => {
    should(presetFileText('kimi')).equal(BUILT_IN_PRESET_TEXTS.kimi);
    should(presetFileText('nope')).be.undefined();
  });
});

describe('parsePresetText', () => {
  it('should name every syntax error', () => {
    const actual = parsePresetText('x', 'label: [unclosed', 'file');
    should(actual.ok).be.false();
    should(!actual.ok && actual.problem).be.a.String();
  });

  it('should name every schema problem by its path', () => {
    const actual = parsePresetText('x', 'label: X\nharness: claude\n', 'file');
    should(!actual.ok && actual.problem).match(/summary: /u);
  });

  it('should name a problem with the file itself as "file"', () => {
    const actual = parsePresetText('x', '- a\n', 'file');
    should(!actual.ok && actual.problem).match(/^file: /u);
  });

  it('should give a preset the id and origin it was read with', () => {
    const actual = parsePresetText('mine', BUILT_IN_PRESET_TEXTS.kimi as string, 'file');
    should(actual.ok && actual.preset.id).equal('mine');
    should(actual.ok && actual.preset.origin).equal('file');
  });
});

describe('BuiltInPresetError', () => {
  it('should say which shipped file is broken', () => {
    const actual = new BuiltInPresetError('kimi', 'docs: invalid');
    should(actual.message).equal('built-in preset kimi does not check: docs: invalid');
    should(actual.name).equal('BuiltInPresetError');
  });
});

describe('presetCatalog', () => {
  it('should lay a machine file over the built-in of its id, in place, and add new ones after, by id', () => {
    // Arrange
    const kimi = { ...preset('kimi'), label: 'My Kimi', origin: 'file' as const };
    const zed = { ...preset('kimi'), id: 'zed', origin: 'file' as const };
    const alpha = { ...preset('kimi'), id: 'alpha', origin: 'file' as const };

    // Act
    const actual = presetCatalog(PRESETS, { zed, kimi, alpha });

    // Assert
    should(actual.find(entry => entry.id === 'kimi')?.label).equal('My Kimi');
    should(actual.findIndex(entry => entry.id === 'kimi')).equal(PRESETS.findIndex(entry => entry.id === 'kimi'));
    should(actual.slice(-2).map(entry => entry.id)).deepEqual(['alpha', 'zed']);
  });
});

describe('ProviderPresetFileSchema', () => {
  it('should refuse a variable that is both a value and a secret, or neither', () => {
    should(PresetVariableSchema.safeParse({ value: 'a', secretName: 'A' }).success).be.false();
    should(PresetVariableSchema.safeParse({}).success).be.false();
  });

  it('should refuse a Codex provider on a Claude Code preset', () => {
    // amazon-bedrock is a legacy, single-harness (claude) preset: no halves to route it through.
    const read = readConfigText(BUILT_IN_PRESET_TEXTS['amazon-bedrock'] as string);
    const value = { ...(read.ok ? (read.read.value as object) : {}), codexProvider: { id: 'ollama' } };
    should(ProviderPresetFileSchema.safeParse(value).error?.issues[0]?.message).match(/only to a Codex preset/u);
  });

  it('should refuse a test whose key is not a secret variable', () => {
    const read = readConfigText(BUILT_IN_PRESET_TEXTS.kimi as string);
    const value = read.ok ? (read.read.value as Record<string, unknown>) : {};
    const actual = ProviderPresetFileSchema.safeParse({
      ...value,
      test: { ...(value.test as object), keyVariable: 'ANTHROPIC_BASE_URL' },
    });
    should(actual.error?.issues[0]?.path).deepEqual(['test', 'keyVariable']);
  });
});

describe('a login from a preset', () => {
  it('should fill secrets in as references and plain values as they are', () => {
    should(presetDefaultEnv(preset('zai-glm'))).containDeep({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: secretReference('ZAI_API_KEY'),
    });
  });

  it('should ask for a required variable left empty, by name', () => {
    const vertex = preset('google-vertex');
    should(presetLoginRefusal(vertex, { env: presetDefaultEnv(vertex), cloudCredential: 'gcloud-adc' })).equal(
      'ANTHROPIC_VERTEX_PROJECT_ID is needed for Google Vertex AI — fill it in',
    );
  });

  it('should keep an empty value a preset means to be empty', () => {
    // openrouter now drives both CLIs, so a one-CLI login made from its claude half only is what
    // carries the deliberately empty ANTHROPIC_API_KEY.
    const openrouter = preset('openrouter');
    const env = presetDefaultEnv(openrouter);
    should(presetLoginRefusal(openrouter, { env, halves: ['claude'] })).be.undefined();
    should(credentialFromPreset(openrouter, { env, halves: ['claude'] }).env).containDeep({
      ANTHROPIC_API_KEY: '',
    });
  });

  it('should leave out an optional variable left empty', () => {
    const bedrock = preset('amazon-bedrock');
    const env = { ...presetDefaultEnv(bedrock), ANTHROPIC_DEFAULT_OPUS_MODEL: '' };
    const actual = credentialFromPreset(bedrock, { env, cloudCredential: 'aws-profile:acme', label: 'work' });
    should(actual.env).not.have.property('ANTHROPIC_DEFAULT_OPUS_MODEL');
    should(actual).containDeep({ preset: 'amazon-bedrock', label: 'work', cloudCredential: 'aws-profile:acme' });
  });

  it('should refuse a raw value where the preset says secret', () => {
    const kimi = preset('kimi');
    should(presetLoginRefusal(kimi, { env: { ...presetDefaultEnv(kimi), ANTHROPIC_AUTH_TOKEN: 'pasted' } })).match(
      /ANTHROPIC_AUTH_TOKEN is a secret: store it in the secret store/u,
    );
  });

  it('should refuse a cloud credential where none is taken, and ask for one where it is needed', () => {
    const kimi = preset('kimi');
    should(presetLoginRefusal(kimi, { env: presetDefaultEnv(kimi), cloudCredential: 'azure-cli' })).match(
      /takes no cloud credential reference/u,
    );
    const bedrock = preset('amazon-bedrock');
    should(presetLoginRefusal(bedrock, { env: presetDefaultEnv(bedrock) })).match(
      /needs a cloud credential reference: aws-profile/u,
    );
    should(presetLoginRefusal(bedrock, { env: presetDefaultEnv(bedrock), cloudCredential: 'azure-cli' })).match(
      /takes a cloud credential reference of kind aws-profile/u,
    );
    should(presetLoginRefusal(bedrock, { env: presetDefaultEnv(bedrock), cloudCredential: 'nonsense' })).match(
      /of kind aws-profile/u,
    );
  });

  it('should give a Codex login its preset’s model provider, on its codex half', () => {
    const openrouter = preset('openrouter');
    const credential = credentialFromPreset(openrouter, { env: presetDefaultEnv(openrouter) });
    should(credential.codex?.codexProvider).containDeep({ id: 'openrouter', keyVariable: 'OPENROUTER_API_KEY' });
    should(CredentialSchema.safeParse(credential).error?.issues ?? []).deepEqual([]);
  });

  it('should give a one-CLI Codex login from a dual preset its model provider at the top level', () => {
    const openrouter = preset('openrouter');
    const env = { OPENROUTER_API_KEY: secretReference('OPENROUTER_API_KEY') };
    const credential = credentialFromPreset(openrouter, { env, halves: ['codex'], harness: 'codex' });
    should(credential).containDeep({ harness: 'codex' });
    should(credential.codexProvider).containDeep({ id: 'openrouter', keyVariable: 'OPENROUTER_API_KEY' });
    should(credential).not.have.property('claude');
    should(credential).not.have.property('codex');
    should(CredentialSchema.safeParse(credential).error?.issues ?? []).deepEqual([]);
  });

  it('should make a login with no variables at all from a preset that has none', () => {
    const ollama = preset('ollama-codex');
    should(credentialFromPreset(ollama, { env: {} })).not.have.property('env');
  });

  it('should drive both CLIs with one secret from a dual preset, the shared env and an unknown extra variable going to the shared env', () => {
    // Arrange — minimax has a shared MINIMAX... no: it is a dual preset with separate keys per half,
    // so use deepseek, whose claude and codex halves both read DEEPSEEK_API_KEY.
    const deepseek = preset('deepseek');
    const env = { ...presetDefaultEnv(deepseek), FUTURE_VARIABLE: 'kept' };

    // Act
    should(presetLoginRefusal(deepseek, { env })).be.undefined();
    const credential = credentialFromPreset(deepseek, { env });

    // Assert — one login, both halves, the secret present in each half that declares it
    should(credential.harness).equal('claude');
    should(credential.claude?.env).containDeep({ ANTHROPIC_AUTH_TOKEN: secretReference('DEEPSEEK_API_KEY') });
    should(credential.codex?.env).containDeep({ DEEPSEEK_API_KEY: secretReference('DEEPSEEK_API_KEY') });
    should(credential.env).deepEqual({ FUTURE_VARIABLE: 'kept' });
    should(CredentialSchema.safeParse(credential).error?.issues ?? []).deepEqual([]);
  });
});

describe('presetSecrets', () => {
  it('should name each secret once, by every variable that carries it, required when any of them is', () => {
    // Arrange — deepseek's one secret authenticates two variables, one per half
    const deepseek = preset('deepseek');

    // Act
    const actual = presetSecrets(deepseek);

    // Assert
    should(actual).deepEqual([
      { name: 'DEEPSEEK_API_KEY', variables: ['DEEPSEEK_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], required: true },
    ]);
  });

  it('should name nothing for a preset with no secret variable', () => {
    should(presetSecrets(preset('ollama-codex'))).deepEqual([]);
  });
});

describe('presetLoginRefusal — halves (docs/provider-presets.md § One login, both CLIs)', () => {
  it('should refuse a half the preset does not offer at all, without a reason', () => {
    // anthropic-api-key is single-harness (claude only): it has no codex half whatsoever.
    const anthropic = preset('anthropic-api-key');
    should(presetLoginRefusal(anthropic, { env: presetDefaultEnv(anthropic), harness: 'codex' })).equal(
      'Anthropic API key does not drive Codex',
    );
  });

  it("should refuse a half that exists but is marked unavailable, with that half's reason", () => {
    const glm = preset('zai-glm');
    should(presetLoginRefusal(glm, { env: presetDefaultEnv(glm), harness: 'codex' })).match(
      /does not drive Codex: Z\.ai serves the Responses API/u,
    );
    should(presetLoginRefusal(glm, { env: presetDefaultEnv(glm), halves: ['codex'] })).match(
      /does not drive Codex: Z\.ai serves the Responses API/u,
    );
  });

  it('should refuse the whole preset when it has no usable half at all', () => {
    // Arrange — every half unavailable rolls up into the preset's own `unavailable` (presetFromFile).
    const file: ProviderPresetFile = {
      label: 'Both down',
      summary: 'Summary.',
      docs: 'https://example.test/docs',
      verified: '2026-10-16',
      unverified: [],
      claude: { env: {}, models: [], unavailable: 'Claude is down.' },
      codex: { env: {}, models: [], unavailable: 'Codex is down.' },
      test: { kind: 'none', reason: 'no test' } as const,
      quota: { source: 'none', note: 'none' } as const,
    };
    const both = presetFromFile('both-down', file, 'file');

    // Act / Assert
    should(presetHarnesses(both)).deepEqual([]);
    should(presetLoginRefusal(both, { env: {} })).equal(
      'Both down is not offered here: Claude is down. Codex is down.',
    );
  });

  it('should narrow a dual login to the one CLI asked for through "halves"', () => {
    const openrouter = preset('openrouter');
    const env = presetDefaultEnv(openrouter);
    should(presetLoginRefusal(openrouter, { env, halves: ['claude'] })).be.undefined();
  });
});

describe('presetFromFile', () => {
  const base = {
    label: 'Test provider',
    summary: 'A provider for the test.',
    docs: 'https://example.test/docs',
    verified: '2026-10-16',
    unverified: [] as string[],
    test: { kind: 'none', reason: 'no test' } as const,
    quota: { source: 'none', note: 'none' } as const,
  };

  /** A plain preset variable with every default field filled in, so a fixture types cleanly. */
  const value = (text: string) => ({ value: text, required: true, allowEmpty: false });

  it('should read the legacy, single-CLI shape to one usable half named "harness"', () => {
    const file: ProviderPresetFile = {
      ...base,
      harness: 'codex',
      env: {},
      codexProvider: { id: 'ollama' },
      models: ['m'],
    };

    const actual = presetFromFile('legacy', file, 'built-in');

    should(actual.harness).equal('codex');
    should(actual.halves).deepEqual({ codex: { env: {}, codexProvider: { id: 'ollama' }, models: ['m'] } });
    should(actual.codexProvider).deepEqual({ id: 'ollama' });
    should(actual.models).deepEqual(['m']);
    should(presetHarnesses(actual)).deepEqual(['codex']);
    should(actual.detect).deepEqual({ hosts: [], variables: [], keyPrefixes: [] });
  });

  it('should pick Claude Code as the primary harness and union both halves’ variables and models', () => {
    const file: ProviderPresetFile = {
      ...base,
      claude: { env: { SHARED: value('claude-wins'), ONLY_CLAUDE: value('c') }, models: ['m1'] },
      codex: { env: { SHARED: value('codex'), ONLY_CODEX: value('x') }, models: ['m2'] },
    };

    const actual = presetFromFile('dual', file, 'file');

    should(actual.harness).equal('claude');
    // The Claude half wins a name both halves set.
    should(actual.env).deepEqual({
      SHARED: value('claude-wins'),
      ONLY_CLAUDE: value('c'),
      ONLY_CODEX: value('x'),
    });
    should(actual.models).deepEqual(['m1', 'm2']);
    should(presetHarnesses(actual)).deepEqual(['claude', 'codex']);
  });

  it('should leave the primary harness Codex-only, and its codexProvider empty, when the Codex half is the only one', () => {
    const file: ProviderPresetFile = {
      ...base,
      claude: { env: {}, models: [], unavailable: 'no claude' },
      codex: { env: {}, models: [], codexProvider: { id: 'ollama' } },
    };

    const actual = presetFromFile('codex-only-half', file, 'file');

    should(actual.harness).equal('codex');
    should(actual.codexProvider).deepEqual({ id: 'ollama' });
    should(presetHarnesses(actual)).deepEqual(['codex']);
  });

  it('should leave codexProvider undefined when Codex is present but not among the usable halves', () => {
    const file: ProviderPresetFile = {
      ...base,
      claude: { env: {}, models: [] },
      codex: { env: {}, models: [], codexProvider: { id: 'ollama' }, unavailable: 'nope' },
    };

    should(presetFromFile('claude-only', file, 'file').codexProvider).be.undefined();
  });

  it('should roll up every half’s reason into "unavailable" when every half is unavailable', () => {
    const file: ProviderPresetFile = {
      ...base,
      claude: { env: {}, models: [], unavailable: 'Claude is down.' },
      codex: { env: {}, models: [], unavailable: 'Codex is down.' },
    };

    const actual = presetFromFile('both-down', file, 'file');

    should(actual.unavailable).equal('Claude is down. Codex is down.');
    should(actual.harness).equal('claude');
    should(presetHarnesses(actual)).deepEqual([]);
  });

  it('should keep an explicit top-level "unavailable" rather than compute one', () => {
    const file: ProviderPresetFile = { ...base, harness: 'claude', env: {}, models: [], unavailable: 'Retired.' };

    should(presetFromFile('retired', file, 'file').unavailable).equal('Retired.');
  });
});

describe('presetHarnesses', () => {
  it('should be empty for a preset marked unavailable even with a usable-looking half', () => {
    should(presetHarnesses({ halves: { claude: { env: {}, models: [] } }, unavailable: 'retired' })).deepEqual([]);
  });
});

describe('ProviderPresetFileSchema — halves checks (docs/provider-presets.md)', () => {
  const base = {
    label: 'Test',
    summary: 'A test preset.',
    docs: 'https://example.test/docs',
    verified: '2026-10-16',
    test: { kind: 'none', reason: 'no test' },
    quota: { source: 'none', note: 'none' },
  } as const;

  it('should refuse a preset naming neither "harness" nor any half', () => {
    const actual = ProviderPresetFileSchema.safeParse({ ...base, env: {} });
    should(actual.error?.issues[0]?.message).match(/say which CLI the preset is for/u);
  });

  it.each(['harness', 'env', 'codexProvider', 'models'] as const)(
    'should refuse top-level "%s" on a preset that has halves',
    field => {
      const extra =
        field === 'harness' ? 'claude' : field === 'codexProvider' ? { id: 'ollama' } : field === 'models' ? ['m'] : {};
      const actual = ProviderPresetFileSchema.safeParse({
        ...base,
        claude: { env: {}, models: [] },
        [field]: extra,
      });
      should(actual.error?.issues[0]?.message).match(
        /belongs inside "claude:" or "codex:" when the preset has halves/u,
      );
    },
  );

  it('should refuse a Codex model provider placed in the "claude:" half', () => {
    const actual = ProviderPresetFileSchema.safeParse({
      ...base,
      claude: { env: {}, models: [], codexProvider: { id: 'ollama' } },
      codex: { env: {}, models: [] },
    });
    should(actual.error?.issues[0]?.message).match(/belongs in "codex:", not "claude:"/u);
  });

  it('should refuse a name that is a secret in one half and a plain value in the other', () => {
    const actual = ProviderPresetFileSchema.safeParse({
      ...base,
      claude: { env: { SHARED: { secretName: 'S' } }, models: [] },
      codex: { env: { SHARED: { value: 'v' } }, models: [] },
    });
    should(actual.error?.issues[0]?.message).match(/SHARED is a secret in one half and a plain value in the other/u);
  });

  it('should refuse a test whose key is not a secret in any half, on a halved preset', () => {
    const actual = ProviderPresetFileSchema.safeParse({
      ...base,
      claude: { env: { ANTHROPIC_BASE_URL: { value: 'https://x.test' } }, models: [] },
      test: { kind: 'request', url: 'https://x.test', keyVariable: 'ANTHROPIC_BASE_URL', note: 'n' },
    });
    should(actual.error?.issues[0]?.message).match(/so "env" must make ANTHROPIC_BASE_URL a secret/u);
  });

  it('should accept a halved preset whose test key is a secret in the codex half', () => {
    const actual = ProviderPresetFileSchema.safeParse({
      ...base,
      claude: { env: {}, models: [] },
      codex: { env: { KEY: { secretName: 'S' } }, models: [], codexProvider: { id: 'ollama' } },
      test: { kind: 'request', url: 'https://x.test', keyVariable: 'KEY', note: 'n' },
    });
    should(actual.success).be.true();
  });

  it('should refuse a detect host, variable and key prefix that are not written as the grammar expects', () => {
    const bad = (detect: Record<string, unknown>) =>
      ProviderPresetFileSchema.safeParse({ ...base, harness: 'claude', env: {}, detect });
    should(bad({ hosts: ['https://not-a-host'] }).error?.issues[0]?.message).match(/write a host name/u);
    should(bad({ variables: ['not a name!'] }).error?.issues[0]?.message).match(/write a variable name/u);
    should(bad({ keyPrefixes: ['x'] }).success).be.false();
  });

  it('should accept a detect block with a host, a variable family and a key prefix', () => {
    const actual = ProviderPresetFileSchema.safeParse({
      ...base,
      harness: 'claude',
      env: {},
      detect: { hosts: ['api.example.com'], variables: ['EXAMPLE_*'], keyPrefixes: ['sk-ex-'] },
    });
    should(actual.success).be.true();
  });
});
