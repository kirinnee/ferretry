import { describe, it } from 'bun:test';
import should from 'should';
import { codexFixedArguments } from '../../daemon/lib/fixed-layer.ts';

/**
 * O11: every screen Codex can stop a ferret on that has a key is answered in the launch's own `-c` overrides. The
 * overrides outrank the ferret's home `config.toml`, so a settings item can never turn one back on.
 */

const overrideOf = (args: readonly string[], key: string): string | undefined => {
  const at = args.findIndex(arg => arg.startsWith(`${key}=`));
  return at < 0 ? undefined : args[at]?.slice(key.length + 1);
};

describe('the screens a Codex launch pre-answers', () => {
  it('should answer approvals and the sandbox: bypass mode never asks and has no sandbox, auto asks on request', () => {
    should(overrideOf(codexFixedArguments('skip', '/w'), 'approval_policy')).equal('"never"');
    should(overrideOf(codexFixedArguments('skip', '/w'), 'sandbox_mode')).equal('"danger-full-access"');
    should(overrideOf(codexFixedArguments('auto', '/w'), 'approval_policy')).equal('"on-request"');
    should(overrideOf(codexFixedArguments('auto', '/w'), 'sandbox_mode')).equal('"workspace-write"');
  });

  it('should trust ONLY the ferret’s working folder', () => {
    for (const mode of ['auto', 'skip'] as const) {
      // Act
      const args = codexFixedArguments(mode, '/work/repo/sub');
      const projects = overrideOf(args, 'projects');

      // Assert: one project, the cwd — not a parent, not a wildcard
      should(projects).equal('{"/work/repo/sub"={trust_level="trusted"}}');
      should(args.filter(arg => arg.startsWith('projects='))).have.length(1);
    }
  });

  it('should hide every notice screen Codex names, and keep the full-access and sandbox warnings off', () => {
    // Act
    const notice = overrideOf(codexFixedArguments('skip', '/w'), 'notice') ?? '';

    // Assert
    for (const key of [
      'hide_full_access_warning',
      'hide_world_writable_warning',
      'hide_rate_limit_model_nudge',
      'hide_gpt5_1_migration_prompt',
      '"hide_gpt-5.1-codex-max_migration_prompt"',
    ])
      should(notice).containEql(`${key}=true`);
  });

  it('should keep the sign-in in a file and the terminal out of the alternate screen', () => {
    const args = codexFixedArguments('auto', '/w');
    should(overrideOf(args, 'cli_auth_credentials_store')).equal('"file"');
    should(args).containEql('--no-alt-screen');
  });
});
