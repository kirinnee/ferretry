import { describe, it } from 'bun:test';
import should from 'should';
import { CONFIRMATION_WORD, WorktreeController } from '../../../src/lib/worktrees/controller';
import {
  blocker,
  CALLER_CWD,
  CapturingOutput,
  decision,
  listResponse,
  RecordingWorktreeGateway,
  ScriptedPrompt,
  worktree,
  WORKTREE_PATH,
} from './fixtures';

function controller(
  gateway = new RecordingWorktreeGateway(),
  { interactive = true, answer = CONFIRMATION_WORD }: { interactive?: boolean; answer?: string } = {},
): {
  subject: WorktreeController;
  gateway: RecordingWorktreeGateway;
  out: CapturingOutput;
  prompt: ScriptedPrompt;
} {
  const out = new CapturingOutput();
  const prompt = new ScriptedPrompt(answer);
  return { subject: new WorktreeController(gateway, out, prompt, interactive, CALLER_CWD), gateway, out, prompt };
}

describe('listing managed worktrees', () => {
  it('should render every worktree the daemon holds', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.list({});

    // Assert
    should(out.text).containEql(WORKTREE_PATH);
  });

  it('should emit the protocol payload under --json', async () => {
    // Arrange
    const gateway = new RecordingWorktreeGateway({
      list: listResponse([worktree(), worktree({ path: '/managed/b' })]),
    });
    const { subject, out } = controller(gateway);

    // Act
    await subject.list({ json: true });

    // Assert
    should((JSON.parse(out.text) as { worktrees: unknown[] }).worktrees).have.length(2);
  });
});

describe('checking a removal', () => {
  it('should report a clean worktree as safe', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.check(` ${WORKTREE_PATH} `, {});

    // Assert
    should(gateway.checked).eql([{ path: WORKTREE_PATH, cwd: CALLER_CWD }]);
    should(out.text).containEql('safe to remove');
  });

  it('should report blockers without applying any consent the caller has not given', async () => {
    // Arrange
    const gateway = new RecordingWorktreeGateway({ decision: decision({ removable: false, blockers: [blocker()] }) });
    const { subject, out } = controller(gateway);

    // Act
    await subject.check(WORKTREE_PATH, {});

    // Assert
    should(out.text).containEql('pass --discard-changes');
  });

  it('should refuse a blank path instead of querying for an empty one', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act + Assert
    await should(subject.check('   ', {})).be.rejectedWith('a worktree path is required');
    should(gateway.checked).be.empty();
  });
});

describe('removing a worktree', () => {
  it('should check before it removes, so the caller sees what they authorized', async () => {
    // Arrange
    const out = new CapturingOutput();
    const observing = new (class extends RecordingWorktreeGateway {
      override async remove(request: Parameters<RecordingWorktreeGateway['remove']>[0]) {
        should(out.text).containEql('safe to remove');
        return await super.remove(request);
      }
    })();
    const subject = new WorktreeController(observing, out, new ScriptedPrompt(), false, CALLER_CWD);

    // Act
    await subject.remove(WORKTREE_PATH, { yes: true });

    // Assert
    should(observing.checked).eql([{ path: WORKTREE_PATH, cwd: CALLER_CWD }]);
    should(observing.removals).eql([
      {
        path: WORKTREE_PATH,
        overrides: [],
        deleteBranch: false,
        confirmations: [],
        currentWorkingDirectory: CALLER_CWD,
      },
    ]);
  });

  it('should refuse when a blocker has no matching consent, naming the flag', async () => {
    // Arrange
    const gateway = new RecordingWorktreeGateway({ decision: decision({ removable: false, blockers: [blocker()] }) });
    const { subject } = controller(gateway);

    // Act + Assert
    await should(subject.remove(WORKTREE_PATH, { yes: true })).be.rejectedWith(/pass --discard-changes/u);
    should(gateway.removals).be.empty();
  });

  it('should proceed once the caller consents to the blocker', async () => {
    // Arrange
    const gateway = new RecordingWorktreeGateway({ decision: decision({ removable: false, blockers: [blocker()] }) });
    const { subject } = controller(gateway);

    // Act
    await subject.remove(WORKTREE_PATH, { yes: true, discardChanges: true });

    // Assert
    should(gateway.removals[0]?.overrides).eql(['discard_worktree_changes']);
  });

  it('should never let one consent flag clear a blocker it does not name', async () => {
    // Arrange — the caller accepted losing commits, not losing uncommitted edits
    const gateway = new RecordingWorktreeGateway({ decision: decision({ removable: false, blockers: [blocker()] }) });
    const { subject } = controller(gateway);

    // Act + Assert
    await should(subject.remove(WORKTREE_PATH, { yes: true, acceptUnpushed: true })).be.rejected();
    should(gateway.removals).be.empty();
  });

  it('should refuse a blocker nothing can override, whatever the caller passes', async () => {
    // Arrange
    const gateway = new RecordingWorktreeGateway({
      decision: decision({
        removable: false,
        blockers: [blocker({ code: 'active_session', message: 'a session is running here', override: undefined })],
      }),
    });
    const { subject } = controller(gateway);

    // Act + Assert
    await should(
      subject.remove(WORKTREE_PATH, {
        yes: true,
        discardChanges: true,
        acceptUnpushed: true,
        deleteUnmerged: true,
      }),
    ).be.rejectedWith(/nothing overrides this/u);
  });

  it('should carry the branch-deletion confirmations the caller granted', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act
    await subject.remove(WORKTREE_PATH, {
      yes: true,
      deleteBranch: true,
      deletePreexisting: true,
      acceptUnpushed: true,
    });

    // Assert
    should(gateway.removals[0]).match({
      deleteBranch: true,
      confirmations: ['delete_preexisting_branch', 'delete_unpushed_branch'],
    });
  });

  it('should report what was removed', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.remove(WORKTREE_PATH, { yes: true });

    // Assert
    should(out.text).containEql(`removed ${WORKTREE_PATH}`);
    should(out.text).containEql('branch port/cli-remaining kept');
  });

  it('should emit the removal payload under --json', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.remove(WORKTREE_PATH, { yes: true, json: true });

    // Assert
    should(JSON.parse(out.text)).have.property('branchRetained', true);
    should(JSON.parse(out.diagnostics[0] ?? '')).match({ phase: 'preflight', decision: { path: WORKTREE_PATH } });
    should(out.warnings).be.empty();
  });
});

