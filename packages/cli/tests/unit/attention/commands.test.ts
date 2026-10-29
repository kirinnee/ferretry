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
    const mistyped = run(['agenda', 'frobnicate', 'A6'], afterAdd);
    const sentence = run(['agenda', 'pick', 'a', 'cluster'], afterAdd);

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
    const { parsed } = run(['agenda', 'approve', 'the', 'deploy']);

    // Assert
    await should(parsed).be.rejectedWith(/agenda add --title "<what>" "<the ask>"/u);
  });

  it('should refuse a bare `attention` rather than raise an empty item', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['agenda']);

    // Assert
    await should(parsed).be.rejectedWith(/agenda needs a command\. Did you mean: add/u);
    should(gateway.applied).be.empty();
  });

  it('should refuse a mistyped verb even when flags follow it', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['agenda', 'raise', 'the deploy', '--kind', 'permission'], afterAdd);

    // Assert
    await should(parsed).be.rejected();
    should(gateway.applied).be.empty();
  });

  it('should print one open item in full on show, without writing anything', async () => {
    // Arrange + Act
    const { parsed, gateway, out } = run(['agenda', 'show', 'A1']);
    await parsed;

    // Assert
    should(out.messages[0]).startWith('  !A1  [question]  approve the deploy');
    should(out.messages[0]).containEql('resolve: say yes or no');
    should(gateway.applied).be.empty();
    should(gateway.read).deepEqual([SESSION]);
  });

  it('should print a resolved item on show, accepting a sigil-less or ?-prefixed reference', async () => {
    // Arrange + Act
    const bang = run(['agenda', 'show', '!A9']);
    await bang.parsed;
    const question = run(['agenda', 'show', '?A9']);
    await question.parsed;

    // Assert
    should(bang.out.messages[0]).containEql('!A9  old ask · resolved by');
    should(question.out.messages[0]).equal(bang.out.messages[0]);
  });

  it('should print the item itself as JSON on show --json', async () => {
    // Arrange + Act
    const { parsed, out } = run(['agenda', 'show', 'A1', '--json']);
    await parsed;

    // Assert
    should(JSON.parse(String(out.messages[0]))).match({ id: 'A1', subject: 'approve the deploy' });
  });

  it('should say so when show names an item the board does not hold', async () => {
    // Arrange + Act
    const { parsed, out } = run(['agenda', 'show', 'A404']);

    // Assert
    await should(parsed).be.rejectedWith(/no agenda item !A404 in /u);
    should(out.messages).be.empty();
  });

  it('should accept the explicit add verb', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['agenda', 'add', 'pick a cluster', '--title', 'Pick a cluster'], afterAdd);
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({ subject: 'pick a cluster', title: 'Pick a cluster', kind: 'reply' });
  });

  it('should collect repeated --option into a choice ask', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(
      ['agenda', 'add', 'which cluster', '--title', 'Cluster', '--option', 'staging', '--option', 'prod'],
      afterAdd,
    );
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({
      kind: 'choice',
      ask: { kind: 'multiple-choice', options: [{ label: 'staging' }, { label: 'prod' }] },
      answers: [
        { direction: 'left', does: 'choose', label: 'prod' },
        { direction: 'right', does: 'choose', label: 'staging' },
      ],
    });
  });

  it('should carry the long-form add flags', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(
      [
        'agenda',
        'add',
        'approve the deploy',
        '--title',
        'Deploy approval',
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
      [
        'agenda',
        'add',
        'choose',
        '-t',
        'Choose',
        '-k',
        'choice',
        '-o',
        'a',
        '-o',
        'b',
        '-c',
        'ctx',
        '-w',
        'why',
        '-r',
        'how',
      ],
      afterAdd,
    );
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({ context: 'ctx', why: 'why', howToResolve: 'how' });
  });

  it('should list unresolved items on ls and its alias', async () => {
    // Arrange + Act
    const first = run(['agenda', 'ls']);
    await first.parsed;
    const second = run(['agenda', 'list']);
    await second.parsed;

    // Assert
    should(first.out.messages[0]).startWith('1 unresolved item');
    should(second.out.messages[0]).startWith('1 unresolved item');
  });

  it('should show the audit on history and its alias', async () => {
    // Arrange + Act
    const first = run(['agenda', 'history']);
    await first.parsed;
    const second = run(['agenda', 'resolved']);
    await second.parsed;

    // Assert
    should(first.out.messages[0]).startWith('Recent resolutions');
    should(second.out.messages[0]).startWith('Recent resolutions');
  });

  it('should resolve with a reference and an answer flag in either order', async () => {
    // Arrange + Act — kteam needed a recovery hack because its own parser swallowed the id here.
    const before = run(['agenda', 'done', '--approve', '!A1'], snapshot([]));
    await before.parsed;
    const after = run(['agenda', 'done', '!A1', '--approve'], snapshot([]));
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
    const { parsed, gateway } = run(['agenda', 'done', '--note', 'shipped', '!A1'], snapshot([]));
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'resolve', id: 'A1', note: 'shipped' });
  });

  it('should accept resolve as an alias of done', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['agenda', 'resolve', 'A1', '--good'], snapshot([]));
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({ response: { kind: 'answer-review', verdict: 'good' } });
  });

  it('should carry every answer flag', async () => {
    // Arrange + Act
    const choice = run(['agenda', 'done', 'A1', '--choice', 'staging'], snapshot([]));
    await choice.parsed;
    const clarify = run(['agenda', 'done', 'A1', '--clarify', 'which one?'], snapshot([]));
    await clarify.parsed;
    const answer = run(['agenda', 'done', 'A1', '--answer', 'use staging'], snapshot([]));
    await answer.parsed;
    const reject = run(['agenda', 'done', 'A1', '--reject'], snapshot([]));
    await reject.parsed;
    const other = run(['agenda', 'done', 'A1', '--other', 'neither of those'], snapshot([]));
    await other.parsed;

    // Assert
    should(choice.gateway.applied[0]?.request).match({ response: { kind: 'multiple-choice', choice: 'staging' } });
    should(clarify.gateway.applied[0]?.request).match({ response: { verdict: 'clarify' } });
    should(answer.gateway.applied[0]?.request).match({ response: { kind: 'open-question', answer: 'use staging' } });
    should(reject.gateway.applied[0]?.request).match({ response: { decision: 'reject' } });
    should(other.gateway.applied[0]?.request).match({ response: { kind: 'other', answer: 'neither of those' } });
  });

  it('should dismiss with a note', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['agenda', 'dismiss', 'A1', '-n', 'stale'], snapshot([]));
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'dismiss', id: 'A1', note: 'stale' });
  });

  it('should raise a notice for a notification', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(
      ['attention', 'notify', 'the', 'build', 'is', 'green', '-t', 'CI', '--ping'],
      afterAdd,
    );
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({
      action: 'add',
      kind: 'info',
      title: 'CI',
      subject: 'the build is green',
      notice: true,
      ping: true,
    });
  });

  it('should refuse notify --kind completed and raise nothing', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['attention', 'notify', 'all done', '--kind', 'completed']);

    // Assert
    await should(parsed).be.rejectedWith(/progress and finishing never notify the owner/u);
    should(gateway.applied).be.empty();
  });

  it('should honour --session on the group and on the subcommand', async () => {
    // Arrange + Act
    const onGroup = run(['agenda', '--session', 'elsewhere', 'ls']);
    await onGroup.parsed;
    const onSubcommand = run(['agenda', 'ls', '--session', 'elsewhere']);
    await onSubcommand.parsed;

    // Assert
    should(onGroup.gateway.read).deepEqual(['elsewhere']);
    should(onSubcommand.gateway.read).deepEqual(['elsewhere']);
  });

  it('should honour --json', async () => {
    // Arrange + Act
    const { parsed, out } = run(['agenda', 'ls', '--json']);
    await parsed;

    // Assert
    should(JSON.parse(String(out.messages[0])).sessionId).equal(SESSION);
  });

  it('should surface a controller failure as a rejection the composition root can report', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['agenda', 'done', 'not-a-reference']);

    // Assert
    await should(parsed).be.rejectedWith(/is not an agenda reference/u);
    should(gateway.applied).be.empty();
  });

  it('should reject done without a reference', async () => {
    // Arrange + Act
    const { parsed } = run(['agenda', 'done']);

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
    await should(program.parseAsync(['node', 'fy', 'agenda', '--help'])).be.rejected();

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
    await should(program.parseAsync(['node', 'fy', 'agenda', '--help'])).be.rejected();

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
    await should(program.parseAsync(['node', 'fy', 'agenda', 'add', '--help'])).be.rejected();

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
    await should(program.parseAsync(['node', 'fy', 'agenda', 'dismiss', '--help'])).be.rejected();

    // Assert
    should(help).containEql('Agents may dismiss only agenda items they raised themselves');
    should(help).containEql('A human may dismiss any agenda item');
    should(help).containEql('Every dismissal remains in the resolution audit');
    should(help).match(/an agent may mutate only its own\s+session/u);
  });
});

