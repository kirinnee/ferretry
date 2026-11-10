import { describe, it } from 'bun:test';
import { readConfigText } from '@ferretry/std/yaml';
import should from 'should';
import {
  PresetVariableSchema,
  type ProviderPresetFile,
  ProviderPresetFileSchema,
  presetFromFile,
  presetHarnesses,
} from '../../../daemon/lib/presets/schema.ts';
import { BUILT_IN_PRESET_TEXTS } from './fixtures/built-ins.ts';

// How a preset FILE is checked and read into a preset (daemon/lib/presets/schema.ts). The catalogue
// itself — which presets a machine offers, and a login made from one — is Logins' own.

describe('ProviderPresetFileSchema', () => {
  it('should refuse a variable that is both a value and a secret, or neither', () => {
    should(PresetVariableSchema.safeParse({ value: 'a', secretName: 'A' }).success).be.false();
    should(PresetVariableSchema.safeParse({}).success).be.false();
  });

  it('should refuse a Codex provider on a Claude Code preset', () => {
    // amazon-bedrock is a single-harness (claude) preset: no halves to route it through.
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

  it('should read the single-CLI shape to one usable half named "harness"', () => {
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
