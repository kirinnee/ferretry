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
import { credentialFromPreset, presetDefaultEnv, presetLoginRefusal } from '../../src/lib/presets/login.ts';
import { PresetVariableSchema, type ProviderPreset, ProviderPresetFileSchema } from '../../src/lib/presets/schema.ts';

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

  it('should hide a Codex preset that cannot run, with the reason', () => {
    // Act
    const glm = preset('zai-glm-codex');

    // Assert
    should(glm.unavailable).match(/model catalogue file/u);
    should(presetLoginRefusal(glm, { env: presetDefaultEnv(glm) })).match(/is not offered here/u);
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
    const read = readConfigText(BUILT_IN_PRESET_TEXTS.kimi as string);
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
    const openrouter = preset('openrouter');
    const env = presetDefaultEnv(openrouter);
    should(presetLoginRefusal(openrouter, { env })).be.undefined();
    should(credentialFromPreset(openrouter, { env }).env).containDeep({ ANTHROPIC_API_KEY: '' });
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

  it('should give a Codex login its preset’s model provider', () => {
    const openrouter = preset('openrouter-codex');
    should(credentialFromPreset(openrouter, { env: presetDefaultEnv(openrouter) }).codexProvider).containDeep({
      id: 'openrouter',
      keyVariable: 'OPENROUTER_API_KEY',
    });
  });

  it('should make a login with no variables at all from a preset that has none', () => {
    const ollama = preset('ollama-codex');
    should(credentialFromPreset(ollama, { env: {} })).not.have.property('env');
  });
});
