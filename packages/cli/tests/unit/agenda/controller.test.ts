import { describe, it } from 'bun:test';
import { MAX_AGENDA_SUBJECT_LENGTH } from '@ferretry/protocol';
import should from 'should';
import { AgendaController } from '../../../src/lib/agenda/controller';
import {
  agentItem,
  CapturingOutput,
  humanItem,
  RecordingAgendaGateway,
  resolvedItem,
  SESSION,
  snapshot,
} from './fixtures';

const board = snapshot([humanItem('A1', 'approve the deploy')], {
  resolved: [resolvedItem('A9', 'an old ask')],
});

function build(ownSessionId: string | undefined, result = board) {
  const gateway = new RecordingAgendaGateway(board, result);
  const out = new CapturingOutput();
  return { gateway, out, controller: new AgendaController(gateway, out, ownSessionId) };
}

describe('agenda controller targeting', () => {
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

describe('agenda controller reads', () => {
  it('should render the unresolved listing', async () => {
    // Arrange
    const { controller, out } = build(SESSION);

    // Act
    await controller.list({});

    // Assert
    should(out.messages[0]).startWith(`1 open item in ${SESSION}`);
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

/** The premise and context every new item a ferret raises must carry. */
const BRIEF = { premise: ['A ferret needs the owner.'], context: ['The work waits on this answer.'] };

describe('agenda controller add', () => {
  const after = snapshot([humanItem('A1', 'approve the deploy'), agentItem('A2', 'pick a cluster')]);

  it('should send the ask with sensible defaults for why and how to resolve', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, after);

    // Act
    await controller.add(['pick', 'a', 'cluster'], { ...BRIEF, title: 'Pick a cluster' });

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
          premise: 'A ferret needs the owner.',
          context: 'The work waits on this answer.',
          howToResolve: 'Answer this item on the agenda (it records who answered).',
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
      ...BRIEF,
      title: 'Deploy approval',
      why: 'the release is blocked',
      context: ['the smoke test passed'],
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
    const gateway = new RecordingAgendaGateway(snapshot([agentItem('A1', 'same subject')]), twins);
    const out = new CapturingOutput();
    const controller = new AgendaController(gateway, out, SESSION);

    // Act
    await controller.add(['same', 'subject'], { ...BRIEF, title: 'Pick a cluster' });

    // Assert
    should(out.messages[0]).startWith('agenda !A2 recorded');
  });

  it('should read the board before writing so the new id can be identified', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, after);

    // Act
    await controller.add(['pick', 'a', 'cluster'], { ...BRIEF, title: 'Pick a cluster' });

    // Assert
    should(gateway.read).deepEqual([SESSION]);
  });

  it('should confirm without a reference when the new id cannot be told apart', async () => {
    // Arrange — a concurrent raise leaves two new ids, so neither can be claimed as ours.
    const crowded = snapshot([agentItem('A2', 'ours'), agentItem('A3', 'someone else')]);
    const gateway = new RecordingAgendaGateway(snapshot([]), crowded);
    const out = new CapturingOutput();
    const controller = new AgendaController(gateway, out, SESSION);

    // Act
    await controller.add(['ours'], { ...BRIEF, title: 'Pick a cluster' });

    // Assert
    should(out.messages[0]).startWith('agenda item recorded — 2 open items');
  });

  it('should raise the brief a --json-file body describes', async () => {
    // Arrange
    const gateway = new RecordingAgendaGateway(board, board);
    const read: string[] = [];
    const input = {
      read: async (path: string) => {
        read.push(path);
        return JSON.stringify({
          summary: 'Approve the plan',
          premise: ['Two plans are written'],
          context: 'The work waits on the pick.',
          questions: ['Which plan?', 'When?'],
        });
      },
    };
    const controller = new AgendaController(gateway, new CapturingOutput(), SESSION, input);

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
    const long = 'w'.repeat(MAX_AGENDA_SUBJECT_LENGTH + 1);

    // Act + Assert
    await should(controller.add([long], { title: 'T' })).be.rejectedWith(/put the detail in --context/u);
    should(gateway.read).be.empty();
  });

  it('should flatten a multi-line ask into the single line the wire requires', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, after);

    // Act
    await controller.add(['line\none', 'line   two'], { ...BRIEF, title: 'T' });

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

describe('agenda controller resolve and dismiss', () => {
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
    should(out.messages[0]).equal(`resolved !A1 — 0 open items in ${SESSION}`);
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
    should(out.messages[0]).equal(`dismissed !A1 — 0 open items in ${SESSION}`);
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
    await should(controller.resolve('nope', {})).be.rejectedWith(/is not an agenda reference/u);
    await should(controller.dismiss('nope', {})).be.rejectedWith(/is not an agenda reference/u);
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

describe('agenda controller edit', () => {
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
    const gateway = new RecordingAgendaGateway(asked);
    const controller = new AgendaController(gateway, new CapturingOutput(), SESSION);

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

describe('agenda controller steps and body', () => {
  const withInput = (files: Record<string, string>) => {
    const gateway = new RecordingAgendaGateway(board, board);
    const input = { read: async (path: string) => files[path] ?? '' };
    return { gateway, controller: new AgendaController(gateway, new CapturingOutput(), SESSION, input) };
  };

  it('should raise steps and a body-file body, and replace them on edit', async () => {
    // Arrange
    const { gateway, controller } = withInput({ 'body.md': '## Notes', '-': '## From stdin' });

    // Act
    await controller.add(['Log in'], { ...BRIEF, title: 'Log in', step: ['Run `fy login`'], bodyFile: 'body.md' });
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
    const loud = new AgendaController(gateway, out, SESSION);

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

describe('agenda controller send-now', () => {
  it('should deliver the held answers now and name the items that went', async () => {
    // Arrange
    const held = { ...board, replies: { pending: ['A2', 'A3'], dueAt: '2026-07-31T10:05:08.000Z' } };
    const gateway = new RecordingAgendaGateway(held, board);
    const out = new CapturingOutput();
    const controller = new AgendaController(gateway, out, SESSION);

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

describe('agenda controller discuss', () => {
  it('should ask to discuss with the note, and say the item stays open', async () => {
    // Arrange
    const { controller, gateway, out } = build(SESSION, snapshot([humanItem('A1', 'log in')]));

    // Act
    await controller.discuss('?A1', { note: '  Why this account?  ' });

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'discuss', id: 'A1', note: 'Why this account?' });
    should(out.messages[0]).containEql('asked to discuss !A1');
  });

  it('should send no note when none was given, and reject a bad reference before the daemon', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, snapshot([]));

    // Act
    await controller.discuss('A1', {});

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'discuss', id: 'A1' });
    await should(controller.discuss('nope', {})).be.rejected();
    should(gateway.applied).have.length(1);
  });
});

describe('agenda controller surface', () => {
  it('should surface with a trimmed why, and say the item is on the owner queue', async () => {
    // Arrange
    const { controller, gateway, out } = build(SESSION, snapshot([humanItem('A1', 'log in')]));

    // Act
    await controller.surface('?A1', { why: '  Still open: the account  ' });

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'surface', id: 'A1', why: 'Still open: the account' });
    should(out.messages[0]).containEql('surfaced !A1');
  });

  it('should send no why when none was given, and reject a bad reference before the daemon', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, snapshot([]));

    // Act
    await controller.surface('A1', {});

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'surface', id: 'A1' });
    await should(controller.surface('nope', {})).be.rejected();
    should(gateway.applied).have.length(1);
  });
});

describe('agenda controller needs-info', () => {
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

describe('agenda controller clear --agents', () => {
  const NEW_DAEMON = ['agenda.clear-agents.1'];
  const owner = (answer: string | null, interactive = true) => {
    const gateway = new RecordingAgendaGateway(board);
    gateway.offered = NEW_DAEMON;
    gateway.clearing = { cleared: 3, sessions: 2 };
    const out = new CapturingOutput();
    const asked: string[] = [];
    const prompt = {
      interactive: () => interactive,
      ask: async (message: string) => {
        asked.push(message);
        return answer ?? '';
      },
    };
    return {
      gateway,
      out,
      asked,
      controller: new AgendaController(gateway, out, undefined, undefined, undefined, prompt),
    };
  };

  it('should count, ask, and clear when the owner says yes', async () => {
    // Arrange
    const { controller, gateway, out, asked } = owner('y');

    // Act
    await controller.clearAgents({ agents: true });

    // Assert
    should(gateway.clears).deepEqual([true, false]);
    should(asked).deepEqual(['Dismiss 3 open agenda items on 2 agent ferrets? [y/N]']);
    should(out.messages).deepEqual(['cleared 3 open agenda items on 2 agent ferrets']);
  });

  it('should clear without asking under --yes, and print the payload under --json', async () => {
    // Arrange
    const { controller, gateway, out, asked } = owner(null);

    // Act
    await controller.clearAgents({ agents: true, yes: true, json: true });

    // Assert
    should(asked).be.empty();
    should(gateway.clears).deepEqual([true, false]);
    should(JSON.parse(out.messages[0] ?? '')).deepEqual({ cleared: 3, sessions: 2 });
  });

  it('should clear nothing when the owner declines', async () => {
    // Arrange
    const { controller, gateway, out } = owner('no');

    // Act
    await controller.clearAgents({ agents: true });

    // Assert
    should(gateway.clears).deepEqual([true]);
    should(out.messages).deepEqual(['Nothing was cleared.']);
  });

  it('should refuse to go ahead where nobody can be asked, saying how', async () => {
    // Arrange
    const { controller, gateway } = owner('y', false);
    const bare = new AgendaController(gateway, new CapturingOutput(), undefined);

    // Act + Assert
    await should(controller.clearAgents({ agents: true })).be.rejectedWith(/re-run with --yes/u);
    await should(bare.clearAgents({ agents: true })).be.rejectedWith(/re-run with --yes/u);
    should(gateway.clears).deepEqual([true, true]);
  });

  it('should say there is nothing to clear and ask nothing', async () => {
    // Arrange
    const { controller, gateway, out, asked } = owner('y');
    gateway.clearing = { cleared: 0, sessions: 0 };

    // Act
    await controller.clearAgents({ agents: true });

    // Assert
    should(out.messages).deepEqual(['nothing to clear: the agent ferrets have no open agenda items']);
    should(asked).be.empty();
    should(gateway.clears).deepEqual([true]);
  });

  it('should use the singular for one item on one ferret', async () => {
    // Arrange
    const { controller, gateway, asked } = owner('y');
    gateway.clearing = { cleared: 1, sessions: 1 };

    // Act
    await controller.clearAgents({ agents: true });

    // Assert
    should(asked).deepEqual(['Dismiss 1 open agenda item on 1 agent ferret? [y/N]']);
  });

  it('should refuse inside a ferret session without calling the daemon', async () => {
    // Arrange
    const { gateway, out } = build(SESSION);
    gateway.offered = NEW_DAEMON;
    const inside = new AgendaController(gateway, out, SESSION);

    // Act + Assert
    await should(inside.clearAgents({ agents: true, yes: true })).be.rejectedWith(/only the owner.*FY_SESSION_ID/u);
    should(gateway.clears).be.empty();
  });

  it('should refuse without --agents and on a daemon that cannot do it', async () => {
    // Arrange
    const { controller, gateway } = owner('y');
    const old = new RecordingAgendaGateway(board);
    const oldDaemon = new AgendaController(old, new CapturingOutput(), undefined);

    // Act + Assert
    await should(controller.clearAgents({})).be.rejectedWith(/clear --agents/u);
    await should(oldDaemon.clearAgents({ agents: true, yes: true })).be.rejectedWith(/older than clearing/u);
    should(gateway.clears).be.empty();
    should(old.clears).be.empty();
  });
});
