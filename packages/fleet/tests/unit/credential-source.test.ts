import { describe, it } from 'bun:test';
import should from 'should';
import { type FleetConfig, FleetConfigSchema } from '../../src/lib/config.ts';
import {
  credentialSourceOf,
  decideLoginApplicability,
  type FleetCredentialSource,
  HARNESS_CREDENTIAL_ENV,
} from '../../src/lib/credential-source.ts';
import type { HarnessLoginDeclarations } from '../../src/lib/harness-login.ts';
import { resolveAccounts, type ResolvedAccount } from '../../src/lib/profiles.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';

/** Parse rather than hand-build, so every case runs against configuration a person could write. */
const parse = (input: Record<string, unknown>): FleetConfig => {
  const parsed = FleetConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`fixture is not valid configuration: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  return parsed.data;
};

interface AccountFixture {
  readonly kind?: 'claude' | 'codex';
  readonly auth?: 'oauth' | 'api-key';
  readonly env?: Record<string, string>;
  readonly secretsFile?: string;
}

/** One resolved account, from real configuration, plus the fleet's declared secrets file. */
const resolved = (fixture: AccountFixture = {}): { account: ResolvedAccount; secretsFile?: string } => {
  const config = parse({
    ...(fixture.secretsFile === undefined ? {} : { secretsFile: fixture.secretsFile }),
    agents: [
      {
        name: 'kirin',
        kind: fixture.kind ?? 'claude',
        ...(fixture.auth === undefined ? {} : { auth: fixture.auth }),
        ...(fixture.env === undefined ? {} : { env: fixture.env }),
        routes: {
          default: {
            id: ID_ONE,
            wrapper: 'claude-kirin',
            home: 'claude-kirin',
            defaultModel: 'model-one',
            models: ['model-one'],
          },
        },
      },
    ],
  });
  const account = resolveAccounts(config)[0];
  if (account === undefined) throw new Error('fixture produced no account');
  return { account, ...(config.secretsFile === undefined ? {} : { secretsFile: config.secretsFile }) };
};

const sourceOf = (fixture: AccountFixture = {}): FleetCredentialSource => {
  const { account, secretsFile } = resolved(fixture);
  return credentialSourceOf(account, secretsFile);
};

const BOTH_LOG_IN: HarnessLoginDeclarations = { claude: { login: true }, codex: { login: true } };
const CLAUDE_HAS_NO_LOGIN: HarnessLoginDeclarations = {
  claude: { login: false, reason: 'this harness has no interactive login' },
  codex: { login: true },
};

describe('HARNESS_CREDENTIAL_ENV', () => {
  it('should declare credential variables for every harness kind', () => {
    // Act
    const actual = Object.keys(HARNESS_CREDENTIAL_ENV).sort();

    // Assert
    should(actual).deepEqual(['claude', 'codex']);
  });

  it('should not treat a base URL as a credential', () => {
    // Act
    const actual = Object.values(HARNESS_CREDENTIAL_ENV).flat();

    // Assert
    should(actual).not.containEql('ANTHROPIC_BASE_URL');
    should(actual).not.containEql('OPENAI_BASE_URL');
  });
});

describe('credentialSourceOf', () => {
  it('should report an interactive login when nothing declares a credential', () => {
    // Act
    const actual = sourceOf();

    // Assert
    should(actual).deepEqual({ source: 'interactive-login' });
  });

  it('should still report an interactive login when only a base URL is declared', () => {
    // Act
    const actual = sourceOf({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example' } });

    // Assert
    should(actual).deepEqual({ source: 'interactive-login' });
  });

  it('should report a token file when a reference resolves through the declared secrets file', () => {
    // Act
    const actual = sourceOf({ env: { ANTHROPIC_API_KEY: '$KIRIN_KEY' }, secretsFile: '/etc/ferretry/secrets.sh' });

    // Assert
    should(actual).deepEqual({
      source: 'token-file',
      variable: 'ANTHROPIC_API_KEY',
      path: '/etc/ferretry/secrets.sh',
    });
  });

  it('should read a braced reference as a reference too', () => {
    // Act
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the braced form is the CONFIGURATION grammar
    const actual = sourceOf({ env: { ANTHROPIC_API_KEY: '${KIRIN_KEY}' }, secretsFile: '/etc/secrets.sh' });

    // Assert
    should(actual).have.property('source', 'token-file');
  });

  it('should report the environment when a reference has no secrets file to resolve through', () => {
    // Act
    const actual = sourceOf({ env: { ANTHROPIC_API_KEY: '$KIRIN_KEY' } });

    // Assert
    should(actual).deepEqual({ source: 'environment', variable: 'ANTHROPIC_API_KEY' });
  });

  it('should report a configured value when the configuration carries the credential itself', () => {
    // Act
    const actual = sourceOf({ env: { ANTHROPIC_API_KEY: 'sk-literal' }, secretsFile: '/etc/secrets.sh' });

    // Assert
    should(actual).deepEqual({ source: 'configured-value', variable: 'ANTHROPIC_API_KEY' });
  });

  it('should treat a partial reference as a literal, exactly as the wrapper renderer does', () => {
    // Act
    const actual = sourceOf({ env: { ANTHROPIC_API_KEY: 'prefix-$KIRIN_KEY' } });

    // Assert
    should(actual).deepEqual({ source: 'configured-value', variable: 'ANTHROPIC_API_KEY' });
  });

  it('should recognise an auth token as a credential, not only an API key', () => {
    // Act
    const actual = sourceOf({ env: { ANTHROPIC_AUTH_TOKEN: '$TOKEN' } });

    // Assert
    should(actual).deepEqual({ source: 'environment', variable: 'ANTHROPIC_AUTH_TOKEN' });
  });

  it('should read the Codex credential variable for a Codex account', () => {
    // Act
    const actual = sourceOf({ kind: 'codex', env: { OPENAI_API_KEY: '$OPENAI_API_KEY' } });

    // Assert
    should(actual).deepEqual({ source: 'environment', variable: 'OPENAI_API_KEY' });
  });

  it('should ignore another harness’s credential variable', () => {
    // Act
    const actual = sourceOf({ kind: 'codex', env: { ANTHROPIC_API_KEY: '$KIRIN_KEY' } });

    // Assert
    should(actual).deepEqual({ source: 'interactive-login' });
  });

  it('should pick the first declared variable in the harness’s own order', () => {
    // Act
    const actual = sourceOf({ env: { CLAUDE_CODE_OAUTH_TOKEN: '$LATER', ANTHROPIC_API_KEY: '$FIRST' } });

    // Assert
    should(actual).deepEqual({ source: 'environment', variable: 'ANTHROPIC_API_KEY' });
  });

  it('should report an undeclared source for an API-key account that says nowhere the key comes from', () => {
    // Act
    const actual = sourceOf({ auth: 'api-key' });

    // Assert
    should(actual).deepEqual({ source: 'undeclared' });
  });

  it('should name the file for an API-key account whose key comes from the secrets file', () => {
    // Act
    const actual = sourceOf({
      auth: 'api-key',
      env: { ANTHROPIC_API_KEY: '$KIRIN_KEY' },
      secretsFile: '/etc/secrets.sh',
    });

    // Assert
    should(actual).deepEqual({ source: 'token-file', variable: 'ANTHROPIC_API_KEY', path: '/etc/secrets.sh' });
  });
});

describe('decideLoginApplicability', () => {
  it('should apply a login when the credential comes from one', () => {
    // Act
    const actual = decideLoginApplicability('claude', { source: 'interactive-login' }, BOTH_LOG_IN);

    // Assert
    should(actual).deepEqual({ applies: true });
  });

  it('should refuse a login when the credential comes from a token file', () => {
    // Act
    const actual = decideLoginApplicability(
      'claude',
      { source: 'token-file', variable: 'ANTHROPIC_API_KEY', path: '/etc/secrets.sh' },
      BOTH_LOG_IN,
    );

    // Assert
    should(actual).deepEqual({ applies: false, because: 'credential-is-not-a-login' });
  });

  it('should refuse a login when the credential comes from the environment', () => {
    // Act
    const actual = decideLoginApplicability(
      'codex',
      { source: 'environment', variable: 'OPENAI_API_KEY' },
      BOTH_LOG_IN,
    );

    // Assert
    should(actual).deepEqual({ applies: false, because: 'credential-is-not-a-login' });
  });

  it('should refuse a login when the configuration carries the credential', () => {
    // Act
    const actual = decideLoginApplicability(
      'claude',
      { source: 'configured-value', variable: 'ANTHROPIC_API_KEY' },
      BOTH_LOG_IN,
    );

    // Assert
    should(actual).have.property('because', 'credential-is-not-a-login');
  });

  it('should refuse a login when nothing declares where the credential comes from', () => {
    // Act
    const actual = decideLoginApplicability('claude', { source: 'undeclared' }, BOTH_LOG_IN);

    // Assert
    should(actual).have.property('because', 'credential-is-not-a-login');
  });

  it('should refuse a login for a harness that declares none, whatever the credential source is', () => {
    // Act
    const actual = decideLoginApplicability('claude', { source: 'interactive-login' }, CLAUDE_HAS_NO_LOGIN);

    // Assert
    should(actual).deepEqual({
      applies: false,
      because: 'harness-has-no-login',
      harnessReason: 'this harness has no interactive login',
    });
  });

  it('should ask the harness before the credential source', () => {
    // Act
    const actual = decideLoginApplicability(
      'claude',
      { source: 'environment', variable: 'ANTHROPIC_API_KEY' },
      CLAUDE_HAS_NO_LOGIN,
    );

    // Assert
    should(actual).have.property('because', 'harness-has-no-login');
  });

  it('should default to the shipped declarations, which offer a login to both harnesses', () => {
    // Act
    const actual = [
      decideLoginApplicability('claude', { source: 'interactive-login' }),
      decideLoginApplicability('codex', { source: 'interactive-login' }),
    ];

    // Assert
    should(actual).deepEqual([{ applies: true }, { applies: true }]);
  });

  it('should omit a harness reason when a declaration refuses without stating one', () => {
    // Arrange — a table that says no and, wrongly, says nothing. The shape permits it only through a
    // cast, and the decision must still be usable rather than carrying `undefined` as a sentence.
    const silent = { claude: { login: false }, codex: { login: true } } as unknown as HarnessLoginDeclarations;

    // Act
    const actual = decideLoginApplicability('claude', { source: 'interactive-login' }, silent);

    // Assert
    should(actual).deepEqual({ applies: false, because: 'harness-has-no-login' });
  });
});
