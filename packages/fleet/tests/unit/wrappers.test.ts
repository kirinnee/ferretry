import { describe, it } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ROUTING_PROMPT_CHARS } from '@ferretry/protocol';
import should from 'should';
import {
  AGENT_INSTRUCTION,
  AGENT_TOOLS_INSTRUCTION,
  ATTENTION_INSTRUCTION,
  CLAUDE_NO_QUESTIONS_FLAG,
  CODEX_QUESTIONS_FEATURE,
  fixedLayerFor,
  HYPERMEDIA_INSTRUCTION,
  LESSONS_INSTRUCTION,
  PACK_INSTRUCTION,
  SET_UP_FERRETRY_INSTRUCTION,
  TOOLS_SERVER_INSTRUCTIONS,
} from '../../src/lib/account/fixed-layer.ts';
import type { HarnessKind } from '../../src/lib/manifest.ts';
import {
  envReferenceName,
  MANAGED_MARKER,
  type ResolvedCommand,
  type RuntimeWrapperInput,
  renderCommandScript,
  renderRuntimeWrapperScript,
  shellPath,
  shellQuote,
} from '../../src/lib/wrappers.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';

/** A placeholder token name. No test in this file ever supplies a credential value. */
const TOKEN_NAME = 'PROVIDER_TOKEN_PLACEHOLDER';

/** The facts these cases vary about one runtime; everything else is a fixed agent runtime. */
interface RuntimeFacts {
  readonly id?: string;
  readonly wrapper?: string;
  readonly kind?: HarnessKind;
  readonly home?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly flags?: readonly string[];
}

const account = (overrides: RuntimeFacts = {}): RuntimeWrapperInput => {
  const harness = overrides.kind ?? 'claude';
  return {
    name: overrides.wrapper ?? 'claude-auto-kirin',
    id: overrides.id ?? ID_ONE,
    harness,
    agent: true,
    configDirectory: overrides.home ?? '$HOME/.state/fleet/homes/auto-kirin',
    env: overrides.env ?? {},
    args: overrides.flags ?? [],
    seedFirstRun: harness === 'claude',
    fyCommand: 'fy',
  };
};

/** The runtime renderer, with the secrets file a case names. */
const render = (input: RuntimeWrapperInput, options: { readonly secretsFile?: string } = {}): string =>
  renderRuntimeWrapperScript({ ...input, secretsFile: options.secretsFile });

const FIRST_RUN_SEED_TOGGLE = 'FY_SEED_FIRST_RUN';

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
    // Only `$HOME` may expand: a remainder a double-quoted word would still interpret is single-quoted.
    ['a tilde path holding a command substitution', '~/$(touch pwned)', `"$HOME"/'$(touch pwned)'`],
    ['a $HOME path holding a variable', '$HOME/$USER/fleet', `"$HOME"/'$USER/fleet'`],
    ['a tilde path holding a backtick', '~/`id`', `"$HOME"/'\`id\`'`],
    ['a tilde path holding a quote', `~/it's "here"`, `"$HOME"/'it'\\''s "here"'`],
  ])('should render %s correctly', (_label, input, expected) => {
    // Act
    const actual = shellPath(input);

    // Assert
    should(actual).equal(expected);
  });
});

