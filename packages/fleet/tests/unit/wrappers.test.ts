import { describe, it } from 'bun:test';
import should from 'should';
import type { ResolvedAccount, ResolvedCommand } from '../../src/lib/profiles.ts';
import {
  FIRST_RUN_SEED_TOGGLE,
  MANAGED_MARKER,
  UnknownCommandTargetError,
  envReferenceName,
  renderCommandScript,
  renderWrapperScript,
  resolveCommandTargets,
  shellPath,
  shellQuote,
} from '../../src/lib/wrappers.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';
const ID_TWO = '00000000-0000-4000-8000-000000000002';

/** A placeholder token name. No test in this file ever supplies a credential value. */
const TOKEN_NAME = 'PROVIDER_TOKEN_PLACEHOLDER';

const account = (overrides: Partial<ResolvedAccount> = {}): ResolvedAccount => ({
  id: ID_ONE,
  kind: 'claude',
  mode: 'auto',
  wrapper: 'claude-auto-kirin',
  home: '$HOME/.state/fleet/homes/auto-kirin',
  displayName: 'Kirin (auto)',
  agent: 'kirin',
  variant: 'auto',
  identity: 'kirin',
  auth: 'oauth',
  available: true,
  unavailableReason: null,
  defaultModel: 'model-one',
  models: [{ id: 'model-one', available: true }],
  env: {},
  flags: [],
  settings: [],
  memory: undefined,
  skills: undefined,
  hooks: undefined,
  hooksDir: undefined,
  mcp: undefined,
  ...overrides,
});

const command = (overrides: Partial<ResolvedCommand> = {}): ResolvedCommand => ({
  wrapper: 'crc-claude-auto-kirin',
  target: ID_ONE,
  flags: ['--chrome', '--rc'],
  alias: 'crc',
  ...overrides,
});

describe('envReferenceName', () => {
  it.each([
    ['bare reference', `$${TOKEN_NAME}`, TOKEN_NAME],
    ['braced reference', `\${${TOKEN_NAME}}`, TOKEN_NAME],
    ['underscore leading', '$_HIDDEN', '_HIDDEN'],
  ])('should read %s as an indirect reference', (_label, input, expected) => {
    // Act
    const actual = envReferenceName(input);

    // Assert
    should(actual).equal(expected);
  });

  it.each([
    ['plain text', 'anthropic'],
    ['partial reference', `prefix-$${TOKEN_NAME}`],
    ['two references', `$A$B`],
    ['command substitution', '$(id -u)'],
    ['positional', '$1'],
    ['empty', ''],
  ])('should treat %s as a literal', (_label, input) => {
    // Act
    const actual = envReferenceName(input);

    // Assert
    should(actual).be.undefined();
  });
});

describe('shellQuote', () => {
  it.each([
    ['plain', 'anthropic', "'anthropic'"],
    ['a dollar sign', '$HOME', "'$HOME'"],
    ['a command substitution', '$(rm -rf /)', "'$(rm -rf /)'"],
    ['backticks', '`id`', "'`id`'"],
    ['a double quote', 'say "hi"', `'say "hi"'`],
    ['a single quote', "it's", "'it'\\''s'"],
    ['a newline', 'a\nb', "'a\nb'"],
  ])('should render %s as an inert literal', (_label, input, expected) => {
    // Act
    const actual = shellQuote(input);

    // Assert
    should(actual).equal(expected);
  });
});

describe('shellPath', () => {
  it.each([
    ['a tilde path', '~/.secrets', '"$HOME/.secrets"'],
    ['a $HOME path', '$HOME/.state/fleet', '"$HOME/.state/fleet"'],
    ['bare tilde', '~', '"$HOME"'],
    ['an absolute path', '/state/fleet/bin', "'/state/fleet/bin'"],
    ['a path with a space', '/state/my fleet', "'/state/my fleet'"],
  ])('should render %s correctly', (_label, input, expected) => {
    // Act
    const actual = shellPath(input);

    // Assert
    should(actual).equal(expected);
  });
});

