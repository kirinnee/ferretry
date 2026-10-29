import { describe, it } from 'bun:test';
import { MAX_ATTENTION_SUBJECT_LENGTH } from '@ferretry/protocol';
import should from 'should';
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

const board = snapshot([humanItem('A1', 'approve the deploy')], {
  resolved: [resolvedItem('A9', 'an old ask')],
});

function build(ownSessionId: string | undefined, result = board) {
  const gateway = new RecordingAttentionGateway(board, result);
  const out = new CapturingOutput();
  return { gateway, out, controller: new AttentionController(gateway, out, ownSessionId) };
}

describe('attention controller targeting', () => {
  it('should default to the session the command runs inside', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act
    await controller.list({});

    // Assert
    should(gateway.read).deepEqual([SESSION]);
  });

  it('should let --session target another board', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act
    await controller.list({ session: '  elsewhere  ' });

    // Assert
    should(gateway.read).deepEqual(['elsewhere']);
  });

  it('should refuse to guess when no session is known', async () => {
    // Arrange
    const { controller } = build(undefined);

    // Act + Assert
    await should(controller.list({})).be.rejectedWith(/no session id/u);
  });

  it('should treat a blank session id as absent', async () => {
    // Arrange
    const { controller } = build('   ');

    // Act + Assert
    await should(controller.history({ session: ' ' })).be.rejectedWith(/no session id/u);
  });
});

describe('attention controller reads', () => {
  it('should render the unresolved listing', async () => {
    // Arrange
    const { controller, out } = build(SESSION);

    // Act
    await controller.list({});

    // Assert
    should(out.messages[0]).startWith(`1 unresolved item in ${SESSION}`);
  });

  it('should render the resolution audit', async () => {
    // Arrange
    const { controller, out } = build(SESSION);

    // Act
    await controller.history({});

    // Assert
    should(out.messages[0]).startWith(`Recent resolutions in ${SESSION}`);
  });

  it('should emit the protocol snapshot under --json for both reads', async () => {
    // Arrange
    const { controller, out } = build(SESSION);

    // Act
    await controller.list({ json: true });
    await controller.history({ json: true });

    // Assert
    should(JSON.parse(String(out.messages[0]))).deepEqual(JSON.parse(JSON.stringify(board)));
    should(JSON.parse(String(out.messages[1]))).deepEqual(JSON.parse(JSON.stringify(board)));
  });
});