describe('renderRuntimeWrapperScript', () => {
  it('should bind the harness to its declared home and exec the harness binary', () => {
    // Arrange
    const subject = account();

    // Act
    const actual = render(subject);

    // Assert
    should(actual.startsWith('#!/bin/sh\n')).be.true();
    should(actual).containEql(MANAGED_MARKER);
    should(actual).containEql(`# runtime claude-auto-kirin ${ID_ONE} (claude, agent)`);
    should(actual).containEql('export CLAUDE_CONFIG_DIR="$HOME/.state/fleet/homes/auto-kirin"');
    should(actual.trimEnd().endsWith('exec claude "$@"')).be.true();
  });

  it('should exec the resolved absolute harness path, and the bare name only when none was resolved', () => {
    // Arrange
    const subject = account();

    // Act
    const resolved = render({ ...subject, harnessCommand: '/opt/harnesses/claude' });
    const underHome = render({ ...subject, harnessCommand: '~/.local/bin/claude' });
    const unresolved = render({ ...subject, harnessCommand: undefined });

    // Assert
    should(resolved.trimEnd().endsWith(`exec '/opt/harnesses/claude' "$@"`)).be.true();
    should(underHome.trimEnd().endsWith(`exec "$HOME/.local/bin/claude" "$@"`)).be.true();
    should(unresolved.trimEnd().endsWith('exec claude "$@"')).be.true();
  });

  it('should use the codex home variable and binary for a codex account', () => {
    // Arrange
    const subject = account({ kind: 'codex', home: '/state/fleet/homes/loge', flags: ['--full-auto'] });

    // Act
    const actual = render(subject);

    // Assert
    should(actual).containEql(`export CODEX_HOME='/state/fleet/homes/loge'`);
    should(actual).not.containEql('CLAUDE_CONFIG_DIR');
    should(actual.trimEnd().endsWith(`exec codex '--full-auto' "$@"`)).be.true();
  });

  it('should source only the configured secrets file, and nothing when none is configured', () => {
    // Arrange
    const subject = account();

    // Act
    const withSecrets = render(subject, { secretsFile: '~/.config/fy/provider-env' });
    const without = render(subject);

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
    const actual = render(subject, { secretsFile: '/etc/fy/provider-env' });

    // Assert
    should(actual).containEql(`if [ -r '/etc/fy/provider-env' ]; then`);
  });

  it('should preserve an indirect reference instead of embedding any value', () => {
    // Arrange — the wrapper must carry the reference, never the secret
    const subject = account({ env: { ANTHROPIC_AUTH_TOKEN: `$${TOKEN_NAME}` } });

    // Act
    const actual = render(subject, { secretsFile: '~/.config/fy/provider-env' });

    // Assert
    should(actual).containEql(`export ANTHROPIC_AUTH_TOKEN="\${${TOKEN_NAME}}"`);
    should(actual).containEql(TOKEN_NAME);
  });

  it('should preserve a braced reference identically to a bare one', () => {
    // Arrange
    const bare = account({ env: { TOKEN: `$${TOKEN_NAME}` } });
    const braced = account({ env: { TOKEN: `\${${TOKEN_NAME}}` } });

    // Act
    const actual = render(braced);

    // Assert
    should(actual).equal(render(bare));
  });

  it('should guard each referenced variable once, naming the configured secrets file', () => {
    // Arrange — an unset reference would otherwise become an empty string and confuse the harness
    const subject = account({
      env: { ANTHROPIC_AUTH_TOKEN: `$${TOKEN_NAME}`, ANTHROPIC_API_KEY: `$${TOKEN_NAME}` },
    });

    // Act
    const actual = render(subject, { secretsFile: '~/.config/fy/provider-env' });

    // Assert
    should(actual).containEql(
      `: "\${${TOKEN_NAME}:?ferretry: ${TOKEN_NAME} is not set — expected it from ~/.config/fy/provider-env}"`,
    );
    should(actual.match(/:\?ferretry:/g)?.length).equal(1);
  });

  it('should quote a literal environment value so no part of it can be interpreted', () => {
    // Arrange — only a value that is *entirely* a reference expands; these are all literals
    const subject = account({
      env: { PROMPT: '$(id -u)', PARTIAL: 'under-$HOME', BACKTICK: '`id`', TEXT: "it's fine" },
    });

    // Act
    const actual = render(subject);

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
    const actual = render(subject, { secretsFile: '~/.secrets' });

    // Assert
    should(actual.indexOf('. "$HOME/.secrets"')).be.below(actual.indexOf('export TOKEN='));
    should(actual.indexOf(':?ferretry:')).be.below(actual.indexOf('export TOKEN='));
  });

  it('should quote every flag and keep the argument passthrough last', () => {
    // Arrange
    const subject = account({ flags: ['--dangerously-skip-permissions', '--model', 'model one'] });

    // Act
    const actual = render(subject);

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
    const actual = render(first);

    // Assert
    should(actual).equal(render(second));
    should(actual.indexOf('export ALPHA=')).be.below(actual.indexOf('export MIKE='));
    should(actual.indexOf('export MIKE=')).be.below(actual.indexOf('export ZULU='));
  });

  it('should render an alias-shaped wrapper for a claude account without changing the harness', () => {
    // Arrange — nothing may be inferred from a name, so a codex-looking name still runs claude
    const subject = account({ wrapper: 'codex-auto-kirin', kind: 'claude' });

    // Act
    const actual = render(subject);

    // Assert
    should(actual).containEql('export CLAUDE_CONFIG_DIR=');
    should(actual.trimEnd().endsWith('exec claude "$@"')).be.true();
  });
});

