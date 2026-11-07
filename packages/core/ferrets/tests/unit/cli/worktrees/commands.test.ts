import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerWorktreeCommands } from '../../../src/lib/worktrees/commands';
import { WorktreeController } from '../../../src/lib/worktrees/controller';
import { CALLER_CWD, CapturingOutput, RecordingWorktreeGateway, ScriptedPrompt, WORKTREE_PATH } from './fixtures';

function run(argv: string[]) {
  const gateway = new RecordingWorktreeGateway();
  const out = new CapturingOutput();
  const prompt = new ScriptedPrompt();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerWorktreeCommands(program, new WorktreeController(gateway, out, prompt, false, CALLER_CWD));
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
    should(gateway.checked).eql([{ path: WORKTREE_PATH, cwd: CALLER_CWD }]);
  });

  it('should map only worktree-loss consent flags onto removal overrides', async () => {
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
    should(gateway.removals[0]?.overrides).eql(['discard_worktree_changes', 'accept_unpushed_commits']);
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
      '--delete-unmerged',
    ]);
    await parsed;

    // Assert
    should(gateway.removals[0]).match({
      deleteBranch: true,
      confirmations: ['delete_preexisting_branch', 'delete_unmerged_branch'],
    });
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
    await should(run(['worktree', 'fork']).parsed).be.rejected();
  });

  it('should fork from the caller directory when no source is named', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['worktree', 'fork', 'feat/new']);
    await parsed;

    // Assert
    should(gateway.creations).eql([{ sourcePath: CALLER_CWD, branch: 'feat/new', base: { kind: 'auto' } }]);
  });

  it('should carry every fork option through the alias too', async () => {
    // Arrange + Act
    const { parsed, gateway, out } = run([
      'worktree',
      'add',
      'feat/new',
      '--base',
      'v1.2.3',
      '--from',
      '/repos/other',
      '--session',
      'ms8ucu18-1eb5331d',
    ]);
    await parsed;

    // Assert
    should(gateway.creations[0]).eql({
      sourcePath: '/repos/other',
      branch: 'feat/new',
      base: { kind: 'commit', reference: 'v1.2.3' },
      sessionId: 'ms8ucu18-1eb5331d',
    });
    should(out.text).containEql('start work in');
  });

  it('should resolve a relative --from against the invocation cwd before sending it', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['worktree', 'fork', 'feat/new', '--from', 'packages/cli']);
    await parsed;

    // Assert — the daemon never resolves caller-relative pathnames in its own cwd
    should(gateway.creations[0]?.sourcePath).equal(`${CALLER_CWD}/packages/cli`);
  });

  it('should refuse two answers to the one question of where to start', async () => {
    // Arrange + Act + Assert
    await should(run(['worktree', 'fork', 'feat/new', '--from-default', '--from-head']).parsed).be.rejectedWith(
      /pass only one of/u,
    );
  });
});