describe('attention controller add', () => {
  const after = snapshot([humanItem('A1', 'approve the deploy'), agentItem('A2', 'pick a cluster')]);

  it('should send the ask with sensible defaults for why and how to resolve', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, after);

    // Act
    await controller.add(['pick', 'a', 'cluster'], { title: 'Pick a cluster' });

    // Assert
    should(gateway.applied).deepEqual([
      {
        sessionId: SESSION,
        request: {
          action: 'add',
          source: 'agent-raised',
          sourceRef: null,
          subject: 'pick a cluster',
          title: 'Pick a cluster',
          kind: 'reply',
          why: 'pick a cluster',
          context: null,
          howToResolve: 'Answer this item on the attention board (it records who answered).',
          ask: { kind: 'open-question' },
        },
      },
    ]);
  });

  it('should carry the explicit why, context, resolve and ask kind', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, after);

    // Act
    await controller.add(['approve', 'the', 'deploy'], {
      title: 'Deploy approval',
      why: 'the release is blocked',
      context: 'the smoke test passed',
      resolve: 'run `fy attention done !A2 --approve`',
      kind: 'permission',
    });

    // Assert
    should(gateway.applied[0]?.request).match({
      why: 'the release is blocked',
      context: 'the smoke test passed',
      howToResolve: 'run `fy attention done !A2 --approve`',
      ask: { kind: 'permission' },
      kind: 'permission',
      title: 'Deploy approval',
      answers: [
        { direction: 'left', does: 'reject', label: 'Deny' },
        { direction: 'right', does: 'approve', label: 'Allow' },
      ],
    });
  });

  it('should name the item it raised by identity, not by matching its subject', async () => {
    // Arrange — two items share a subject; kteam's text match reported whichever it found last.
    const twins = snapshot([agentItem('A1', 'same subject'), agentItem('A2', 'same subject')]);
    const gateway = new RecordingAttentionGateway(snapshot([agentItem('A1', 'same subject')]), twins);
    const out = new CapturingOutput();
    const controller = new AttentionController(gateway, out, SESSION);

    // Act
    await controller.add(['same', 'subject'], { title: 'Pick a cluster' });

    // Assert
    should(out.messages[0]).startWith('attention !A2 recorded');
  });

  it('should read the board before writing so the new id can be identified', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, after);

    // Act
    await controller.add(['pick', 'a', 'cluster'], { title: 'Pick a cluster' });

    // Assert
    should(gateway.read).deepEqual([SESSION]);
  });

  it('should confirm without a reference when the new id cannot be told apart', async () => {
    // Arrange — a concurrent raise leaves two new ids, so neither can be claimed as ours.
    const crowded = snapshot([agentItem('A2', 'ours'), agentItem('A3', 'someone else')]);
    const gateway = new RecordingAttentionGateway(snapshot([]), crowded);
    const out = new CapturingOutput();
    const controller = new AttentionController(gateway, out, SESSION);

    // Act
    await controller.add(['ours'], { title: 'Pick a cluster' });

    // Assert
    should(out.messages[0]).startWith('attention recorded — 2 unresolved items');
  });

  it('should raise the brief a --json-file body describes', async () => {
    // Arrange
    const gateway = new RecordingAttentionGateway(board, board);
    const read: string[] = [];
    const input = {
      read: async (path: string) => {
        read.push(path);
        return JSON.stringify({ summary: 'Approve the plan', questions: ['Which plan?', 'When?'] });
      },
    };
    const controller = new AttentionController(gateway, new CapturingOutput(), SESSION, input);

    // Act
    await controller.add([], { jsonFile: '-', title: 'Plan approval' });

    // Assert
    should(read).deepEqual(['-']);
    should(gateway.applied[0]?.request).containDeep({
      action: 'add',
      subject: 'Approve the plan',
      ask: { kind: 'open-question' },
      questions: [{ question: 'Which plan?' }, { question: 'When?' }],
    });
  });

  it('should say a --json-file cannot be read where nothing reads one', async () => {
    // Arrange
    const { controller } = build(SESSION);

    // Act + Assert
    await should(controller.add([], { jsonFile: 'brief.json' })).be.rejectedWith(/--json-file cannot be read here/u);
  });

  it('should refuse an empty ask', async () => {
    // Arrange
    const { controller } = build(SESSION);

    // Act + Assert
    await should(controller.add(['  ', ''], { title: 'T' })).be.rejectedWith(/say what you need/u);
  });

  it('should refuse a card with no title before touching the daemon', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.add(['approve the deploy'], {})).be.rejectedWith(/give the card a title: --title/u);
    should(gateway.read).be.empty();
  });

  it('should refuse a subject too long for one line, pointing at --context', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);
    const long = 'w'.repeat(MAX_ATTENTION_SUBJECT_LENGTH + 1);

    // Act + Assert
    await should(controller.add([long], { title: 'T' })).be.rejectedWith(/put the detail in --context/u);
    should(gateway.read).be.empty();
  });

  it('should flatten a multi-line ask into the single line the wire requires', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, after);

    // Act
    await controller.add(['line\none', 'line   two'], { title: 'T' });

    // Assert
    should(gateway.applied[0]?.request).match({ subject: 'line one line two' });
  });

  it('should reject a bad ask before touching the daemon', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.add(['choose'], { title: 'T', kind: 'choice', option: ['only-one'] })).be.rejected();
    should(gateway.read).be.empty();
  });
});

