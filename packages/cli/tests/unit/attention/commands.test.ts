import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerAttentionCommands } from '../../../src/lib/attention/commands';
import { AttentionController } from '../../../src/lib/attention/controller';
import {
  agentItem,
  CapturingOutput,
  humanItem,
  RecordingAttentionGateway,
  resolvedItem,
  SESSION,
  snapshot,
} from './fixtures';

const board = snapshot([humanItem('A1', 'approve the deploy')], { resolved: [resolvedItem('A9', 'old ask')] });
const afterAdd = snapshot([humanItem('A1', 'approve the deploy'), agentItem('A2', 'pick a cluster')]);

function run(argv: string[], result = board) {
  const gateway = new RecordingAttentionGateway(board, result);
  const out = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerAttentionCommands(program, new AttentionController(gateway, out, SESSION));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out };
}

describe('attention command surface', () => {
  it('should refuse a first word that is not a verb, and raise nothing', async () => {
    // Arrange + Act — `fy attention show A6` once raised a real item "show A6" and notified the owner.
    const mistyped = run(['attention', 'frobnicate', 'A6'], afterAdd);
    const sentence = run(['attention', 'pick', 'a', 'cluster'], afterAdd);

    // Assert
    await should(mistyped.parsed).be.rejectedWith(
      /unknown command 'frobnicate'\. Did you mean: .*\badd\b.*\bshow\b.*\bls\b/u,
    );
    await should(sentence.parsed).be.rejectedWith(/unknown command 'pick'/u);
    should(mistyped.gateway.applied).be.empty();
    should(sentence.gateway.applied).be.empty();
    should(mistyped.out.messages).be.empty();
  });

  it('should name the add verb as the way to raise an item when a word is refused', async () => {
    // Arrange + Act
    const { parsed } = run(['attention', 'approve', 'the', 'deploy']);

    // Assert
    await should(parsed).be.rejectedWith(/attention add "<summary>"/u);
  });

  it('should refuse a bare `attention` rather than raise an empty item', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['attention']);

    // Assert
    await should(parsed).be.rejectedWith(/attention needs a command\. Did you mean: add/u);
    should(gateway.applied).be.empty();
  });

  it('should refuse a mistyped verb even when flags follow it', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['attention', 'raise', 'the deploy', '--kind', 'permission'], afterAdd);

    // Assert
    await should(parsed).be.rejected();
    should(gateway.applied).be.empty();
  });

  it('should print one open item in full on show, without writing anything', async () => {
    // Arrange + Act
    const { parsed, gateway, out } = run(['attention', 'show', 'A1']);
    await parsed;

    // Assert
    should(out.messages[0]).startWith('  !A1  [question]  approve the deploy');
    should(out.messages[0]).containEql('resolve: say yes or no');
    should(gateway.applied).be.empty();
    should(gateway.read).deepEqual([SESSION]);
  });

  it('should print a resolved item on show, accepting a sigil-less or ?-prefixed reference', async () => {
    // Arrange + Act
    const bang = run(['attention', 'show', '!A9']);
    await bang.parsed;
    const question = run(['attention', 'show', '?A9']);
    await question.parsed;

    // Assert
    should(bang.out.messages[0]).containEql('!A9  old ask · resolved by');
    should(question.out.messages[0]).equal(bang.out.messages[0]);
  });

  it('should print the item itself as JSON on show --json', async () => {
    // Arrange + Act
    const { parsed, out } = run(['attention', 'show', 'A1', '--json']);
    await parsed;

    // Assert
    should(JSON.parse(String(out.messages[0]))).match({ id: 'A1', subject: 'approve the deploy' });
  });

  it('should say so when show names an item the board does not hold', async () => {
    // Arrange + Act
    const { parsed, out } = run(['attention', 'show', 'A404']);

    // Assert
    await should(parsed).be.rejectedWith(/no attention item !A404 in /u);
    should(out.messages).be.empty();
  });

  it('should accept the explicit add verb', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['attention', 'add', 'pick a cluster'], afterAdd);
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({ subject: 'pick a cluster' });
  });

  it('should collect repeated --option into a choice ask', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(
      ['attention', 'add', 'which cluster', '--option', 'staging', '--option', 'prod'],
      afterAdd,
    );
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({
      ask: { kind: 'multiple-choice', options: [{ label: 'staging' }, { label: 'prod' }] },
    });
  });

  it('should carry the long-form add flags', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(
      [
        'attention',
        'add',
        'approve the deploy',
        '--kind',
        'permission',
        '--why',
        'the release is blocked',
        '--context',
        'smoke tests passed',
        '--resolve',
        'approve or reject on the board',
      ],
      afterAdd,
    );
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({
      ask: { kind: 'permission' },
      why: 'the release is blocked',
      context: 'smoke tests passed',
      howToResolve: 'approve or reject on the board',
    });
  });

  it('should carry the short-form add flags', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(
      ['attention', 'add', 'choose', '-k', 'choice', '-o', 'a', '-o', 'b', '-c', 'ctx', '-w', 'why', '-r', 'how'],
      afterAdd,
    );
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({ context: 'ctx', why: 'why', howToResolve: 'how' });
  });

  it('should list unresolved items on ls and its alias', async () => {
    // Arrange + Act
    const first = run(['attention', 'ls']);
    await first.parsed;
    const second = run(['attention', 'list']);
    await second.parsed;

    // Assert
    should(first.out.messages[0]).startWith('1 unresolved item');
    should(second.out.messages[0]).startWith('1 unresolved item');
  });

  it('should show the audit on history and its alias', async () => {
    // Arrange + Act
    const first = run(['attention', 'history']);
    await first.parsed;
    const second = run(['attention', 'resolved']);
    await second.parsed;

    // Assert
    should(first.out.messages[0]).startWith('Recent resolutions');
    should(second.out.messages[0]).startWith('Recent resolutions');
  });

  it('should resolve with a reference and an answer flag in either order', async () => {
    // Arrange + Act — kteam needed a recovery hack because its own parser swallowed the id here.
    const before = run(['attention', 'done', '--approve', '!A1'], snapshot([]));
    await before.parsed;
    const after = run(['attention', 'done', '!A1', '--approve'], snapshot([]));
    await after.parsed;

    // Assert
    should(before.gateway.applied[0]?.request).deepEqual({
      action: 'resolve',
      id: 'A1',
      response: { kind: 'permission', decision: 'approve' },
    });
    should(after.gateway.applied[0]?.request).deepEqual(before.gateway.applied[0]?.request);
  });

  it('should keep the reference when a value-taking flag precedes it', async () => {
    // Arrange + Act — `done --note x !A1` was broken in the source: the note swallowed the id.
    const { parsed, gateway } = run(['attention', 'done', '--note', 'shipped', '!A1'], snapshot([]));
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'resolve', id: 'A1', note: 'shipped' });
  });

  it('should accept resolve as an alias of done', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['attention', 'resolve', 'A1', '--good'], snapshot([]));
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({ response: { kind: 'answer-review', verdict: 'good' } });
  });

  it('should carry every answer flag', async () => {
    // Arrange + Act
    const choice = run(['attention', 'done', 'A1', '--choice', 'staging'], snapshot([]));
    await choice.parsed;
    const clarify = run(['attention', 'done', 'A1', '--clarify', 'which one?'], snapshot([]));
    await clarify.parsed;
    const answer = run(['attention', 'done', 'A1', '--answer', 'use staging'], snapshot([]));
    await answer.parsed;
    const reject = run(['attention', 'done', 'A1', '--reject'], snapshot([]));
    await reject.parsed;

    // Assert
    should(choice.gateway.applied[0]?.request).match({ response: { kind: 'multiple-choice', choice: 'staging' } });
    should(clarify.gateway.applied[0]?.request).match({ response: { verdict: 'clarify' } });
    should(answer.gateway.applied[0]?.request).match({ response: { kind: 'open-question', answer: 'use staging' } });
    should(reject.gateway.applied[0]?.request).match({ response: { decision: 'reject' } });
  });

  it('should dismiss with a note', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['attention', 'dismiss', 'A1', '-n', 'stale'], snapshot([]));
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'dismiss', id: 'A1', note: 'stale' });
  });

  it('should push a notification', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['attention', 'notify', 'the', 'build', 'is', 'green', '-t', 'CI']);
    await parsed;

    // Assert
    should(gateway.notified[0]?.request).deepEqual({ body: 'the build is green', title: 'CI' });
  });

  it('should honour --session on the group and on the subcommand', async () => {
    // Arrange + Act
    const onGroup = run(['attention', '--session', 'elsewhere', 'ls']);
    await onGroup.parsed;
    const onSubcommand = run(['attention', 'ls', '--session', 'elsewhere']);
    await onSubcommand.parsed;

    // Assert
    should(onGroup.gateway.read).deepEqual(['elsewhere']);
    should(onSubcommand.gateway.read).deepEqual(['elsewhere']);
  });

  it('should honour --json', async () => {
    // Arrange + Act
    const { parsed, out } = run(['attention', 'ls', '--json']);
    await parsed;

    // Assert
    should(JSON.parse(String(out.messages[0])).sessionId).equal(SESSION);
  });

  it('should surface a controller failure as a rejection the composition root can report', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['attention', 'done', 'not-a-reference']);

    // Assert
    await should(parsed).be.rejectedWith(/is not an attention reference/u);
    should(gateway.applied).be.empty();
  });

  it('should reject done without a reference', async () => {
    // Arrange + Act
    const { parsed } = run(['attention', 'done']);

    // Assert
    await should(parsed).be.rejected();
  });

  it('should teach the writing guide in its help', async () => {
    // Arrange
    let help = '';
    const gateway = new RecordingAttentionGateway(board);
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({
      writeOut: text => {
        help += text;
      },
      writeErr: () => {},
    });
    registerAttentionCommands(program, new AttentionController(gateway, new CapturingOutput(), SESSION));

    // Act
    await should(program.parseAsync(['node', 'fy', 'attention', '--help'])).be.rejected();

    // Assert — the reader of an attention item has not been following the session; the help says so.
    should(help).containEql('The reader has NOT been following this session');
  });

  it('should teach that an addressed item must be resolved or dismissed immediately, not left open', async () => {
    // Arrange
    let help = '';
    const gateway = new RecordingAttentionGateway(board);
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({
      writeOut: text => {
        help += text;
      },
      writeErr: () => {},
    });
    registerAttentionCommands(program, new AttentionController(gateway, new CapturingOutput(), SESSION));

    // Act
    await should(program.parseAsync(['node', 'fy', 'attention', '--help'])).be.rejected();

    // Assert — items never time out on their own, but must not outlive their reason. Answering or
    // dismissing on the board already resolves it; a blocker cleared some other way still needs the
    // raising agent to close it itself, immediately — there is no wording left that could be read as
    // "an addressed item may stay open".
    should(help).containEql('Answering or dismissing on the board already');
    should(help).containEql('the raising agent must run `done` or `dismiss` itself, immediately');
    should(help).containEql('whose reason is gone but is still open is a bug');
    should(help).not.containEql('never auto-clear');
  });

  it('should explain the ask kinds in the add help', async () => {
    // Arrange
    let help = '';
    const gateway = new RecordingAttentionGateway(board);
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({
      writeOut: text => {
        help += text;
      },
      writeErr: () => {},
    });
    registerAttentionCommands(program, new AttentionController(gateway, new CapturingOutput(), SESSION));

    // Act
    await should(program.parseAsync(['node', 'fy', 'attention', 'add', '--help'])).be.rejected();

    // Assert
    should(help).containEql('--kind says what the human DOES');
  });

  it('should explain the asymmetric dismissal policy in dismiss help', async () => {
    // Arrange
    let help = '';
    const program = new Command().exitOverride().configureOutput({
      writeOut: value => {
        help += value;
      },
      writeErr: () => {},
    });
    registerAttentionCommands(
      program,
      new AttentionController(new RecordingAttentionGateway(board), new CapturingOutput(), SESSION),
    );

    // Act
    await should(program.parseAsync(['node', 'fy', 'attention', 'dismiss', '--help'])).be.rejected();

    // Assert
    should(help).containEql('Agents may dismiss only attention items they raised themselves');
    should(help).containEql('A human may dismiss any attention item');
    should(help).containEql('Every dismissal remains in the resolution audit');
    should(help).match(/an agent may mutate only its own\s+session/u);
  });
});

