import { describe, it } from 'bun:test';
import should from 'should';
import { INHERITED_HARNESS_ENV, referencedEnvNames, sanitizeHarnessEnv } from '../../src/lib/harness-env.ts';

describe('sanitizeHarnessEnv', () => {
  it('should remove every variable that carries provider identity or session state', () => {
    // Arrange
    const inherited = Object.fromEntries(INHERITED_HARNESS_ENV.map(name => [name, 'placeholder']));

    // Act
    const actual = sanitizeHarnessEnv({ ...inherited, PATH: '/usr/bin', HOME: '/home/somebody' });

    // Assert
    should(actual).deepEqual({ PATH: '/usr/bin', HOME: '/home/somebody' });
  });

  it('should remove per-model default overrides by shape rather than by name', () => {
    // Arrange
    const environment = {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'placeholder',
      ANTHROPIC_DEFAULT_SOMETHING_NEW_MODEL: 'placeholder',
      ANTHROPIC_DEFAULT_SONNET: 'kept — not a model slot',
    };

    // Act
    const actual = sanitizeHarnessEnv(environment);

    // Assert
    should(actual).deepEqual({ ANTHROPIC_DEFAULT_SONNET: 'kept — not a model slot' });
  });

  it('should keep a named variable a wrapper depends on', () => {
    // Act
    const actual = sanitizeHarnessEnv({ OPENAI_API_KEY: 'placeholder', ANTHROPIC_API_KEY: 'placeholder' }, [
      'OPENAI_API_KEY',
    ]);

    // Assert
    should(actual).deepEqual({ OPENAI_API_KEY: 'placeholder' });
  });

  it('should not mutate the environment it was given', () => {
    // Arrange
    const environment = { ANTHROPIC_API_KEY: 'placeholder', PATH: '/usr/bin' };

    // Act
    sanitizeHarnessEnv(environment);

    // Assert
    should(environment).deepEqual({ ANTHROPIC_API_KEY: 'placeholder', PATH: '/usr/bin' });
  });

  it('should preserve a variable explicitly set to undefined rather than dropping the key', () => {
    // Act — an unset-but-present key is how a caller says "this is deliberately empty".
    const actual = sanitizeHarnessEnv({ FY_TEST_MARKER: undefined });

    // Assert
    should(Object.keys(actual)).deepEqual(['FY_TEST_MARKER']);
  });
});

describe('referencedEnvNames', () => {
  it('should report only the variables a wrapper reads from its environment, once each', () => {
    // Arrange — the exact shapes renderWrapperScript emits.
    const script = [
      '#!/bin/sh',
      '# ferretry-managed',
      'export CLAUDE_CONFIG_DIR="$HOME/.claude-work"',
      'export ANTHROPIC_AUTH_TOKEN="${FY_TOKEN}"',
      'export OPENAI_API_KEY="${FY_TOKEN}"',
      "export FY_LITERAL='not-a-reference'",
      'exec claude "$@"',
    ].join('\n');

    // Act
    const actual = referencedEnvNames(script);

    // Assert
    should(actual).deepEqual(['FY_TOKEN']);
  });

  it('should report nothing for a wrapper that references nothing', () => {
    // Act
    const actual = referencedEnvNames('#!/bin/sh\nexec codex "$@"\n');

    // Assert
    should(actual).deepEqual([]);
  });
});
