import { describe, it } from 'bun:test';
import { MAX_ATTENTION_SUBJECT_LENGTH, MAX_NOTIFICATION_BODY_LENGTH } from '@ferretry/protocol';
import should from 'should';
import { AttentionController } from '../../../src/lib/attention/controller';
import {
  CapturingOutput,
  RecordingAttentionGateway,
  SESSION,
  agentItem,
  humanItem,
  resolvedItem,
  snapshot,
} from './fixtures';

const board = snapshot([humanItem('A1', 'approve the deploy')], {
  resolved: [resolvedItem('A9', 'an old ask')],
});

function build(ownSessionId: string | undefined, result = board, delivered = 2) {
  const gateway = new RecordingAttentionGateway(board, result, delivered);
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
    await controller.add(['pick', 'a', 'cluster'], {});

    // Assert
    should(gateway.applied).deepEqual([
      {
        sessionId: SESSION,
        request: {
          action: 'add',
          source: 'agent-raised',
          sourceRef: null,
          subject: 'pick a cluster',
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
    });
  });

  it('should name the item it raised by identity, not by matching its subject', async () => {
    // Arrange — two items share a subject; kteam's text match reported whichever it found last.
    const twins = snapshot([agentItem('A1', 'same subject'), agentItem('A2', 'same subject')]);
    const gateway = new RecordingAttentionGateway(snapshot([agentItem('A1', 'same subject')]), twins);
    const out = new CapturingOutput();
    const controller = new AttentionController(gateway, out, SESSION);

    // Act
    await controller.add(['same', 'subject'], {});

    // Assert
    should(out.messages[0]).startWith('attention !A2 recorded');
  });

  it('should read the board before writing so the new id can be identified', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, after);

    // Act
    await controller.add(['pick', 'a', 'cluster'], {});

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
    await controller.add(['ours'], {});

    // Assert
    should(out.messages[0]).startWith('attention recorded — 2 unresolved items');
  });

  it('should refuse an empty ask', async () => {
    // Arrange
    const { controller } = build(SESSION);

    // Act + Assert
    await should(controller.add(['  ', ''], {})).be.rejectedWith(/say what you need/u);
  });

  it('should refuse a subject too long for one line, pointing at --context', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);
    const long = 'w'.repeat(MAX_ATTENTION_SUBJECT_LENGTH + 1);

    // Act + Assert
    await should(controller.add([long], {})).be.rejectedWith(/put the detail in --context/u);
    should(gateway.read).be.empty();
  });

  it('should flatten a multi-line ask into the single line the wire requires', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, after);

    // Act
    await controller.add(['line\none', 'line   two'], {});

    // Assert
    should(gateway.applied[0]?.request).match({ subject: 'line one line two' });
  });

  it('should reject a bad ask before touching the daemon', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.add(['choose'], { kind: 'choice', option: ['only-one'] })).be.rejected();
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
  it('should push the notification and report the devices reached', async () => {
    // Arrange
    const { controller, gateway, out } = build(SESSION, board, 3);

    // Act
    await controller.notify(['the', 'build', 'is', 'green'], { title: 'CI', kind: 'completed' });

    // Assert
    should(gateway.notified).deepEqual([
      { sessionId: SESSION, request: { body: 'the build is green', title: 'CI', kind: 'completed' } },
    ]);
    should(out.messages[0]).equal('notification sent to 3 devices');
  });

  it('should push a bare notification with no title or kind', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act
    await controller.notify(['done'], { title: '  ' });

    // Assert
    should(gateway.notified[0]?.request).deepEqual({ body: 'done' });
  });

  it('should refuse an empty notification', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.notify([' ', ''], {})).be.rejectedWith(/notify needs the notification text/u);
    should(gateway.notified).be.empty();
  });

  it('should refuse a notification longer than the protocol allows', async () => {
    // Arrange
    const { controller } = build(SESSION);
    const long = 'n'.repeat(MAX_NOTIFICATION_BODY_LENGTH + 1);

    // Act + Assert
    await should(controller.notify([long], {})).be.rejectedWith(
      new RegExp(`may not exceed ${MAX_NOTIFICATION_BODY_LENGTH} characters`, 'u'),
    );
  });

  it('should refuse a kind the protocol does not define', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.notify(['x'], { kind: 'urgent' })).be.rejectedWith(
      /notify --kind must be completed or failed, not "urgent"/u,
    );
    should(gateway.notified).be.empty();
  });

  it('should emit the delivery report under --json', async () => {
    // Arrange
    const { controller, out } = build(SESSION, board, 0);

    // Act
    await controller.notify(['x'], { json: true });

    // Assert
    should(JSON.parse(String(out.messages[0]))).deepEqual({ sessionId: SESSION, delivered: 0 });
  });
});