describe('attention writing flags', () => {
  it('should collect repeated --context and --impact into bullet points on add', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(
      ['attention', 'add', 'pick', '-c', 'one', '-c', 'two', '--impact', 'blocks', '--impact', 'costs'],
      afterAdd,
    );
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({ context: '- one\n- two', impact: '- blocks\n- costs' });
  });

  it('should reword an item with edit', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['attention', 'edit', '!A1', '--summary', 'Plain ask', '-c', 'a', '-c', 'b']);
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({
      action: 'edit',
      id: 'A1',
      subject: 'Plain ask',
      context: '- a\n- b',
    });
  });

  it('should teach point form and self-contained writing in the help', async () => {
    // Arrange
    const gateway = new RecordingAttentionGateway(board);
    const program = new Command().name('fy').exitOverride();
    let help = '';
    program.configureOutput({ writeOut: text => (help += text), writeErr: () => {} });
    registerAttentionCommands(program, new AttentionController(gateway, new CapturingOutput(), SESSION));

    // Act
    await program.parseAsync(['node', 'fy', 'attention', 'edit', '--help']).catch(() => undefined);

    // Assert
    should(help).containEql('--summary');
    should(help).containEql('bullet points');
  });
});

describe('attention step flags', () => {
  it('should raise with repeated --step, edit with them, and tick with step', async () => {
    // Arrange + Act
    const added = run(['attention', 'add', 'Log in', '--step', 'Run it', '--step', 'Paste it']);
    await added.parsed;
    const edited = run(['attention', 'edit', '!A1', '--step', 'Only this']);
    await edited.parsed;
    const ticked = run(['attention', 'step', '!A1', '2', '--undo']);
    await ticked.parsed;

    // Assert
    should(added.gateway.applied[0]?.request).containDeep({ steps: ['Run it', 'Paste it'] });
    should(edited.gateway.applied[0]?.request).deepEqual({ action: 'edit', id: 'A1', steps: ['Only this'] });
    should(ticked.gateway.applied[0]?.request).deepEqual({ action: 'progress', id: 'A1', step: 1, done: false });
  });
});

describe('attention send-now command', () => {
  it('should deliver the target session’s held answers', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['attention', 'send-now', '--session', 'other-session']);
    await parsed;

    // Assert
    should(gateway.flushed).deepEqual(['other-session']);
  });
});

describe('attention needs-info command', () => {
  it('should send the owner’s request with its note', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['attention', 'needs-info', '!A1', '--note', 'Which account?'], snapshot([]));
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'needs-info', id: 'A1', note: 'Which account?' });
  });

  it('should raise a to-do with --task', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['attention', 'add', 'Log in', '--task', '--step', 'Run it'], afterAdd);
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({ action: 'add', ask: { kind: 'task' }, steps: ['Run it'] });
  });
});
