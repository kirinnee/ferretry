import { describe, it } from 'bun:test';
import { secretReference } from '@ferretry/core-vault/contract';
import should from 'should';
import { builtInPresets } from '../../../daemon/lib/presets/catalog.ts';
import { credentialFromPreset, presetLoginRefusal } from '../../../daemon/lib/presets/login.ts';
import { type ProviderPreset, presetFromFile, presetHarnesses } from '../../../daemon/lib/presets/schema.ts';
import { credentialIssues } from '../../../daemon/lib/shared/credential.ts';
import { filledEnv, presetDefaultEnv } from '../../support/preset-env.ts';

const PRESETS = builtInPresets();
const preset = (id: string): ProviderPreset => PRESETS.find(entry => entry.id === id) as ProviderPreset;

describe('a login from a preset', () => {
  it.each(PRESETS.filter(entry => entry.unavailable === undefined).map(entry => entry.id))(
    'should make a login from %s that the login rules accept',
    id => {
      const entry = preset(id);
      const input = {
        env: filledEnv(entry),
        ...(entry.cloudCredential === undefined ? {} : { cloudCredential: entry.cloudCredential.suggested }),
      };
      should(presetLoginRefusal(entry, input)).be.undefined();
      should(credentialIssues(credentialFromPreset(entry, input))).deepEqual([]);
    },
  );

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
    should(presetLoginRefusal(openrouter, { env, halves: ['claude'] })).be.undefined();
    should(credentialFromPreset(openrouter, { env, halves: ['claude'] }).env).containDeep({ ANTHROPIC_API_KEY: '' });
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

  it('should give a Codex login its preset model provider, on its codex half', () => {
    const openrouter = preset('openrouter');
    const credential = credentialFromPreset(openrouter, { env: presetDefaultEnv(openrouter) });
    should(credential.codex?.codexProvider).containDeep({ id: 'openrouter', keyVariable: 'OPENROUTER_API_KEY' });
    should(credentialIssues(credential)).deepEqual([]);
  });

  it('should give a one-CLI Codex login from a dual preset its model provider at the top level', () => {
    const openrouter = preset('openrouter');
    const env = { OPENROUTER_API_KEY: secretReference('OPENROUTER_API_KEY') };
    const credential = credentialFromPreset(openrouter, { env, halves: ['codex'], harness: 'codex' });
    should(credential).containDeep({ harness: 'codex' });
    should(credential.codexProvider).containDeep({ id: 'openrouter', keyVariable: 'OPENROUTER_API_KEY' });
    should(credential).not.have.property('claude');
    should(credential).not.have.property('codex');
    should(credentialIssues(credential)).deepEqual([]);
  });

  it('should make a login with no variables at all from a preset that has none', () => {
    should(credentialFromPreset(preset('ollama-codex'), { env: {} })).not.have.property('env');
  });

  it('should drive both CLIs with one secret from a dual preset, an unknown extra variable going to the shared env', () => {
    const deepseek = preset('deepseek');
    const env = { ...presetDefaultEnv(deepseek), FUTURE_VARIABLE: 'kept' };

    should(presetLoginRefusal(deepseek, { env })).be.undefined();
    const credential = credentialFromPreset(deepseek, { env });

    should(credential.harness).equal('claude');
    should(credential.claude?.env).containDeep({ ANTHROPIC_AUTH_TOKEN: secretReference('DEEPSEEK_API_KEY') });
    should(credential.codex?.env).containDeep({ DEEPSEEK_API_KEY: secretReference('DEEPSEEK_API_KEY') });
    should(credential.env).deepEqual({ FUTURE_VARIABLE: 'kept' });
    should(credentialIssues(credential)).deepEqual([]);
  });
});

describe('presetLoginRefusal — halves (docs/provider-presets.md § One login, both CLIs)', () => {
  it('should refuse a half the preset does not offer at all, without a reason', () => {
    const anthropic = preset('anthropic-api-key');
    should(presetLoginRefusal(anthropic, { env: presetDefaultEnv(anthropic), harness: 'codex' })).equal(
      'Anthropic API key does not drive Codex',
    );
  });

  it("should refuse a half that exists but is marked unavailable, with that half's reason", () => {
    const glm = preset('zai-glm');
    should(presetLoginRefusal(glm, { env: presetDefaultEnv(glm), harness: 'codex' })).match(/does not drive Codex: /u);
    should(presetLoginRefusal(glm, { env: presetDefaultEnv(glm), halves: ['codex'] })).match(/does not drive Codex: /u);
  });

  it('should refuse the whole preset when it has no usable half at all', () => {
    const both = presetFromFile(
      'both-down',
      {
        label: 'Both down',
        summary: 'Summary.',
        docs: 'https://example.test/docs',
        verified: '2026-10-16',
        unverified: [],
        claude: { env: {}, models: [], unavailable: 'Claude is down.' },
        codex: { env: {}, models: [], unavailable: 'Codex is down.' },
        test: { kind: 'none', reason: 'no test' },
        quota: { source: 'none', note: 'none' },
      } as never,
      'file',
    );

    should(presetHarnesses(both)).deepEqual([]);
    should(presetLoginRefusal(both, { env: {} })).equal(
      'Both down is not offered here: Claude is down. Codex is down.',
    );
  });

  it('should narrow a dual login to the one CLI asked for through "halves"', () => {
    const openrouter = preset('openrouter');
    should(presetLoginRefusal(openrouter, { env: presetDefaultEnv(openrouter), halves: ['claude'] })).be.undefined();
  });
});
