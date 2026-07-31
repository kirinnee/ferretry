import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerWorktreeCommands } from '../../../src/lib/worktrees/commands';
import { WorktreeController } from '../../../src/lib/worktrees/controller';
import { CapturingOutput, RecordingWorktreeGateway, ScriptedPrompt, WORKTREE_PATH } from './fixtures';

function run(argv: string[]) {
  const gateway = new RecordingWorktreeGateway();
  const out = new CapturingOutput();
  const prompt = new ScriptedPrompt();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerWorktreeCommands(program, new WorktreeController(gateway, out, prompt, false));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out, prompt };
}

describe('worktree command surface', () => {
  it('should list when no verb is given', async () => {
    // Arrange + Act
    const { parsed, out } = run(['worktree']);
    await parsed;

    // Assert
    should(out.text).containEql(WORKTREE_PATH);
  });

  it('should accept the plural group name', async () => {
    // Arrange + Act
    const { parsed, out } = run(['worktrees', 'ls']);
    await parsed;

    // Assert
    should(out.text).containEql(WORKTREE_PATH);
  });

  it('should check a worktree', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['worktree', 'check', WORKTREE_PATH]);
    await parsed;

    // Assert
    should(gateway.checked).eql([WORKTREE_PATH]);
  });

  it('should map every consent flag onto its override', async () => {
    // Arrange + Act
    const { parsed, gateway } = run([
      'worktree',
      'rm',
      WORKTREE_PATH,
      '--yes',
      '--discard-changes',
      '--accept-unpushed',
      '--delete-unmerged',
    ]);
    await parsed;

    // Assert
    should(gateway.removals[0]?.overrides).eql([
      'discard_worktree_changes',
      'accept_unpushed_commits',
      'delete_unmerged_branch',
    ]);
  });

  it('should map the branch-deletion flags onto confirmations', async () => {
    // Arrange + Act
    const { parsed, gateway } = run([
      'worktree',
      'remove',
      WORKTREE_PATH,
      '-y',
      '--delete-branch',
      '--delete-preexisting',
    ]);
    await parsed;

    // Assert
    should(gateway.removals[0]).match({ deleteBranch: true, confirmations: ['delete_preexisting_branch'] });
  });

  it('should offer no blanket force flag', async () => {
    // Arrange + Act + Assert
    await should(run(['worktree', 'rm', WORKTREE_PATH, '--yes', '--force']).parsed).be.rejected();
  });

  it('should refuse an unattended removal that did not pass --yes', async () => {
    // Arrange + Act + Assert
    await should(run(['worktree', 'rm', WORKTREE_PATH]).parsed).be.rejectedWith(/pass --yes to authorize it/u);
  });

  it('should honour --json placed on the group rather than the verb', async () => {
    // Arrange + Act
    const { parsed, out } = run(['worktree', '--json', 'ls']);
    await parsed;

    // Assert
    should(JSON.parse(out.text)).have.property('worktrees');
  });

  it('should refuse a verb that needs a path without one', async () => {
    // Arrange + Act + Assert
    await should(run(['worktree', 'check']).parsed).be.rejected();
    await should(run(['worktree', 'rm']).parsed).be.rejected();
  });
});