describe('attention controller resolve and dismiss', () => {
  it('should resolve an item with the answer it carries', async () => {
    // Arrange
    const { controller, gateway, out } = build(SESSION, snapshot([]));

    // Act
    await controller.resolve('!A1', { approve: true, note: '  after the smoke test  ' });

    // Assert
    should(gateway.applied).deepEqual([
      {
        sessionId: SESSION,
        request: {
          action: 'resolve',
          id: 'A1',
          note: 'after the smoke test',
          response: { kind: 'permission', decision: 'approve' },
        },
      },
    ]);
    should(out.messages[0]).equal(`resolved !A1 — 0 unresolved items in ${SESSION}`);
  });

  it('should answer a yes or no card with --yes and --no', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, snapshot([]));

    // Act
    await controller.resolve('A1', { yes: true });
    await controller.resolve('A2', { no: true });

    // Assert
    should(gateway.applied.map(call => (call.request as { response?: unknown }).response)).deepEqual([
      { kind: 'multiple-choice', choice: 'Yes' },
      { kind: 'multiple-choice', choice: 'No' },
    ]);
  });

  it('should refuse --yes with another answer', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.resolve('A1', { yes: true, no: true })).be.rejectedWith(/exactly one answer/u);
    await should(controller.resolve('A1', { yes: true, approve: true })).be.rejectedWith(/exactly one answer/u);
    should(gateway.applied).be.empty();
  });

  it('should resolve an item that has no ask and no note', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, snapshot([]));

    // Act
    await controller.resolve('A1', {});

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'resolve', id: 'A1' });
  });

  it('should drop a blank note rather than record an empty one', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, snapshot([]));

    // Act
    await controller.resolve('A1', { note: '   ' });

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'resolve', id: 'A1' });
  });

  it('should dismiss an item with its note', async () => {
    // Arrange
    const { controller, gateway, out } = build(SESSION, snapshot([]));

    // Act
    await controller.dismiss('?A1', { note: 'no longer relevant' });

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'dismiss', id: 'A1', note: 'no longer relevant' });
    should(out.messages[0]).equal(`dismissed !A1 — 0 unresolved items in ${SESSION}`);
  });

  it('should dismiss without a note', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, snapshot([]));

    // Act
    await controller.dismiss('A1', {});

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'dismiss', id: 'A1' });
  });

  it('should reject an unparseable reference before touching the daemon', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.resolve('nope', {})).be.rejectedWith(/is not an attention reference/u);
    await should(controller.dismiss('nope', {})).be.rejectedWith(/is not an attention reference/u);
    should(gateway.applied).be.empty();
  });

  it('should reject conflicting answers before touching the daemon', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.resolve('A1', { approve: true, reject: true })).be.rejectedWith(/exactly one answer/u);
    should(gateway.applied).be.empty();
  });

  it('should emit the protocol snapshot under --json', async () => {
    // Arrange
    const { controller, out } = build(SESSION, snapshot([]));

    // Act
    await controller.dismiss('A1', { json: true });

    // Assert
    should(JSON.parse(String(out.messages[0])).count).equal(0);
  });
});

