import { describe, it } from 'bun:test';
import type { FleetPresetVariable, FleetProviderPresetView } from '@ferretry/protocol';
import should from 'should';
import {
  presetDefaultEnv,
  presetRequiredPlainGaps,
  presetSecretsNeeded,
  secretFromShell,
  withShellPlainValues,
} from '../../../src/lib/credential/provider-env.ts';

const variable = (overrides: Record<string, unknown>): FleetPresetVariable =>
  ({ required: true, allowEmpty: false, ...overrides }) as FleetPresetVariable;

const DUAL: FleetProviderPresetView = {
  id: 'deepseek',
  label: 'DeepSeek',
  harness: 'claude',
  summary: 'Claude Code and Codex on DeepSeek models.',
  docs: 'https://api-docs.deepseek.com',
  origin: 'built-in',
  variables: [
    variable({
      name: 'ANTHROPIC_BASE_URL',
      kind: 'plain',
      value: 'https://api.deepseek.com/anthropic',
      harnesses: ['claude'],
    }),
    variable({ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'DEEPSEEK_API_KEY', harnesses: ['claude'] }),
    variable({ name: 'DEEPSEEK_API_KEY', kind: 'secret', secret: 'DEEPSEEK_API_KEY', harnesses: ['codex'] }),
  ],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Lists the models the key can use.' },
  quota: { source: 'deepseek-balance', note: 'Your DeepSeek balance.' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
};

const AZURE: FleetProviderPresetView = {
  id: 'azure-openai',
  label: 'Azure OpenAI',
  harness: 'codex',
  summary: 'Codex on your Azure OpenAI resource.',
  docs: 'https://learn.microsoft.com/azure',
  origin: 'built-in',
  variables: [
    variable({ name: 'AZURE_OPENAI_RESOURCE', kind: 'plain', value: '', description: 'the resource name' }),
    variable({ name: 'AZURE_OPENAI_API_KEY', kind: 'secret', secret: 'AZURE_OPENAI_API_KEY' }),
    variable({ name: 'AZURE_OPTIONAL', kind: 'plain', value: '', required: false }),
    variable({ name: 'AZURE_DELIBERATE_EMPTY', kind: 'plain', value: '', required: true, allowEmpty: true }),
  ],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Lists the models on your resource.' },
  quota: { source: 'transcript-pricing', note: 'Azure reports quota in the portal only.' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
};

describe('presetDefaultEnv', () => {
  it('should fill a plain variable with its default and a secret with a reference', () => {
    should(presetDefaultEnv(AZURE, ['codex'])).eql({
      AZURE_OPENAI_RESOURCE: '',
      AZURE_OPENAI_API_KEY: '${secret:AZURE_OPENAI_API_KEY}',
      AZURE_OPTIONAL: '',
      AZURE_DELIBERATE_EMPTY: '',
    });
  });

  it('should keep only the variables the given halves set, for a dual preset', () => {
    should(presetDefaultEnv(DUAL, ['claude'])).eql({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '${secret:DEEPSEEK_API_KEY}',
    });
    should(presetDefaultEnv(DUAL, ['claude', 'codex'])).eql({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '${secret:DEEPSEEK_API_KEY}',
      DEEPSEEK_API_KEY: '${secret:DEEPSEEK_API_KEY}',
    });
  });
});

describe('presetSecretsNeeded', () => {
  it('should group every variable of a secret under its one suggested NAME', () => {
    should(presetSecretsNeeded(DUAL, ['claude', 'codex'])).eql([
      { name: 'DEEPSEEK_API_KEY', variables: ['ANTHROPIC_AUTH_TOKEN', 'DEEPSEEK_API_KEY'] },
    ]);
    should(presetSecretsNeeded(DUAL, ['claude'])).eql([
      { name: 'DEEPSEEK_API_KEY', variables: ['ANTHROPIC_AUTH_TOKEN'] },
    ]);
  });

  it('should fall back to the variable name when a secret names none of its own', () => {
    const noSecretName = { ...AZURE, variables: [variable({ name: 'LONE_KEY', kind: 'secret' })] };
    should(presetSecretsNeeded(noSecretName, ['codex'])).eql([{ name: 'LONE_KEY', variables: ['LONE_KEY'] }]);
  });

  it('should need nothing from a preset with no secret variables', () => {
    should(presetSecretsNeeded({ ...AZURE, variables: [] }, ['codex'])).eql([]);
  });
});

describe('withShellPlainValues', () => {
  it('should take a plain variable from the shell wherever the preset declares it and it is non-empty', () => {
    const env = presetDefaultEnv(DUAL, ['claude']);
    should(
      withShellPlainValues(DUAL, ['claude'], env, { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/v2/anthropic' }),
    ).eql({
      ...env,
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/v2/anthropic',
    });
  });

  it('should never take a secret variable from the shell as a plain value', () => {
    const env = presetDefaultEnv(DUAL, ['claude']);
    should(withShellPlainValues(DUAL, ['claude'], env, { ANTHROPIC_AUTH_TOKEN: 'raw-value' })).eql(env);
  });

  it('should ignore an empty shell value and keep the default', () => {
    const env = presetDefaultEnv(DUAL, ['claude']);
    should(withShellPlainValues(DUAL, ['claude'], env, { ANTHROPIC_BASE_URL: '' })).eql(env);
  });
});

describe('presetRequiredPlainGaps', () => {
  it('should name a required plain variable the given env still leaves empty', () => {
    const gaps = presetRequiredPlainGaps(AZURE, ['codex'], presetDefaultEnv(AZURE, ['codex']));
    should(gaps.map(gap => gap.name)).eql(['AZURE_OPENAI_RESOURCE']);
  });

  it('should skip an optional empty variable, and one deliberately left empty', () => {
    const env = presetDefaultEnv(AZURE, ['codex']);
    const gaps = presetRequiredPlainGaps(AZURE, ['codex'], { ...env, AZURE_OPENAI_RESOURCE: 'filled' });
    should(gaps).eql([]);
  });

  it('should never name a secret variable, however empty its value reads', () => {
    const onlySecret = { ...AZURE, variables: [variable({ name: 'K', kind: 'secret' })] };
    should(presetRequiredPlainGaps(onlySecret, ['codex'], {})).eql([]);
  });
});

describe('secretFromShell', () => {
  it('should read the first of a secret’s variables the shell carries a non-empty value for', () => {
    const need = { name: 'DEEPSEEK_API_KEY', variables: ['ANTHROPIC_AUTH_TOKEN', 'DEEPSEEK_API_KEY'] };
    should(secretFromShell(need, { DEEPSEEK_API_KEY: 'sk-live' })).equal('sk-live');
    should(secretFromShell(need, { ANTHROPIC_AUTH_TOKEN: 'sk-other', DEEPSEEK_API_KEY: 'sk-live' })).equal('sk-other');
  });

  it('should return undefined when the shell carries none of its variables, or only an empty one', () => {
    const need = { name: 'DEEPSEEK_API_KEY', variables: ['ANTHROPIC_AUTH_TOKEN', 'DEEPSEEK_API_KEY'] };
    should(secretFromShell(need, {})).be.undefined();
    should(secretFromShell(need, { DEEPSEEK_API_KEY: '' })).be.undefined();
  });
});
