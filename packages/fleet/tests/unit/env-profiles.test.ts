/**
 * Secret-backed launch environment.
 *
 * The claims under test are the ones `docs/secrets.md` makes: a value is resolved once into one launch
 * and is never returned by anything else, a missing secret refuses rather than resolving to nothing,
 * and the listing that says where a secret is named answers in names and never in values.
 *
 * NO REAL CREDENTIAL APPEARS HERE. Every "value" is a fixture string, and the assertions are about
 * where a value goes rather than what it is.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { parseAccountModel } from '../../src/lib/account/schema.ts';
import {
  accountSecretReferences,
  MissingFleetSecretsError,
  resolveSecretEnvironment,
  secretEnvBindings,
} from '../../src/lib/env-profiles.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';

describe('secretEnvBindings', () => {
  it('should report only the variables that name a secret, sorted so a re-render is byte-identical', () => {
    // Arrange
    const env = {
      ZZ_LAST: '${secret:LAST_KEY}',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      ANTHROPIC_API_KEY: '${secret:WORK_KEY}',
    };

    // Act
    const actual = secretEnvBindings(env);

    // Assert
    should(actual).deepEqual([
      { variable: 'ANTHROPIC_API_KEY', secrets: ['WORK_KEY'] },
      { variable: 'ZZ_LAST', secrets: ['LAST_KEY'] },
    ]);
  });

  it('should report every secret one composed value names, in first-appearance order', () => {
    // Arrange
    const env = { AUTH_HEADER: '${secret:SCHEME} ${secret:WORK_KEY} ${secret:SCHEME}' };

    // Act
    const actual = secretEnvBindings(env);

    // Assert
    should(actual).deepEqual([{ variable: 'AUTH_HEADER', secrets: ['SCHEME', 'WORK_KEY'] }]);
  });

  it('should report nothing for an account that binds no secret, which is the default case', () => {
    // Act
    const actual = secretEnvBindings({ ANTHROPIC_BASE_URL: 'https://example.invalid', TOKEN: '$OUTER' });

    // Assert
    should(actual).deepEqual([]);
  });
});

describe('resolveSecretEnvironment', () => {
  it('should resolve a whole-value reference into the one map a launch is given', () => {
    // Arrange
    const account = { id: ID_ONE, env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } };

    // Act
    const actual = resolveSecretEnvironment(account, new Map([['WORK_KEY', 'fixture-value']]));

    // Assert
    should(actual).deepEqual({ ANTHROPIC_API_KEY: 'fixture-value' });
  });

  it('should compose a value that surrounds a reference with text', () => {
    // Arrange
    const account = { id: ID_ONE, env: { AUTH_HEADER: 'Bearer ${secret:WORK_KEY}' } };

    // Act
    const actual = resolveSecretEnvironment(account, new Map([['WORK_KEY', 'fixture-value']]));

    // Assert
    should(actual).deepEqual({ AUTH_HEADER: 'Bearer fixture-value' });
  });

  it('should leave literal variables alone, because the wrapper already exports those itself', () => {
    // Arrange
    const account = {
      id: ID_ONE,
      env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}', ANTHROPIC_BASE_URL: 'https://example.invalid' },
    };

    // Act
    const actual = resolveSecretEnvironment(account, new Map([['WORK_KEY', 'fixture-value']]));

    // Assert
    should(actual).have.property('ANTHROPIC_API_KEY');
    should(actual).not.have.property('ANTHROPIC_BASE_URL');
  });

  it('should refuse naming EVERY missing secret rather than the first', () => {
    // Arrange
    const account = { id: ID_ONE, env: { A_KEY: '${secret:ONE}', B_KEY: '${secret:TWO} ${secret:ONE}' } };

    // Act
    let raised: unknown;
    try {
      resolveSecretEnvironment(account, new Map());
    } catch (error) {
      raised = error;
    }

    // Assert
    should(raised).be.instanceof(MissingFleetSecretsError);
    should((raised as MissingFleetSecretsError).names).deepEqual(['ONE', 'TWO']);
    should((raised as MissingFleetSecretsError).message).match(/ONE, TWO/u);
  });

  it('should answer an empty environment for an account that binds nothing, without needing a value', () => {
    // Act
    const actual = resolveSecretEnvironment(
      { id: ID_ONE, env: { ANTHROPIC_BASE_URL: 'https://x.invalid' } },
      new Map(),
    );

    // Assert
    should(actual).deepEqual({});
  });
});

describe('accountSecretReferences', () => {
  it('should name every secret a credential, a settings component and an MCP server reach for', () => {
    // Arrange
    const model = parseAccountModel({
      version: 2,
      machine: {},
      credentials: {
        'claude-key': { harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } },
        'claude-you': { harness: 'claude', store: 'host' },
      },
      components: {
        settings: {
          'claude-main': { harness: 'claude', env: { AUTH: '${secret:SCHEME} ${secret:WORK_KEY}', PLAIN: 'x' } },
          'claude-flags': { harness: 'claude', flags: ['--verbose'] },
        },
        mcp: {
          github: { command: 'gh-mcp', env: { GITHUB_TOKEN: '${secret:GH_TOKEN}' } },
          docs: { url: 'https://example.invalid/mcp' },
        },
      },
    });

    // Act
    const actual = accountSecretReferences(model);

    // Assert — duplicates are kept: two places naming one secret are two facts.
    should(actual).deepEqual([
      { name: 'WORK_KEY', origin: 'credential claude-key env ANTHROPIC_API_KEY' },
      { name: 'SCHEME', origin: 'settings/claude-main env AUTH' },
      { name: 'WORK_KEY', origin: 'settings/claude-main env AUTH' },
      { name: 'GH_TOKEN', origin: 'mcp/github env GITHUB_TOKEN' },
    ]);
  });

  it('should name nothing for a configuration that names no secret', () => {
    should(accountSecretReferences(parseAccountModel({ version: 2, machine: {} }))).deepEqual([]);
  });
});