describe('renderWrapperScript', () => {
  it('should bind the harness to its declared home and exec the harness binary', () => {
    // Arrange
    const subject = account();

    // Act
    const actual = renderWrapperScript(subject);

    // Assert
    should(actual.startsWith('#!/bin/sh\n')).be.true();
    should(actual).containEql(MANAGED_MARKER);
    should(actual).containEql(`# account ${ID_ONE} (claude, auto)`);
    should(actual).containEql('export CLAUDE_CONFIG_DIR="$HOME/.state/fleet/homes/auto-kirin"');
    should(actual.trimEnd().endsWith('exec claude "$@"')).be.true();
  });

  it('should use the codex home variable and binary for a codex account', () => {
    // Arrange
    const subject = account({ kind: 'codex', home: '/state/fleet/homes/loge', flags: ['--full-auto'] });

    // Act
    const actual = renderWrapperScript(subject);

    // Assert
    should(actual).containEql(`export CODEX_HOME='/state/fleet/homes/loge'`);
    should(actual).not.containEql('CLAUDE_CONFIG_DIR');
    should(actual.trimEnd().endsWith(`exec codex '--full-auto' "$@"`)).be.true();
  });

  it('should source only the configured secrets file, and nothing when none is configured', () => {
    // Arrange
    const subject = account();

    // Act
    const withSecrets = renderWrapperScript(subject, { secretsFile: '~/.config/fy/provider-env' });
    const without = renderWrapperScript(subject);

    // Assert
    should(withSecrets).containEql('if [ -r "$HOME/.config/fy/provider-env" ]; then');
    should(withSecrets).containEql('  . "$HOME/.config/fy/provider-env"');
    should(withSecrets.match(/^\s*\. /gm)?.length).equal(1);
    // A sourcing *line*, not the substring: a wrapper's prose and its jq filters contain ". " for
    // entirely innocent reasons, and a check that cannot tell those apart stops meaning anything.
    should(without.match(/^\s*\. /gm)).be.null();
  });

  it('should source a secrets file given as an absolute path as an inert literal', () => {
    // Arrange
    const subject = account();

    // Act
    const actual = renderWrapperScript(subject, { secretsFile: '/etc/fy/provider-env' });

    // Assert
    should(actual).containEql(`if [ -r '/etc/fy/provider-env' ]; then`);
  });

  it('should preserve an indirect reference instead of embedding any value', () => {
    // Arrange — the wrapper must carry the reference, never the secret
    const subject = account({ env: { ANTHROPIC_AUTH_TOKEN: `$${TOKEN_NAME}` } });

    // Act
    const actual = renderWrapperScript(subject, { secretsFile: '~/.config/fy/provider-env' });

    // Assert
    should(actual).containEql(`export ANTHROPIC_AUTH_TOKEN="\${${TOKEN_NAME}}"`);
    should(actual).containEql(TOKEN_NAME);
  });

  it('should preserve a braced reference identically to a bare one', () => {
    // Arrange
    const bare = account({ env: { TOKEN: `$${TOKEN_NAME}` } });
    const braced = account({ env: { TOKEN: `\${${TOKEN_NAME}}` } });

    // Act
    const actual = renderWrapperScript(braced);

    // Assert
    should(actual).equal(renderWrapperScript(bare));
  });

  it('should guard each referenced variable once, naming the configured secrets file', () => {
    // Arrange — an unset reference would otherwise become an empty string and confuse the harness
    const subject = account({
      env: { ANTHROPIC_AUTH_TOKEN: `$${TOKEN_NAME}`, ANTHROPIC_API_KEY: `$${TOKEN_NAME}` },
    });

    // Act
    const actual = renderWrapperScript(subject, { secretsFile: '~/.config/fy/provider-env' });

    // Assert
    should(actual).containEql(
      `: "\${${TOKEN_NAME}:?ferretry: ${TOKEN_NAME} is not set — expected it from ~/.config/fy/provider-env}"`,
    );
    should(actual.match(/:\?ferretry:/g)?.length).equal(1);
  });

  it('should omit the guards when the caller opts out', () => {
    // Arrange
    const subject = account({ env: { TOKEN: `$${TOKEN_NAME}` } });

    // Act
    const actual = renderWrapperScript(subject, { guardEnvReferences: false });

    // Assert
    should(actual).not.containEql(':?ferretry:');
    should(actual).containEql(`export TOKEN="\${${TOKEN_NAME}}"`);
  });

  it('should quote a literal environment value so no part of it can be interpreted', () => {
    // Arrange — only a value that is *entirely* a reference expands; these are all literals
    const subject = account({
      env: { PROMPT: '$(id -u)', PARTIAL: 'under-$HOME', BACKTICK: '`id`', TEXT: "it's fine" },
    });

    // Act
    const actual = renderWrapperScript(subject);

    // Assert
    should(actual).containEql(`export PROMPT='$(id -u)'`);
    should(actual).containEql(`export PARTIAL='under-$HOME'`);
    should(actual).containEql("export BACKTICK='`id`'");
    should(actual).containEql(`export TEXT='it'\\''s fine'`);
  });

  it('should source secrets before exporting anything that references them', () => {
    // Arrange
    const subject = account({ env: { TOKEN: `$${TOKEN_NAME}` } });

    // Act
    const actual = renderWrapperScript(subject, { secretsFile: '~/.secrets' });

    // Assert
    should(actual.indexOf('. "$HOME/.secrets"')).be.below(actual.indexOf('export TOKEN='));
    should(actual.indexOf(':?ferretry:')).be.below(actual.indexOf('export TOKEN='));
  });

  it('should quote every flag and keep the argument passthrough last', () => {
    // Arrange
    const subject = account({ flags: ['--dangerously-skip-permissions', '--model', 'model one'] });

    // Act
    const actual = renderWrapperScript(subject);

    // Assert
    should(
      actual.trimEnd().endsWith(`exec claude '--dangerously-skip-permissions' '--model' 'model one' "$@"`),
    ).be.true();
  });

  it('should emit environment keys in a stable order so re-rendering is byte-identical', () => {
    // Arrange
    const first = account({ env: { ZULU: '1', ALPHA: '2', MIKE: '3' } });
    const second = account({ env: { MIKE: '3', ZULU: '1', ALPHA: '2' } });

    // Act
    const actual = renderWrapperScript(first);

    // Assert
    should(actual).equal(renderWrapperScript(second));
    should(actual.indexOf('export ALPHA=')).be.below(actual.indexOf('export MIKE='));
    should(actual.indexOf('export MIKE=')).be.below(actual.indexOf('export ZULU='));
  });

  it('should render an alias-shaped wrapper for a claude account without changing the harness', () => {
    // Arrange — nothing may be inferred from a name, so a codex-looking name still runs claude
    const subject = account({ wrapper: 'codex-auto-kirin', kind: 'claude' });

    // Act
    const actual = renderWrapperScript(subject);

    // Assert
    should(actual).containEql('export CLAUDE_CONFIG_DIR=');
    should(actual.trimEnd().endsWith('exec claude "$@"')).be.true();
  });
});