/** What the wrapper's question line leaves in "$@" for a launch with the given mode, run for real in sh. */
const argumentsAfterQuestionLine = (wrapper: string, mode: string | undefined, launchArgs: readonly string[]) => {
  const line = wrapper.split('\n').find(candidate => candidate.includes('FY_SESSION_MODE'));
  if (line === undefined) return undefined;
  const { stdout } = Bun.spawnSync(['sh', '-c', `${line}\nprintf '%s\\n' "$@"`, 'wrapper', ...launchArgs], {
    env: mode === undefined ? {} : { FY_SESSION_MODE: mode },
  });
  return stdout.toString().trimEnd().split('\n');
};

describe('the question tool, per ferret (O3)', () => {
  it("should withhold Claude's question tool, before the prompt, unless the ferret is interactive", () => {
    // Arrange
    const wrapper = render(account({ flags: [CLAUDE_NO_QUESTIONS_FLAG, '--model', 'x'] }));

    // Act + Assert
    should(wrapper).not.containEql(`'${CLAUDE_NO_QUESTIONS_FLAG}'`);
    should(argumentsAfterQuestionLine(wrapper, 'auto', ['do the thing'])).deepEqual([
      CLAUDE_NO_QUESTIONS_FLAG,
      'do the thing',
    ]);
    should(argumentsAfterQuestionLine(wrapper, undefined, ['do the thing'])).deepEqual([
      CLAUDE_NO_QUESTIONS_FLAG,
      'do the thing',
    ]);
    should(argumentsAfterQuestionLine(wrapper, 'interactive', ['do the thing'])).deepEqual(['do the thing']);
  });

  it("should enable Codex's question feature only for an interactive ferret", () => {
    // Arrange
    const wrapper = render(account({ kind: 'codex' }));

    // Act + Assert
    should(argumentsAfterQuestionLine(wrapper, 'interactive', ['task'])).deepEqual([
      '--enable',
      CODEX_QUESTIONS_FEATURE,
      'task',
    ]);
    should(argumentsAfterQuestionLine(wrapper, 'auto', ['task'])).deepEqual(['task']);
    should(argumentsAfterQuestionLine(wrapper, undefined, ['task'])).deepEqual(['task']);
  });

  it("should leave a non-agent runtime alone: it behaves like the person's own CLI", () => {
    // Arrange
    const wrapper = render({ ...account(), agent: false });

    // Act + Assert
    should(argumentsAfterQuestionLine(wrapper, 'auto', ['task'])).be.undefined();
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

describe('first-run seeding', () => {
  const claude = (env: Record<string, string> = {}) => account({ kind: 'claude', env });

  it('should seed the prompts that stall a launch nobody is watching', () => {
    // Act
    const actual = render(claude());

    // Assert — the four flags the harness gates its one-time prompts on.
    should(actual).containEql('hasTrustDialogAccepted');
    should(actual).containEql('hasCompletedOnboarding');
    should(actual).containEql('hasCompletedClaudeInChromeOnboarding');
    should(actual).containEql('claudeInChromeDefaultEnabled');
  });

  it('should seed every one-shot dialog the fixed layer records as seen, the auto-mode nudge first among them', () => {
    // Act
    const actual = render(claude());

    // Assert — the dialog that parked a bypass agent with every message failing.
    should(actual).containEql('.["hasSeenAutoDefaultNudge"] = true');
    should(actual).containEql('.["hasSeenEffortMediumNudgeByModel"]["claude-opus-5"] = true');
    // A count is raised to its floor, never lowered.
    should(actual).containEql('.["fullscreenUpsellSeenCount"] = ([(.["fullscreenUpsellSeenCount"] // 0), 3] | max)');
    should(actual).containEql('((.["fullscreenUpsellSeenCount"] // 0) >= 3)');
  });

  it('should seed on every launch rather than trusting a write made once', () => {
    // Act
    const actual = render(claude());

    // Assert — it is in the wrapper, before the exec, so it re-asserts every invocation.
    const seedAt = actual.indexOf('hasTrustDialogAccepted');
    const execAt = actual.indexOf('exec claude');
    should(seedAt).be.greaterThan(-1);
    should(seedAt).be.lessThan(execAt);
  });

  it('should write the browser default only when it has never been chosen', () => {
    // Act
    const actual = render(claude());

    // Assert — a home where somebody deliberately chose true must not be silently turned off.
    should(actual).containEql('if .claudeInChromeDefaultEnabled == null then');
  });

  it('should offer a way to launch without it', () => {
    // Act
    const actual = render(claude());

    // Assert
    should(actual).containEql(FIRST_RUN_SEED_TOGGLE);
    should(actual).containEql(`\${${FIRST_RUN_SEED_TOGGLE}:-1}`);
  });

  it('should say so out loud when it cannot seed, rather than skipping in silence', () => {
    // Act
    const actual = render(claude());

    // Assert — a launch that may stall for an unexplained reason is what this exists to prevent.
    should(actual).containEql('command -v jq');
    should(actual).match(/jq is not installed[^\n]*>&2/u);
  });

  it('should approve the key the account itself exports', () => {
    // Act — the harness asks about a custom API key and defaults to No, blocking a headless session.
    const actual = render(claude({ ANTHROPIC_API_KEY: '$FY_TOKEN' }));

    // Assert
    should(actual).containEql('customApiKeyResponses');
  });

  it('should pass the key through the environment, never through a process listing', () => {
    // Act
    const actual = render(claude({ ANTHROPIC_API_KEY: '$FY_TOKEN' }));

    // Assert — `jq --arg` would put a key fragment in argv, where any `ps` can read it.
    should(actual).containEql('$ENV.FY_SEED_KEY');
    should(actual).not.containEql('--arg');
  });

  it('should seed after the exports, because it reads what they decided', () => {
    // Act
    const actual = render(claude({ ANTHROPIC_API_KEY: 'placeholder' }));

    // Assert
    should(actual.indexOf('export ANTHROPIC_API_KEY')).be.lessThan(actual.indexOf('customApiKeyResponses'));
  });

  it('should leave a Codex wrapper alone — it has no such prompts', () => {
    // Act
    const actual = render(account({ kind: 'codex', env: {} }));

    // Assert
    should(actual).not.containEql('hasTrustDialogAccepted');
    should(actual).not.containEql(FIRST_RUN_SEED_TOGGLE);
  });
});

/**
 * A wrapper for an account a profile authenticates.
 *
 * The property under test is an absence: the script must carry no value and no way to produce one,
 * so what it carries instead is a REQUIREMENT the daemon satisfies at launch. Every "value" below is
 * a fixture string; nothing here supplies a credential.
 */
describe('an account whose profile takes a variable from the secret store', () => {
  it('should never export the value, because there is none in the script to export', () => {
    // Act
    const actual = render(account({ env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } }));

    // Assert
    should(actual).not.containEql('export ANTHROPIC_API_KEY');
    should(actual).not.containEql('${secret:WORK_KEY}');
  });

  it('should require the variable, naming the secret and what to run', () => {
    // Act
    const actual = render(account({ env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } }));

    // Assert
    should(actual).containEql(
      `: "\${ANTHROPIC_API_KEY:?ferretry: ANTHROPIC_API_KEY is not set — this account takes it from Ferretry's secret store (secret WORK_KEY). Launch it through the daemon, or run: fy secret set WORK_KEY}"`,
    );
  });

  it('should name every secret one variable composes, and offer the first as the one to set', () => {
    // Act
    const actual = render(account({ env: { AUTH_HEADER: '${secret:SCHEME} ${secret:WORK_KEY}' } }));

    // Assert
    should(actual).containEql('(secrets SCHEME, WORK_KEY)');
    should(actual).containEql('fy secret set SCHEME');
  });

  it('should require it before the home is bound, so nothing runs on a missing credential', () => {
    // Act
    const actual = render(account({ env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } }));

    // Assert
    should(actual.indexOf('${ANTHROPIC_API_KEY:?')).be.lessThan(actual.indexOf('export CLAUDE_CONFIG_DIR'));
  });

  it('should still export the literal variables beside it', () => {
    // Act
    const actual = render(
      account({ env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}', ANTHROPIC_BASE_URL: 'https://example.invalid' } }),
    );

    // Assert
    should(actual).containEql("export ANTHROPIC_BASE_URL='https://example.invalid'");
  });

  it('should keep an environment reference beside it a reference, with its own guard', () => {
    // Act
    const actual = render(account({ env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}', OTHER: `$${TOKEN_NAME}` } }));

    // Assert
    should(actual).containEql(`export OTHER="\${${TOKEN_NAME}}"`);
    should(actual).containEql(`expected it from the environment`);
    should(actual).containEql(`Ferretry's secret store`);
  });

  it('should leave a wrapper that binds no secret byte-identical to what it always was', () => {
    // Arrange
    const plain = account({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid', OTHER: `$${TOKEN_NAME}` } });

    // Act
    const actual = render(plain);

    // Assert — the two rendering rules that existed before, unchanged and in the same order.
    should(actual).containEql(
      `: "\${${TOKEN_NAME}:?ferretry: ${TOKEN_NAME} is not set — expected it from the environment}"`,
    );
    should(actual).containEql("export ANTHROPIC_BASE_URL='https://example.invalid'");
    should(actual).not.containEql('secret store');
  });
});

/**
 * A folder holding stand-in `claude` and `codex` executables whose `--help` prints `help`, so what the
 * wrapper asks of the installed harness is this test's answer and never the host's.
 */
const fakeHarnesses = (help: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'fy-wrapper-harness-'));
  for (const name of ['claude', 'codex']) {
    const file = join(directory, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${shellQuote(help)}\n`);
    chmodSync(file, 0o755);
  }
  return directory;
};

/** A harness that predates the system-prompt record, and so has no switch for it. */
const OLD_HARNESS = fakeHarnesses('Usage: claude [options]\n  --append-system-prompt <prompt>');

/** The arguments the rendered wrapper would exec its harness with, run for real in sh with `env`. */
const launchArguments = (
  wrapper: string,
  env: Readonly<Record<string, string>>,
  harnesses: string = OLD_HARNESS,
): readonly string[] => {
  const script = wrapper.replace(/^exec (?:claude|codex) /mu, "printf '%s\\0' ");
  const { stdout } = Bun.spawnSync(['sh', '-c', script, 'wrapper', 'the task'], {
    env: { PATH: `${harnesses}:${process.env.PATH ?? ''}`, HOME: '/nonexistent', FY_SEED_FIRST_RUN: '0', ...env },
  });
  return stdout.toString().split('\0').slice(0, -1);
};

describe("a resumed conversation hears this launch's sections", () => {
  const BASE = 'Ferretry tools: the base instruction.';
  const RECORDING_HARNESS = fakeHarnesses(
    'Usage: claude [options]\n  --system-prompt-snapshot <on|off>     Record the system prompt once per conversation',
  );

  it("should turn Claude's system-prompt record off where the installed Claude keeps one", () => {
    // Arrange — a Restart relaunches into the conversation it is bound to.
    const wrapper = render(account({ flags: [`--append-system-prompt=${BASE}`] }));

    // Act
    const args = launchArguments(wrapper, { FY_HYPERMEDIA: '1' }, RECORDING_HARNESS);

    // Assert — the record would otherwise replay the first launch's prompt, without this section.
    should(args).containEql('--system-prompt-snapshot=off');
    should(args.find(arg => arg.startsWith('--append-system-prompt='))).containEql('\n\nHypermedia:');
    should(args.at(-1)).equal('the task');
  });

  it('should pass nothing new to a Claude without the switch, which would refuse a flag it does not know', () => {
    // Act
    const args = launchArguments(render(account({ flags: [`--append-system-prompt=${BASE}`] })), {});

    // Assert
    should(args.filter(arg => arg.includes('system-prompt-snapshot'))).be.empty();
    should(args.at(-1)).equal('the task');
  });

  it('should give up on a harness that answers --help by starting a session, and still launch', () => {
    // Arrange — a stand-in that, like a harness taking `--help` for a prompt, never exits.
    const directory = mkdtempSync(join(tmpdir(), 'fy-wrapper-hang-'));
    const file = join(directory, 'claude');
    writeFileSync(file, '#!/bin/sh\nprintf "> "\nwhile IFS= read -r _turn; do :; done\nexec sleep 30\n');
    chmodSync(file, 0o755);
    const started = Date.now();

    // Act
    const args = launchArguments(render(account({ flags: [`--append-system-prompt=${BASE}`] })), {}, directory);

    // Assert
    should(Date.now() - started).be.below(10_000);
    should(args.filter(arg => arg.includes('system-prompt-snapshot'))).be.empty();
    should(args.at(-1)).equal('the task');
  });

  it('should ask the harness the wrapper execs, and leave Codex and a non-agent runtime alone', () => {
    // Arrange
    const agent = account({ flags: [`--append-system-prompt=${BASE}`] });

    // Act
    const resolved = render({ ...agent, harnessCommand: '/opt/harnesses/claude' });
    const codex = render(account({ kind: 'codex', flags: ['-c', `developer_instructions="${BASE}"`] }));
    const person = render({ ...agent, agent: false });

    // Assert
    should(resolved).containEql("_fy_help=\"$({ '/opt/harnesses/claude' --help </dev/null");
    should(launchArguments(codex, {}, RECORDING_HARNESS)).not.containEql('--system-prompt-snapshot=off');
    should(codex).not.containEql('system-prompt-snapshot');
    should(person).not.containEql('system-prompt-snapshot');
  });
});

describe("each ferret's sections of the appended system prompt", () => {
  const BASE = 'Ferretry tools: the base instruction.';

  it('should append exactly the sections this ferret switched on, after a blank line, in the fixed order', () => {
    // Arrange
    const wrapper = render(account({ flags: [`--append-system-prompt=${BASE}`, '--model', 'x'] }));
    const prompt = (env: Readonly<Record<string, string>>): string | undefined =>
      launchArguments(wrapper, env).find(arg => arg.startsWith('--append-system-prompt='));

    // Act
    const none = prompt({});
    const off = prompt({ FY_HYPERMEDIA: '0', FY_PACK: '0', FY_LEARNING_PASSIVE: '0' });
    const pack = prompt({ FY_PACK: '1' });
    const all = prompt({ FY_HYPERMEDIA: '1', FY_PACK: '1', FY_LEARNING_PASSIVE: '1' });

    // Assert
    should(none).equal(`--append-system-prompt=${BASE}`);
    should(off).equal(none);
    should(pack).startWith(`--append-system-prompt=${BASE}\n\nPack mode: `);
    should(pack).not.containEql('Hypermedia:');
    should(all?.indexOf('\n\nHypermedia:')).be.above(0);
    should(all?.indexOf('\n\nPack mode:')).be.above(all?.indexOf('\n\nHypermedia:') ?? 0);
    should(all?.indexOf('\n\nLessons:')).be.above(all?.indexOf('\n\nPack mode:') ?? 0);
    should(all).containEql('`fy lesson suggest');
  });

  it("should put Codex's sections inside the TOML string, escaped for it", () => {
    // Arrange
    const wrapper = render(account({ kind: 'codex', flags: ['-c', `developer_instructions="${BASE}"`] }));

    // Act
    const args = launchArguments(wrapper, { FY_PACK: '1' });
    const value = args.find(arg => arg.startsWith('developer_instructions='));

    // Assert
    should(value).startWith(`developer_instructions="${BASE}\\u000a\\u000aPack mode: `);
    should(value).endWith('"');
    should(value?.slice('developer_instructions='.length)).match(/^"(?:[^"\\]|\\.)*"$/u);
    should(JSON.parse(value?.slice('developer_instructions='.length) ?? '')).containEql('\n\nPack mode: ');
  });

  it("should end the Pack section with the routing prompt's line, for Claude and inside Codex's TOML string", () => {
    // Arrange
    const line =
      'Routing: Planning and review: claude-opus-5-5 at max. Chores: claude-haiku-5-5 low; when it is low, glm-5-air.';
    const claude = render(account({ flags: [`--append-system-prompt=${BASE}`] }));
    const codex = render(account({ kind: 'codex', flags: ['-c', `developer_instructions="${BASE}"`] }));

    // Act
    const claudePrompt = launchArguments(claude, { FY_PACK: '1', FY_PACK_ROUTING: line }).find(arg =>
      arg.startsWith('--append'),
    );
    const codexValue = launchArguments(codex, { FY_PACK: '1', FY_PACK_ROUTING: line }).find(arg =>
      arg.startsWith('developer_instructions='),
    );

    // Assert
    should(claudePrompt).endWith(`${PACK_INSTRUCTION('fy')}\n${line}`);
    should(JSON.parse(codexValue?.slice('developer_instructions='.length) ?? '')).endWith(
      `${PACK_INSTRUCTION('fy')}\n${line}`,
    );
  });

  it('should carry no routing line with Pack mode off or no line set, and strip what would break the quoting', () => {
    // Arrange
    const codex = render(account({ kind: 'codex', flags: ['-c', `developer_instructions="${BASE}"`] }));
    const claude = render(account({ flags: [`--append-system-prompt=${BASE}`] }));
    const prompt = (env: Record<string, string>) =>
      launchArguments(claude, env).find(arg => arg.startsWith('--append')) ?? '';

    // Act
    const hostile = launchArguments(codex, { FY_PACK: '1', FY_PACK_ROUTING: 'a"b\\c\nd\te' }).find(arg =>
      arg.startsWith('developer_instructions='),
    );

    // Assert
    should(prompt({ FY_PACK: '0', FY_PACK_ROUTING: 'Routing: x.' })).not.containEql('Routing: x.');
    should(prompt({ FY_PACK: '1' })).endWith(PACK_INSTRUCTION('fy'));
    should(prompt({ FY_PACK: '1', FY_PACK_ROUTING: '' })).endWith(PACK_INSTRUCTION('fy'));
    should(hostile?.slice('developer_instructions='.length)).match(/^"(?:[^"\\]|\\.)*"$/u);
    should(JSON.parse(hostile?.slice('developer_instructions='.length) ?? '')).endWith('\nabcde');
  });

  it('should name the binary the runtime launches, and leave every other argument and a non-agent alone', () => {
    // Arrange
    const agent = {
      ...account({ flags: [`--append-system-prompt=${BASE}`, '--other=x'] }),
      fyCommand: '/opt/f/bin/zz',
    };
    const person = { ...agent, agent: false };

    // Act
    const prompt = launchArguments(render(agent), { FY_PACK: '1' }).find(arg => arg.startsWith('--append'));

    // Assert
    should(prompt).containEql('`zz recommend');
    should(launchArguments(render(agent), {})).containEql('--other=x');
    should(render(person)).not.containEql('_fy_sections');
  });
});

describe('the appended system prompt of a real agent runtime, for every combination of switches', () => {
  const FY = '/opt/f/bin/fy';
  const SWITCHES = [
    { env: 'FY_HYPERMEDIA', text: HYPERMEDIA_INSTRUCTION },
    { env: 'FY_PACK', text: PACK_INSTRUCTION('fy') },
    { env: 'FY_LEARNING_PASSIVE', text: LESSONS_INSTRUCTION('fy') },
  ] as const;
  const combinations = Array.from({ length: 2 ** SWITCHES.length }, (_, mask) =>
    SWITCHES.filter((_switch, index) => (mask & (1 << index)) !== 0),
  );
  const wrapperFor = (harness: HarnessKind): string => {
    const layer = fixedLayerFor({
      harness,
      agentPermissions: 'auto',
      cwd: '/w',
      fyCommand: FY,
      acceptsAutoPermissionMode: true,
    });
    if (!layer.ok) throw new Error(layer.refusal.message);
    return render({ ...account({ kind: harness, flags: layer.layer.args }), fyCommand: FY });
  };

  it.each(combinations.flatMap(on => (['claude', 'codex'] as const).map(harness => [harness, on] as const)))(
    'should give a %s ferret exactly the sections switched on: %j',
    (harness, on) => {
      // Arrange
      const env = Object.fromEntries(SWITCHES.map(section => [section.env, on.includes(section) ? '1' : '0']));
      const expected = [AGENT_INSTRUCTION('fy'), ...on.map(section => section.text)].join('\n\n');

      // Act
      const args = launchArguments(wrapperFor(harness), env);
      const prompt =
        harness === 'claude'
          ? args.find(arg => arg.startsWith('--append-system-prompt='))?.slice('--append-system-prompt='.length)
          : JSON.parse(
              args.find(arg => arg.startsWith('developer_instructions='))?.slice('developer_instructions='.length) ??
                '""',
            );

      // Assert
      should(prompt).equal(expected);
      should(args.filter(arg => arg.includes('Pack mode:')).length).equal(on.some(s => s.env === 'FY_PACK') ? 1 : 0);
    },
  );

  it.each(['claude', 'codex'] as const)(
    'should give a %s ferret the attention section even with every switch off',
    harness => {
      // Arrange
      const env = Object.fromEntries(SWITCHES.map(section => [section.env, '0']));

      // Act
      const args = launchArguments(wrapperFor(harness), env);
      const prompt =
        harness === 'claude'
          ? args.find(arg => arg.startsWith('--append-system-prompt='))?.slice('--append-system-prompt='.length)
          : JSON.parse(
              args.find(arg => arg.startsWith('developer_instructions='))?.slice('developer_instructions='.length) ??
                '""',
            );

      // Assert — the binary is named by the wrapper's own command, never a hard-coded name
      should(prompt).containEql(ATTENTION_INSTRUCTION('fy'));
      should(prompt).containEql('`fy attention add "<summary>"`');
    },
  );

  it('should keep every section out of the tools server, which says one line', () => {
    // Assert
    should(TOOLS_SERVER_INSTRUCTIONS).not.containEql('\n');
    should(TOOLS_SERVER_INSTRUCTIONS.length).be.below(160);
    for (const section of [...SWITCHES, { text: SET_UP_FERRETRY_INSTRUCTION('fy') }])
      should(TOOLS_SERVER_INSTRUCTIONS).not.containEql(section.text.slice(0, 20));
  });

  it('should stay compact: the measured size of each section', () => {
    // Act
    const sizes = {
      tools: AGENT_TOOLS_INSTRUCTION.length,
      settings: SET_UP_FERRETRY_INSTRUCTION('fy').length,
      attention: ATTENTION_INSTRUCTION('fy').length,
      hypermedia: HYPERMEDIA_INSTRUCTION.length,
      pack: PACK_INSTRUCTION('fy').length,
      lessons: LESSONS_INSTRUCTION('fy').length,
    };

    // Assert — the whole prompt, every section on and the longest routing prompt as its one `Routing: ` line,
    // stays under 6.7 KB (docs/pack-mode.md records the sizes)
    const longestRouting = 1 + 'Routing: '.length + MAX_ROUTING_PROMPT_CHARS;
    should(Object.values(sizes).reduce((sum, size) => sum + size, 0) + longestRouting).be.below(6_700);
    should(sizes.pack).be.below(1_050);
    should(sizes.tools).be.below(1_100);
    should(sizes.settings).be.below(600);
    should(sizes.attention).be.below(950);
  });

  it('should tell every ferret to hand the owner a terminal or page, driven as far as it goes, rather than describe the step', () => {
    // Assert
    for (const phrase of [
      'sudo or password prompt',
      'OAuth or device-code login',
      'gh auth login',
      '2FA',
      'captcha',
      'open the terminal or page',
      'ask_owner',
      'askOwner',
      'exactly what to do',
      'Never put a secret in chat',
      'terminal_ask_owner',
      'browser_ask_owner',
    ])
      should(AGENT_TOOLS_INSTRUCTION).containEql(phrase);
  });
});
