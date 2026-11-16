import { describe, it } from 'bun:test';
import should from 'should';
import { INHERITED_HARNESS_ENV, sanitizeHarnessEnv } from '../../../daemon/lib/harness-env.ts';

describe('sanitizeHarnessEnv', () => {
  it('should remove every variable that carries provider identity or session state', () => {
    // Arrange
    const inherited = Object.fromEntries(INHERITED_HARNESS_ENV.map(name => [name, 'placeholder']));

    // Act
    const actual = sanitizeHarnessEnv({ ...inherited, PATH: '/usr/bin', HOME: '/home/somebody' });

    // Assert
    should(actual).deepEqual({ PATH: '/usr/bin', HOME: '/home/somebody' });
  });

  it('should remove an inherited Claude secure-storage pointer, the empty string included', () => {
    // Act — "" is a value (the person's own login), so it is stripped like any other.
    const actual = sanitizeHarnessEnv({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '', PATH: '/usr/bin' });

    // Assert
    should(actual).deepEqual({ PATH: '/usr/bin' });
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