describe('renderCommandScript', () => {
  it('should exec the target wrapper with its flags prepended', () => {
    // Arrange
    const input = { command: command(), targetWrapper: 'claude-auto-kirin', binDir: '$HOME/.state/fleet/bin' };

    // Act
    const actual = renderCommandScript(input);

    // Assert
    should(actual.startsWith('#!/bin/sh\n')).be.true();
    should(actual).containEql(MANAGED_MARKER);
    should(actual).containEql(`# runs account ${ID_ONE}`);
    should(
      actual.trimEnd().endsWith(`exec "$HOME/.state/fleet/bin/claude-auto-kirin" '--chrome' '--rc' "$@"`),
    ).be.true();
  });

  it('should exec the bare target when the command adds no flags', () => {
    // Arrange
    const input = {
      command: command({ flags: [] }),
      targetWrapper: 'claude-auto-kirin',
      binDir: '/state/fleet/bin',
    };

    // Act
    const actual = renderCommandScript(input);

    // Assert
    should(actual.trimEnd().endsWith(`exec '/state/fleet/bin/claude-auto-kirin' "$@"`)).be.true();
  });
});

describe('resolveCommandTargets', () => {
  it('should locate each target through the account id, not the wrapper name', () => {
    // Arrange
    const accounts = [account(), account({ id: ID_TWO, wrapper: 'claude-atomi' })];
    const commands = [command({ target: ID_TWO })];

    // Act
    const actual = resolveCommandTargets(commands, accounts, '/state/fleet/bin');

    // Assert
    should(actual.length).equal(1);
    should(actual[0]?.targetWrapper).equal('claude-atomi');
  });

  it('should refuse a command whose target account does not exist', () => {
    // Arrange
    const commands = [command({ target: ID_TWO })];

    // Act + Assert
    should(() => resolveCommandTargets(commands, [account()], '/state/fleet/bin')).throw(UnknownCommandTargetError);
    should(() => resolveCommandTargets(commands, [account()], '/state/fleet/bin')).throw(/unknown account/);
  });
});