describe('attention writing flags', () => {
  it('should collect repeated --context and --impact into bullet points on add', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(
      ['agenda', 'add', 'pick', '-t', 'Pick', '-c', 'one', '-c', 'two', '--impact', 'blocks', '--impact', 'costs'],
      afterAdd,
    );
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({ context: '- one\n- two', impact: '- blocks\n- costs' });
  });

  it('should collect repeated --premise and --decided into bullet points on add and edit', async () => {
    // Arrange + Act
    const added = run(
      ['agenda', 'add', 'pick', '-t', 'Pick', '--premise', 'a', '--premise', 'b', '--decided', 'c', '--decided', 'd'],
      afterAdd,
    );
    await added.parsed;
    const edited = run(['agenda', 'edit', '!A1', '--premise', 'e', '--premise', 'f', '--decided', 'g']);
    await edited.parsed;

    // Assert
    should(added.gateway.applied[0]?.request).match({ premise: '- a\n- b', decided: '- c\n- d' });
    should(edited.gateway.applied[0]?.request).deepEqual({
      action: 'edit',
      id: 'A1',
      premise: '- e\n- f',
      decided: 'g',
    });
  });

  it('should collect repeated --still-open into bullet points on add and edit', async () => {
    // Arrange + Act
    const added = run(
      ['agenda', 'add', 'pick', '-t', 'Pick', '--still-open', 'rollback plan', '--still-open', 'who signs'],
      afterAdd,
    );
    await added.parsed;
    const edited = run(['agenda', 'edit', '!A1', '--still-open', 'who signs']);
    await edited.parsed;

    // Assert
    should(added.gateway.applied[0]?.request).match({ stillOpen: '- rollback plan\n- who signs' });
    should(edited.gateway.applied[0]?.request).deepEqual({ action: 'edit', id: 'A1', stillOpen: 'who signs' });
  });

  it('should reword an item with edit', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['agenda', 'edit', '!A1', '--summary', 'Plain ask', '-c', 'a', '-c', 'b']);
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
    await program.parseAsync(['node', 'fy', 'agenda', 'edit', '--help']).catch(() => undefined);

    // Assert
    should(help).containEql('--summary');
    should(help).containEql('bullet points');
  });
});