describe('the removal confirmation', () => {
  it('should demand the word typed out on a terminal', async () => {
    // Arrange
    const out = new CapturingOutput();
    const gateway = new RecordingWorktreeGateway();
    const prompt = new (class extends ScriptedPrompt {
      override async ask(message: string): Promise<string> {
        should(out.text).containEql('safe to remove');
        return await super.ask(message);
      }
    })();
    const subject = new WorktreeController(gateway, out, prompt, true, CALLER_CWD);

    // Act
    await subject.remove(WORKTREE_PATH, {});

    // Assert
    should(prompt.asked).have.length(1);
    should(out.warnings[0]).containEql('This cannot be undone');
    should(gateway.removals).have.length(1);
  });

  it('should cancel when the caller types something else', async () => {
    // Arrange
    const { subject, gateway } = controller(new RecordingWorktreeGateway(), { answer: 'no' });

    // Act + Assert
    await should(subject.remove(WORKTREE_PATH, {})).be.rejectedWith('removal cancelled');
    should(gateway.removals).be.empty();
  });

  it('should accept the word with stray whitespace around it', async () => {
    // Arrange
    const { subject, gateway } = controller(new RecordingWorktreeGateway(), { answer: '  remove  ' });

    // Act
    await subject.remove(WORKTREE_PATH, {});

    // Assert
    should(gateway.removals).have.length(1);
  });

  it('should refuse off a terminal rather than silently skipping the guard', async () => {
    // Arrange
    const { subject, gateway, prompt } = controller(new RecordingWorktreeGateway(), { interactive: false });

    // Act + Assert
    await should(subject.remove(WORKTREE_PATH, {})).be.rejectedWith(/pass --yes to authorize it/u);
    should(prompt.asked).be.empty();
    should(gateway.removals).be.empty();
  });

  it('should skip the prompt entirely under --yes', async () => {
    // Arrange
    const { subject, prompt } = controller(new RecordingWorktreeGateway(), { interactive: false });

    // Act
    await subject.remove(WORKTREE_PATH, { yes: true });

    // Assert
    should(prompt.asked).be.empty();
  });
});

describe('forking a worktree', () => {
  it('should fork from the caller directory and report where to start work', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.fork(' feat/new ', {});

    // Assert
    should(gateway.creations).eql([{ sourcePath: CALLER_CWD, branch: 'feat/new', base: { kind: 'auto' } }]);
    should(out.text).containEql('start work in /managed/ferretry-new/packages/cli');
  });

  it('should send each explicit base exactly as the caller named it', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act
    await subject.fork('feat/new', { fromDefault: true });
    await subject.fork('feat/new', { fromHead: true });
    await subject.fork('feat/new', { base: 'v1.2.3', from: '/repos/other', session: 'sess-1' });

    // Assert
    should(gateway.creations.map(request => request.base)).eql([
      { kind: 'default-branch' },
      { kind: 'head' },
      { kind: 'commit', reference: 'v1.2.3' },
    ]);
    should(gateway.creations[2]).match({ sourcePath: '/repos/other', sessionId: 'sess-1' });
  });

  it('should resolve a relative source against the injected invocation cwd', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act
    await subject.fork('feat/new', { from: 'packages/daemon' });

    // Assert
    should(gateway.creations[0]?.sourcePath).equal(`${CALLER_CWD}/packages/daemon`);
  });

  it('should refuse two answers to the one question of where to start', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act + Assert
    await should(subject.fork('feat/new', { base: 'v1', fromDefault: true })).be.rejectedWith(
      'pass only one of --base, --from-default',
    );
    should(gateway.creations).be.empty();
  });

  it('should refuse a blank branch rather than forking an unnamed one', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act + Assert
    await should(subject.fork('  ', {})).be.rejectedWith('a worktree path is required');
    should(gateway.creations).be.empty();
  });

  it('should emit the protocol payload under --json', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.fork('feat/new', { json: true });

    // Assert
    should(JSON.parse(out.text)).have.property('cwd', '/managed/ferretry-new/packages/cli');
  });
});