describe('first-run seeding', () => {
  const claude = (env: Record<string, string> = {}) => account({ kind: 'claude', env });

  it('should seed the prompts that stall a launch nobody is watching', () => {
    // Act
    const actual = renderWrapperScript(claude());

    // Assert — the four flags the harness gates its one-time prompts on.
    should(actual).containEql('hasTrustDialogAccepted');
    should(actual).containEql('hasCompletedOnboarding');
    should(actual).containEql('hasCompletedClaudeInChromeOnboarding');
    should(actual).containEql('claudeInChromeDefaultEnabled');
  });

  it('should seed on every launch rather than trusting a write made once', () => {
    // Act
    const actual = renderWrapperScript(claude());

    // Assert — it is in the wrapper, before the exec, so it re-asserts every invocation.
    const seedAt = actual.indexOf('hasTrustDialogAccepted');
    const execAt = actual.indexOf('exec claude');
    should(seedAt).be.greaterThan(-1);
    should(seedAt).be.lessThan(execAt);
  });

  it('should write the browser default only when it has never been chosen', () => {
    // Act
    const actual = renderWrapperScript(claude());

    // Assert — a home where somebody deliberately chose true must not be silently turned off.
    should(actual).containEql('if .claudeInChromeDefaultEnabled == null then');
  });

  it('should offer a way to launch without it', () => {
    // Act
    const actual = renderWrapperScript(claude());

    // Assert
    should(actual).containEql(FIRST_RUN_SEED_TOGGLE);
    should(actual).containEql(`\${${FIRST_RUN_SEED_TOGGLE}:-1}`);
  });

  it('should say so out loud when it cannot seed, rather than skipping in silence', () => {
    // Act
    const actual = renderWrapperScript(claude());

    // Assert — a launch that may stall for an unexplained reason is what this exists to prevent.
    should(actual).containEql('command -v jq');
    should(actual).match(/jq is not installed[^\n]*>&2/u);
  });

  it('should approve the key the account itself exports', () => {
    // Act — the harness asks about a custom API key and defaults to No, blocking a headless session.
    const actual = renderWrapperScript(claude({ ANTHROPIC_API_KEY: '$FY_TOKEN' }));

    // Assert
    should(actual).containEql('customApiKeyResponses');
  });

  it('should pass the key through the environment, never through a process listing', () => {
    // Act
    const actual = renderWrapperScript(claude({ ANTHROPIC_API_KEY: '$FY_TOKEN' }));

    // Assert — `jq --arg` would put a key fragment in argv, where any `ps` can read it.
    should(actual).containEql('$ENV.FY_SEED_KEY');
    should(actual).not.containEql('--arg');
  });

  it('should seed after the exports, because it reads what they decided', () => {
    // Act
    const actual = renderWrapperScript(claude({ ANTHROPIC_API_KEY: 'placeholder' }));

    // Assert
    should(actual.indexOf('export ANTHROPIC_API_KEY')).be.lessThan(actual.indexOf('customApiKeyResponses'));
  });

  it('should leave a Codex wrapper alone — it has no such prompts', () => {
    // Act
    const actual = renderWrapperScript(account({ kind: 'codex', env: {} }));

    // Assert
    should(actual).not.containEql('hasTrustDialogAccepted');
    should(actual).not.containEql(FIRST_RUN_SEED_TOGGLE);
  });
});