describe('attention step flags', () => {
  it('should raise with repeated --step, edit with them, and tick with step', async () => {
    // Arrange + Act
    const added = run(['agenda', 'add', 'Log in', '--title', 'Log in', '--step', 'Run it', '--step', 'Paste it']);
    await added.parsed;
    const edited = run(['agenda', 'edit', '!A1', '--step', 'Only this']);
    await edited.parsed;
    const ticked = run(['agenda', 'step', '!A1', '2', '--undo']);
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
    const { parsed, gateway } = run(['agenda', 'send-now', '--session', 'other-session']);
    await parsed;

    // Assert
    should(gateway.flushed).deepEqual(['other-session']);
  });
});

describe('attention discuss command', () => {
  it('should send the owner’s request to talk it through, with its note', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['agenda', 'discuss', '!A1', '--note', 'Why this account?'], snapshot([]));
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'discuss', id: 'A1', note: 'Why this account?' });
  });
});

describe('attention surface command', () => {
  it('should send the surface request with its why, and without one when none is given', async () => {
    // Arrange + Act
    const withWhy = run(['agenda', 'surface', '!A1', '--why', 'Still open: which region'], snapshot([]));
    await withWhy.parsed;
    const bare = run(['agenda', 'surface', 'A2'], snapshot([]));
    await bare.parsed;

    // Assert
    should(withWhy.gateway.applied[0]?.request).deepEqual({
      action: 'surface',
      id: 'A1',
      why: 'Still open: which region',
    });
    should(bare.gateway.applied[0]?.request).deepEqual({ action: 'surface', id: 'A2' });
  });

  it('should no longer take --surface on add: a new ask is the owner’s turn', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(
      ['agenda', 'add', 'pick a cluster', '--title', 'Pick a cluster', '--surface'],
      afterAdd,
    );

    // Assert
    await should(parsed).be.rejectedWith(/unknown option '--surface'/u);
    should(gateway.applied).be.empty();
  });
});