describe('attention controller notify', () => {
  const raised = snapshot([humanItem('A1', 'approve the deploy'), agentItem('A2', 'the build is green')]);

  it('should raise an info item instead of pushing a bare notification', async () => {
    // Arrange
    const { controller, gateway, out } = build(SESSION, raised);

    // Act
    await controller.notify(['the', 'build', 'is', 'green'], { title: 'CI' });

    // Assert
    should(gateway.applied).have.length(1);
    should(gateway.applied[0]?.request).containDeep({
      action: 'add',
      kind: 'info',
      title: 'CI',
      subject: 'the build is green',
      answers: [{ direction: 'right', does: 'done', label: 'Got it' }],
    });
    should(gateway.applied[0]?.request).not.have.property('ask');
    should(out.messages[0]).startWith('info !A2 raised — 2 unresolved items');
  });

  it('should title the item with the start of the text, clipped at a word to 40, when no title is given', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, raised);

    // Act
    await controller.notify(['The nightly build finished and every check passed this time around'], {});

    // Assert
    const request = gateway.applied[0]?.request;
    should(request).have.property('title', 'The nightly build finished and every…');
    should(request).have.property('subject', 'The nightly build finished and every check passed this time around');
    should(request).have.property('context', null);
  });

  it('should keep a text too long for one line whole in the context and clip the ask', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, raised);
    const long = `${'word '.repeat(80)}end`;

    // Act
    await controller.notify([long], { title: 'Long one' });

    // Assert
    const request = gateway.applied[0]?.request;
    should(request).have.property('context', long);
    should(String((request as { subject: string }).subject).length).be.belowOrEqual(MAX_ATTENTION_SUBJECT_LENGTH);
    should((request as { subject: string }).subject).endWith('…');
  });

  it('should refuse an empty notification', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.notify([' ', ''], {})).be.rejectedWith(/notify needs the notification text/u);
    should(gateway.applied).be.empty();
  });

  it('should refuse --kind completed and failed with the advice, raising nothing', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);
    const advice =
      'progress and finishing never notify the owner — raise an item (fy attention add) only when they must decide or do something';

    // Act + Assert
    await should(controller.notify(['all done'], { kind: 'completed' })).be.rejectedWith(advice);
    await should(controller.notify(['it broke'], { kind: 'failed' })).be.rejectedWith(advice);
    should(gateway.applied).be.empty();
    should(gateway.read).be.empty();
  });

  it('should refuse any other --kind too', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.notify(['x'], { kind: 'urgent' })).be.rejectedWith(/notify takes no --kind/u);
    should(gateway.applied).be.empty();
  });

  it('should refuse a title past the limit', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.notify(['x'], { title: 't'.repeat(61) })).be.rejectedWith(/title may not exceed 60/u);
    should(gateway.applied).be.empty();
  });

  it('should emit the snapshot under --json', async () => {
    // Arrange
    const { controller, out } = build(SESSION, raised);

    // Act
    await controller.notify(['x'], { json: true });

    // Assert
    should(JSON.parse(String(out.messages[0])).count).equal(2);
  });
});

