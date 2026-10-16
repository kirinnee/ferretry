import { describe, it } from 'bun:test';
import should from 'should';
import { type DetectablePreset, detectProvider, parseVariableBlock } from '../../src/lib/presets/detect.ts';

const TABLE: readonly DetectablePreset[] = [
  {
    id: 'anthropic-api-key',
    detect: { hosts: ['api.anthropic.com'], variables: [], keyPrefixes: ['sk-ant-api'] },
  },
  {
    id: 'deepseek',
    detect: { hosts: ['api.deepseek.com'], variables: ['DEEPSEEK_*'], keyPrefixes: [] },
  },
  {
    id: 'amazon-bedrock',
    detect: { hosts: [], variables: ['CLAUDE_CODE_USE_BEDROCK'], keyPrefixes: [] },
  },
  {
    id: 'openrouter',
    detect: { hosts: ['openrouter.ai'], variables: ['OPENROUTER_*'], keyPrefixes: ['sk-or-'] },
  },
];

describe('detectProvider', () => {
  it('should find a host clue through a subdomain, naming the host as the preset wrote it', () => {
    // Act
    const actual = detectProvider(TABLE, { ANTHROPIC_BASE_URL: 'https://eu.api.anthropic.com/v1' });

    // Assert
    should(actual.preset).equal('anthropic-api-key');
    should(actual.clues).deepEqual([{ kind: 'host', variable: 'ANTHROPIC_BASE_URL', host: 'api.anthropic.com' }]);
  });

  it('should find every variable of a PREFIX_* family', () => {
    // Act
    const actual = detectProvider(TABLE, { DEEPSEEK_API_KEY: 'x', DEEPSEEK_MODEL: 'deepseek-flash' });

    // Assert
    should(actual.preset).equal('deepseek');
    should(actual.clues.map(clue => clue.variable).toSorted()).deepEqual(['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL']);
    should(actual.clues.every(clue => clue.kind === 'variable')).be.true();
  });

  it('should check a key prefix only on a variable named KEY, TOKEN or SECRET', () => {
    // Act — the value carries the prefix either way; only the TOKEN-named one counts
    const named = detectProvider(TABLE, { ANTHROPIC_AUTH_TOKEN: 'sk-ant-api-abc123' });
    const unnamed = detectProvider(TABLE, { ANTHROPIC_AUTH_VALUE: 'sk-ant-api-abc123' });

    // Assert
    should(named.clues).deepEqual([{ kind: 'key-prefix', variable: 'ANTHROPIC_AUTH_TOKEN' }]);
    should(unnamed.preset).be.undefined();
  });

  it('should break a tie by catalogue order, naming the rest in "alsoMatched"', () => {
    // Arrange — two single "variable" clues (same weight), amazon-bedrock listed before openrouter;
    // the key value deliberately does not carry openrouter's key prefix, so the clues really tie.
    const env = { CLAUDE_CODE_USE_BEDROCK: '1', OPENROUTER_API_KEY: 'not-the-documented-prefix' };

    // Act
    const actual = detectProvider(TABLE, env);

    // Assert
    should(actual.preset).equal('amazon-bedrock');
    should(actual.alsoMatched).deepEqual(['openrouter']);
  });

  it('should answer "no preset" for an unknown gateway, still naming what it recognised', () => {
    // Act
    const actual = detectProvider(TABLE, { CUSTOM_BASE_URL: 'https://gateway.example.test', CUSTOM_API_KEY: 'xyz' });

    // Assert
    should(actual.preset).be.undefined();
    should(actual.clues).deepEqual([]);
    should(actual.alsoMatched).deepEqual([]);
    should(actual.recognised).deepEqual(['CUSTOM_BASE_URL', 'CUSTOM_API_KEY']);
    should(actual.harnesses).deepEqual([]);
  });

  it('should read which CLIs the variable names speak to, Claude Code first', () => {
    // Act
    const both = detectProvider(TABLE, { ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' });
    const claudeOnly = detectProvider(TABLE, { CLAUDE_CODE_USE_BEDROCK: '1' });
    const neither = detectProvider(TABLE, {});

    // Assert
    should(both.harnesses).deepEqual(['claude', 'codex']);
    should(claudeOnly.harnesses).deepEqual(['claude']);
    should(neither.harnesses).deepEqual([]);
  });

  it('should never let a URL’s user or password reach the result', () => {
    // Act
    const actual = detectProvider(TABLE, { ANTHROPIC_BASE_URL: 'https://a-user:a-password@api.anthropic.com/v1' });

    // Assert
    should(actual.clues).deepEqual([{ kind: 'host', variable: 'ANTHROPIC_BASE_URL', host: 'api.anthropic.com' }]);
    should(JSON.stringify(actual)).not.containEql('a-user');
    should(JSON.stringify(actual)).not.containEql('a-password');
  });

  it('should never let a key’s value reach the result', () => {
    // Act
    const actual = detectProvider(TABLE, { ANTHROPIC_AUTH_TOKEN: 'sk-ant-api-super-secret-value' });

    // Assert
    should(actual.clues).deepEqual([{ kind: 'key-prefix', variable: 'ANTHROPIC_AUTH_TOKEN' }]);
    should(JSON.stringify(actual)).not.containEql('super-secret-value');
  });

  it('should ignore a non-URL value under a name that looks like an address', () => {
    // Act
    const actual = detectProvider(TABLE, { ANTHROPIC_BASE_URL: 'not a url' });

    // Assert
    should(actual.preset).be.undefined();
    should(actual.recognised).deepEqual(['ANTHROPIC_BASE_URL']);
  });

  it('should ignore a scheme that is neither http nor https', () => {
    // Act
    const actual = detectProvider(TABLE, { ANTHROPIC_BASE_URL: 'ftp://api.anthropic.com' });

    // Assert
    should(actual.clues).deepEqual([]);
  });
});

describe('parseVariableBlock', () => {
  it('should read a plain and an exported shell assignment', () => {
    should(parseVariableBlock('ANTHROPIC_API_KEY=sk-123\nexport OTHER=abc\n')).deepEqual({
      ANTHROPIC_API_KEY: 'sk-123',
      OTHER: 'abc',
    });
  });

  it('should strip double and single quotes, and a trailing comment', () => {
    should(parseVariableBlock(['A="double"', "B='single'", 'C=bare # a trailing comment', ''].join('\n'))).deepEqual({
      A: 'double',
      B: 'single',
      C: 'bare',
    });
  });

  it('should skip a blank line and a full-line comment', () => {
    should(parseVariableBlock('# a comment\n\nA=1\n')).deepEqual({ A: '1' });
  });

  it('should read a YAML-style "NAME: value" line', () => {
    should(parseVariableBlock('ANTHROPIC_BASE_URL: https://api.example.com\n')).deepEqual({
      ANTHROPIC_BASE_URL: 'https://api.example.com',
    });
  });

  it('should read a Codex TOML model_providers table as dotted names', () => {
    const toml = [
      '[model_providers.ollama]',
      'base_url = "http://localhost:11434/v1"',
      'env_key = "OLLAMA_API_KEY"',
      '',
    ].join('\n');

    should(parseVariableBlock(toml)).deepEqual({
      'model_providers.ollama.base_url': 'http://localhost:11434/v1',
      'model_providers.ollama.env_key': 'OLLAMA_API_KEY',
    });
  });

  it('should leave a non-model_providers TOML table as plain assignments, not a dotted name', () => {
    should(parseVariableBlock('[other]\nfoo = "bar"\n')).deepEqual({ foo: 'bar' });
  });

  it('should let a later line win over an earlier one', () => {
    should(parseVariableBlock('A=first\nA=second\n')).deepEqual({ A: 'second' });
  });
});