describe('attention needs-info command', () => {
  it('should send the owner’s request with its note', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['agenda', 'needs-info', '!A1', '--note', 'Which account?'], snapshot([]));
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'needs-info', id: 'A1', note: 'Which account?' });
  });

  it('should raise a to-do with --task', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(
      ['agenda', 'add', 'Log in', '--title', 'Log in', '--task', '--step', 'Run it'],
      afterAdd,
    );
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({ action: 'add', ask: { kind: 'task' }, steps: ['Run it'] });
  });
});

describe('attention card flags', () => {
  it('should refuse an add with no title', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['agenda', 'add', 'approve the deploy']);

    // Assert
    await should(parsed).be.rejectedWith(/give the card a title: --title/u);
    should(gateway.applied).be.empty();
  });

  it('should take --ask as the one-line ask and keep --summary working', async () => {
    // Arrange + Act
    const ask = run(['agenda', 'add', '--title', 'Deploy', '--ask', 'Approve the deploy?'], afterAdd);
    await ask.parsed;
    const summary = run(['agenda', 'add', '--title', 'Deploy', '--summary', 'Approve the deploy?'], afterAdd);
    await summary.parsed;

    // Assert
    should(ask.gateway.applied[0]?.request).match({ subject: 'Approve the deploy?' });
    should(summary.gateway.applied[0]?.request).match({ subject: 'Approve the deploy?' });
  });

  it('should add the up answer with --up and --up-why on a permission card', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(
      [
        'agenda',
        'add',
        'Run it?',
        '-t',
        'Run',
        '-k',
        'permission',
        '--up',
        'Always allow',
        '--up-why',
        'for this repo',
      ],
      afterAdd,
    );
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).match({
      kind: 'permission',
      answers: [
        { direction: 'left', label: 'Deny' },
        { direction: 'up', does: 'approve', label: 'Always allow', description: 'for this repo' },
        { direction: 'right', label: 'Allow' },
      ],
    });
  });

  it('should refuse --up on a kind that has no up answer', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['agenda', 'add', 'Ok?', '-t', 'Ok', '-k', 'yesno', '--up', 'Maybe']);

    // Assert
    await should(parsed).be.rejectedWith(/--up only fits --kind task/u);
    should(gateway.applied).be.empty();
  });

  it('should refuse more than three options with the split advice', async () => {
    // Arrange + Act
    const { parsed, gateway } = run([
      'agenda',
      'add',
      'Which?',
      '-t',
      'Which',
      '-o',
      'a',
      '-o',
      'b',
      '-o',
      'c',
      '-o',
      'd',
    ]);

    // Assert
    await should(parsed).be.rejectedWith(/a card offers at most 3 answers/u);
    should(gateway.applied).be.empty();
  });

  it('should refuse --option on a yesno card', async () => {
    // Arrange + Act
    const { parsed } = run(['agenda', 'add', 'Ok?', '-t', 'Ok', '-k', 'yesno', '-o', 'a', '-o', 'b']);

    // Assert
    await should(parsed).be.rejectedWith(/--kind yesno brings its own Yes and No/u);
  });

  it('should retitle with edit --title', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['agenda', 'edit', 'A1', '--title', 'Deploy approval']);
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'edit', id: 'A1', title: 'Deploy approval' });
  });

  it('should answer a yes or no card with done --yes and --no', async () => {
    // Arrange + Act
    const yes = run(['agenda', 'done', 'A1', '--yes'], snapshot([]));
    await yes.parsed;
    const no = run(['agenda', 'done', 'A1', '--no'], snapshot([]));
    await no.parsed;

    // Assert
    should(yes.gateway.applied[0]?.request).match({ response: { kind: 'multiple-choice', choice: 'Yes' } });
    should(no.gateway.applied[0]?.request).match({ response: { kind: 'multiple-choice', choice: 'No' } });
  });

  it('should name the card flags in the add help', async () => {
    // Arrange
    let help = '';
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({ writeOut: text => (help += text), writeErr: () => {} });
    registerAttentionCommands(
      program,
      new AttentionController(new RecordingAttentionGateway(board), new CapturingOutput(), SESSION),
    );

    // Act
    await program.parseAsync(['node', 'fy', 'agenda', 'add', '--help']).catch(() => undefined);

    // Assert
    for (const flag of ['--title', '--ask', '--up', '--up-why']) should(help).containEql(flag);
  });
});