describe('attention controller edit', () => {
  it('should send only the given wording and say it was edited, with any advice', async () => {
    // Arrange
    const warned = { ...board, warnings: ['summary is long'] };
    const { controller, gateway, out } = build(SESSION, warned);

    // Act
    await controller.edit('!A1', { summary: 'Approve the deploy?', context: ['one', 'two'] });

    // Assert
    should(gateway.applied[0]).deepEqual({
      sessionId: SESSION,
      request: { action: 'edit', id: 'A1', subject: 'Approve the deploy?', context: '- one\n- two' },
    });
    should(out.messages[0]).containEql('edited !A1');
    should(out.messages[0]).containEql('summary is long');
  });

  it('should retitle an item and send nothing else', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act
    await controller.edit('A1', { title: 'Deploy approval' });

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'edit', id: 'A1', title: 'Deploy approval' });
  });

  it('should refuse a title over 60 characters on edit', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.edit('A1', { title: 't'.repeat(61) })).be.rejectedWith(/title may not exceed 60/u);
    should(gateway.applied).be.empty();
  });

  it('should read the board only when question wording needs the current questions', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act
    await controller.edit('A1', { summary: 'Plain' });

    // Assert
    should(gateway.read).deepEqual([]);
  });

  it('should read the board to reword questions in place', async () => {
    // Arrange
    const asked = snapshot([
      {
        ...humanItem('A1', 'approve the deploy'),
        questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      },
    ]);
    const gateway = new RecordingAttentionGateway(asked);
    const controller = new AttentionController(gateway, new CapturingOutput(), SESSION);

    // Act
    await controller.edit('A1', { question: ['Ship it today?'] });

    // Assert
    should(gateway.read).deepEqual([SESSION]);
    should(gateway.applied[0]?.request).containDeep({
      action: 'edit',
      questions: [{ question: 'Ship it today?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    });
  });
});

describe('attention controller steps and body', () => {
  const withInput = (files: Record<string, string>) => {
    const gateway = new RecordingAttentionGateway(board, board);
    const input = { read: async (path: string) => files[path] ?? '' };
    return { gateway, controller: new AttentionController(gateway, new CapturingOutput(), SESSION, input) };
  };

  it('should raise steps and a body-file body, and replace them on edit', async () => {
    // Arrange
    const { gateway, controller } = withInput({ 'body.md': '## Notes', '-': '## From stdin' });

    // Act
    await controller.add(['Log in'], { title: 'Log in', step: ['Run `fy login`'], bodyFile: 'body.md' });
    await controller.edit('A1', { step: ['One'], bodyFile: '-' });

    // Assert
    should(gateway.applied[0]?.request).containDeep({ steps: ['Run `fy login`'], body: '## Notes' });
    should(gateway.applied[1]?.request).deepEqual({ action: 'edit', id: 'A1', steps: ['One'], body: '## From stdin' });
  });

  it('should refuse both bodies reading standard input, and a body-file where nothing reads one', async () => {
    // Arrange
    const { controller } = withInput({});
    const { controller: bare } = build(SESSION);

    // Act + Assert
    await should(controller.add(['x'], { jsonFile: '-', bodyFile: '-' })).be.rejectedWith(
      /cannot both read standard input/u,
    );
    await should(bare.add(['x'], { bodyFile: 'body.md' })).be.rejectedWith(/--body-file cannot be read here/u);
  });

  it('should tick a step counted from 1, untick it with --undo, and refuse a bad number', async () => {
    // Arrange
    const { gateway, controller } = withInput({});
    const out = new CapturingOutput();
    const loud = new AttentionController(gateway, out, SESSION);

    // Act
    await controller.step('!A1', '2', {});
    await loud.step('A1', ' 1 ', { undo: true });

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'progress', id: 'A1', step: 1, done: true });
    should(gateway.applied[1]?.request).deepEqual({ action: 'progress', id: 'A1', step: 0, done: false });
    should(out.messages[0]).containEql('unticked step 1 of !A1');
    await should(controller.step('A1', '0', {})).be.rejectedWith(/counts from 1/u);
    await should(controller.step('A1', 'two', {})).be.rejectedWith(/counts from 1/u);
  });
});

describe('attention controller send-now', () => {
  it('should deliver the held answers now and name the items that went', async () => {
    // Arrange
    const held = { ...board, replies: { pending: ['A2', 'A3'], dueAt: '2026-07-31T10:05:08.000Z' } };
    const gateway = new RecordingAttentionGateway(held, board);
    const out = new CapturingOutput();
    const controller = new AttentionController(gateway, out, SESSION);

    // Act
    await controller.sendNow({});

    // Assert
    should(gateway.flushed).deepEqual([SESSION]);
    should(out.messages).deepEqual([`sent !A2, !A3 to ${SESSION} now`]);
  });

  it('should say when nothing was held', async () => {
    // Arrange
    const { gateway, out, controller } = build(SESSION);

    // Act
    await controller.sendNow({});

    // Assert
    should(gateway.flushed).deepEqual([SESSION]);
    should(out.messages).deepEqual([`no answers were held for ${SESSION} — nothing to send`]);
  });
});

describe('attention controller needs-info', () => {
  it('should ask for more information with the note, and say the item stays open', async () => {
    // Arrange
    const { controller, gateway, out } = build(SESSION, snapshot([humanItem('A1', 'log in')]));

    // Act
    await controller.needsInfo('?A1', { note: '  Which account?  ' });

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'needs-info', id: 'A1', note: 'Which account?' });
    should(out.messages[0]).containEql('asked for more information on !A1');
  });

  it('should send no note when none was given, and reject a bad reference before the daemon', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, snapshot([]));

    // Act
    await controller.needsInfo('A1', {});

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'needs-info', id: 'A1' });
    await should(controller.needsInfo('nope', {})).be.rejected();
    should(gateway.applied).have.length(1);
  });
});
