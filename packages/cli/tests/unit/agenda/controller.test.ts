import { describe, it } from 'bun:test';
import {
  type AgendaItem,
  agendaListSnapshot,
  DAEMON_FEATURES,
  MAX_AGENDA_SUBJECT_LENGTH,
  type WorkRelatedResponse,
} from '@ferretry/protocol';
import { projectionRecord, projectionSnapshot } from '../../../../protocol/tests/fixtures/agenda-projection.ts';
import should from 'should';
import { AgendaController } from '../../../src/lib/agenda/controller';
import { DEFAULT_HOW_TO_RESOLVE } from '../../../src/lib/agenda/how-to-resolve';
import type { IAgendaCardTies } from '../../../src/lib/agenda/ports';
import { RelatedCheck } from '../../../src/lib/work-search/related';
import {
  agendaHit,
  FakeWorkSearchGateway,
  LIZZETTE,
  response,
  CapturingOutput as WorkSearchOutput,
} from '../work-search/fixtures';
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
  it('should fetch the full document when show opens a resolved list header', async () => {
    // Arrange
    const { gateway, out } = build(SESSION);
    const read: string[] = [];
    const controller = new AgendaController(
      {
        snapshot: async () => ({ ...agendaListSnapshot(projectionSnapshot(0, 1)), sessionId: SESSION }),
        readItem: async (session, id) => {
          read.push(`${session}:${id}`);
          return projectionRecord();
        },
        apply: gateway.apply.bind(gateway),
        sendReplies: gateway.sendReplies.bind(gateway),
        clearAgents: gateway.clearAgents.bind(gateway),
        features: gateway.features.bind(gateway),
      },
      out,
      SESSION,
    );
    // Act
    await controller.show('A1', { tab: 'Notes' });
    // Assert
    should(read).deepEqual([`${SESSION}:A1`]);
    should(out.messages[0]).containEql('Fixture notes.');
  });
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
        { direction: 'right', does: 'approve', label: 'Approve' },
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
    await controller.add(['same', 'subject'], {
      ...BRIEF,
      title: 'Pick a cluster',
      new: 'a second cluster, decided apart',
    });

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

  it('should send --reason as the note and say the question was withdrawn when a ferret closes it unanswered', async () => {
    // Arrange
    const withdrawn = snapshot([], {
      resolved: [
        resolvedItem('A1', 'which region', {
          resolvedBy: 'agent',
          resolvedByName: 'sol',
          ask: { kind: 'permission' },
          resolutionNote: 'The owner answered in chat',
        }),
      ],
    });
    const { controller, gateway, out } = build(SESSION, withdrawn);

    // Act
    await controller.resolve('!A1', { reason: '  The owner answered in chat  ' });

    // Assert
    should(gateway.applied).deepEqual([
      { sessionId: SESSION, request: { action: 'resolve', id: 'A1', note: 'The owner answered in chat' } },
    ]);
    should(out.messages[0]).startWith('withdrew the unanswered question !A1');
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

describe('agenda controller add — related work', () => {
  const raised = (id: AgendaItem['id'], subject: string, overrides: Parameters<typeof agentItem>[2] = {}) =>
    agentItem(id, subject, { howToResolve: DEFAULT_HOW_TO_RESOLVE, ask: { kind: 'open-question' }, ...overrides });
  const own = snapshot([raised('A3', 'pick a relay')]);
  const strong = [{ strength: 'strong' as const, hit: agendaHit({ sessionId: LIZZETTE }) }];

  const withCheck = (
    matches: WorkRelatedResponse['matches'] | undefined,
    board = snapshot([]),
    extras: { interactive?: boolean; answer?: string; ties?: IAgendaCardTies } = {},
  ) => {
    const search = new FakeWorkSearchGateway();
    search.relatedAnswer = matches === undefined ? undefined : { matches };
    const searchOut = new WorkSearchOutput();
    const gateway = new RecordingAgendaGateway(board);
    const out = new CapturingOutput();
    const asked: string[] = [];
    const controller = new AgendaController(
      gateway,
      out,
      SESSION,
      undefined,
      () => Date.UTC(2026, 6, 31, 9),
      {
        interactive: () => extras.interactive === true,
        ask: message => {
          asked.push(message);
          return Promise.resolve(extras.answer ?? 'n');
        },
      },
      new RelatedCheck(search, searchOut, 'fy'),
      extras.ties,
    );
    return { controller, gateway, out, search, searchOut, asked };
  };

  const brief = { ...BRIEF, title: 'Pick a relay' };

  it("should refuse another ferret's strong duplicate when no open agenda of its own could take it", async () => {
    // Arrange
    const { controller, gateway, search } = withCheck(strong);

    // Act
    const failure = await controller.add(['choose', 'a', 'relay'], brief).catch((error: unknown) => error);

    // Assert
    should(gateway.applied).eql([]);
    should(search.relatedCalls[0]?.request).containEql({ kind: 'agenda', title: 'Pick a relay' });
    should(search.relatedCalls[0]?.as).equal(SESSION);
    should((failure as Error).message).containEql('!A3');
    should((failure as Error).message).containEql('--related A3');
    should((failure as Error).message).containEql('--related F12');
    should((failure as Error).message).containEql('--new "<why>"');
    should((failure as Error).message).containEql('fy send <callsign>');
  });

  it('should print the matches as JSON on a strong match with --json, and raise nothing', async () => {
    // Arrange
    const { controller, gateway, searchOut } = withCheck(strong);

    // Act
    await controller.add(['choose', 'a', 'relay'], { ...brief, json: true }).catch(() => undefined);

    // Assert
    should(gateway.applied).eql([]);
    should(JSON.parse(searchOut.lines[0] ?? '').related[0].hit.id).equal('A3');
  });

  it('should open it with no open agenda to join and no strong match', async () => {
    // Arrange
    const { controller, gateway } = withCheck([{ strength: 'weak', hit: agendaHit({ sessionId: LIZZETTE }) }]);

    // Act
    await controller.add(['choose', 'a', 'relay'], brief);

    // Assert
    should(gateway.applied).have.length(1);
  });

  it('should refuse a ferret with its open agendas listed, the join question and the two ways out', async () => {
    // Arrange — an agent runs non-interactively: there is nobody to ask, so it is told.
    const board = snapshot([raised('A3', 'pick a relay', { title: 'Relay choice' }), raised('A5', 'tokens')]);
    const { controller, gateway, asked } = withCheck([], board);

    // Act
    const failure = await controller.add(['choose', 'a', 'relay'], brief).catch((error: unknown) => error);

    // Assert
    should(gateway.applied).eql([]);
    should(asked).eql([]);
    const message = (failure as Error).message;
    should(message).containEql('Search, check, then open');
    should(message).match(/!A3\s+needs you\s+Relay choice/u);
    should(message).containEql('!A5');
    should(message).containEql('Should this join !A3?');
    should(message).containEql("fy agenda edit A3 --still-open 'choose a relay'");
    should(message).containEql('--new "<why none fits>"');
    should(message).containEql('Nothing was opened.');
  });

  it('should list a Resting item with the edit that brings it back whole, the owner having replied', async () => {
    // Arrange
    const replied = raised('A3', 'pick a relay', {
      premise: '- Two relays are up',
      context: '- Cost differs',
    }) as AgendaItem;
    const board = snapshot([{ ...replied, parked: { reason: 'replied', at: '2026-07-31T09:30:00.000Z' } }]);
    const { controller } = withCheck([], board);

    // Act
    const failure = await controller.add(['choose', 'a', 'relay'], brief).catch((error: unknown) => error);

    // Assert
    const message = (failure as Error).message;
    should(message).match(/!A3\s+resting/u);
    should(message).containEql(
      "fy agenda edit A3 --still-open 'pick a relay' --still-open 'choose a relay' --premise 'Two relays are up' --premise 'A ferret needs the owner.' --context 'Cost differs' --context 'The work waits on this answer.' --question-answer 'choose a relay' --summary 'choose a relay'",
    );
  });

  it('should open a new one with --new "<why>" without asking, but still search and list the candidates', async () => {
    // Arrange
    const { controller, gateway, search, out, asked } = withCheck(strong, own);

    // Act
    await controller.add(['choose', 'a', 'relay'], { ...brief, new: 'a relay for the phone, not the laptop' });

    // Assert
    should(gateway.applied).have.length(1);
    should(asked).eql([]);
    should(search.relatedCalls).have.length(1);
    should(out.diagnostics[0]).containEql('Search, check, then open');
    should(out.diagnostics[0]).match(/!A3\s+needs you\s+pick a relay/u);
    should(out.diagnostics[0]).containEql('Opening a new agenda anyway: a relay for the phone, not the laptop');
  });

  it('should keep --json on stdout as the raised snapshot with --new, the listing going to stderr', async () => {
    // Arrange
    const { controller, gateway, out } = withCheck([], own);

    // Act
    await controller.add(['choose', 'a', 'relay'], { ...brief, json: true, new: 'its own decision' });

    // Assert
    should(gateway.applied).have.length(1);
    should(out.diagnostics[0]).containEql('Opening a new agenda anyway: its own decision');
    should(() => JSON.parse(out.messages[0] ?? '')).not.throw();
    should(JSON.parse(out.messages[0] ?? '')).not.have.property('candidates');
  });

  it('should not search or list when there is nothing open to join and no strong match, even with --new', async () => {
    // Arrange
    const { controller, gateway, out } = withCheck([]);

    // Act
    await controller.add(['choose', 'a', 'relay'], { ...brief, new: 'its own decision' });

    // Assert
    should(gateway.applied).have.length(1);
    should(out.diagnostics).eql([]);
  });

  it('should list a strong duplicate of another ferret’s with --new, and open anyway', async () => {
    // Arrange
    const { controller, gateway, search } = withCheck(strong);

    // Act
    await controller.add(['choose', 'a', 'relay'], { ...brief, new: 'the other ferret is on a different relay' });

    // Assert
    should(gateway.applied).have.length(1);
    should(search.relatedCalls).have.length(1);
  });

  it('should refuse a --new with no reason, and open nothing', async () => {
    // Arrange
    const { controller, gateway } = withCheck(strong, own);

    // Act
    const failure = await controller
      .add(['choose', 'a', 'relay'], { ...brief, new: '  ' })
      .catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).containEql('--new needs the reason');
    should(gateway.applied).have.length(0);
  });

  it('should keep --new as the reason when the ask was given in words', async () => {
    // Arrange
    const { controller, gateway, out } = withCheck([], own);

    // Act
    await controller.add(['Choose', 'region'], { ...BRIEF, title: 'Deploy', new: 'its own decision' });

    // Assert
    should(gateway.applied[0]?.request).containEql({ action: 'add', subject: 'Choose region' });
    should(out.diagnostics.join('\n')).not.containEql('was read as your ask');
  });

  it('should ask a person at a terminal, and print the edit and open nothing on yes', async () => {
    // Arrange
    const { controller, gateway, out, asked } = withCheck([], own, { interactive: true, answer: 'y' });

    // Act
    await controller.add(['choose', 'a', 'relay'], brief);

    // Assert
    should(asked).eql(['Should this join !A3? [y/N]']);
    should(gateway.applied).eql([]);
    should(out.diagnostics[0]).containEql('Search, check, then open');
    should(out.messages[0]).containEql(
      "Nothing was opened. Add it to !A3:\nfy agenda edit A3 --still-open 'choose a relay'",
    );
  });

  it.each([
    ['no', 'n'],
    ['Enter', ''],
    ['an invalid answer', 'maybe'],
  ])(
    'should open nothing and print the two ways out when the person at the terminal answers %s',
    async (_name, answer) => {
      // Arrange
      const { controller, gateway, asked } = withCheck([], own, { interactive: true, answer });

      // Act
      const failure = await controller.add(['choose', 'a', 'relay'], brief).catch((error: unknown) => error);

      // Assert
      should(asked).eql(['Should this join !A3? [y/N]']);
      should(gateway.applied).eql([]);
      const message = (failure as Error).message;
      should(message).startWith('Nothing was opened. Join it to !A3:');
      should(message).containEql("fy agenda edit A3 --still-open 'choose a relay'");
      should(message).containEql('fy agenda add … --new "<why none fits>"');
    },
  );

  it('should answer a structured ask with guidance and open nothing, non-interactive or declined', async () => {
    // Arrange
    const structured = {
      ...brief,
      option: ['EU', 'US'],
      blocking: true,
      by: '2026-08-01T09:00:00Z',
    } as typeof brief;
    const quiet = withCheck([], own);
    const declined = withCheck([], own, { interactive: true, answer: 'y' });

    // Act
    const refused = await quiet.controller.add(['pick', 'a', 'region'], structured).catch((error: unknown) => error);
    await declined.controller.add(['pick', 'a', 'region'], structured);

    // Assert
    should(quiet.gateway.applied).eql([]);
    should((refused as Error).message).containEql('blocking the ferret now');
    should((refused as Error).message).not.containEql('fy agenda edit A3');
    should((refused as Error).message).containEql('--new "<why none fits; closest is !A3>"');
    should(declined.gateway.applied).eql([]);
    should(declined.out.messages[0]).containEql('Nothing was opened. This ask has');
    should(declined.out.messages[0]).containEql('--new "<why none fits; closest is !A3>"');
  });

  it('should print the candidates as JSON with --json, and open nothing', async () => {
    // Arrange
    const { controller, gateway, out } = withCheck([], own);

    // Act
    const failure = await controller.add(['choose'], { ...brief, json: true }).catch((error: unknown) => error);

    // Assert
    should(gateway.applied).eql([]);
    should(JSON.parse(out.messages[0] ?? '').candidates[0]).eql({
      id: 'A3',
      title: 'pick a relay',
      state: 'needs you',
      cards: [],
    });
    should((failure as Error).message).containEql('--new "<why none fits>"');
  });

  it('should list first the agenda carrying a card the named card depends on (dependent things share one)', async () => {
    // Arrange
    const board = snapshot([
      raised('A2', 'choose a relay soon'),
      raised('A7', 'ship the cache', { task: { id: 'F9' } } as never),
    ]);
    const ties: IAgendaCardTies = {
      ties: card => Promise.resolve(card.id === 'F12' ? { dependsOn: [{ id: 'F9' }], blocks: [] } : undefined),
    };
    const { controller, gateway } = withCheck([], board, { ties });
    gateway.offered = [DAEMON_FEATURES.agendaTask];

    // Act
    const failure = await controller
      .add(['choose', 'a', 'relay'], { ...brief, task: 'F12' })
      .catch((error: unknown) => error);

    // Assert
    const message = (failure as Error).message;
    should(gateway.applied).eql([]);
    should(message).containEql('Should this join !A7?');
    should(message).containEql('&F9  ← carries &F9, which &F12 depends on');
  });

  it('should warn when a new one opens beside an agenda carrying a tied card', async () => {
    // Arrange
    const board = snapshot([raised('A7', 'ship the cache', { task: { id: 'F14' } } as never)]);
    const ties: IAgendaCardTies = { ties: () => Promise.resolve({ dependsOn: [], blocks: [{ id: 'F14' }] }) };
    const { controller, gateway, out } = withCheck([], board, { ties });
    gateway.offered = [DAEMON_FEATURES.agendaTask];

    // Act
    await controller.add(['choose', 'a', 'relay'], { ...brief, task: 'F12', new: 'its own decision' });

    // Assert
    should(gateway.applied).have.length(1);
    should(out.diagnostics[0]).containEql('&F14  ← carries &F14, which depends on &F12');
    should(out.diagnostics[0]).containEql('Opening a new agenda anyway: its own decision');
  });

  it('should not join an ask for the Done button into an agenda that lacks it, and show --new instead of an edit', async () => {
    // Arrange — !A7 carries the card but does not offer to close it; the new ask wants the Done button.
    const board = snapshot([raised('A7', 'ship the cache', { task: { id: 'F12' } } as never)]);
    const { controller, gateway } = withCheck([], board);
    gateway.offered = [DAEMON_FEATURES.agendaTask, DAEMON_FEATURES.agendaOfferClose];

    // Act
    const failure = await controller
      .add(['choose', 'a', 'relay'], { ...brief, task: 'F12', offerClose: true })
      .catch((error: unknown) => error);

    // Assert
    const message = (failure as Error).message;
    should(gateway.applied).eql([]);
    should(message).containEql('the Done button (--offer-close)');
    should(message).containEql('--new "<why none fits; closest is !A7>"');
    should(message).not.containEql('fy agenda edit A7');
  });

  it('should join an ask for the Done button into an agenda that already offers it, and into any when it is not asked', async () => {
    // Arrange
    const offering = snapshot([raised('A7', 'ship the cache', { task: { id: 'F12' }, offerClose: true } as never)]);
    const plain = snapshot([raised('A7', 'ship the cache', { task: { id: 'F12' } } as never)]);
    const withOffer = withCheck([], offering);
    const without = withCheck([], plain);
    withOffer.gateway.offered = [DAEMON_FEATURES.agendaTask, DAEMON_FEATURES.agendaOfferClose];
    without.gateway.offered = [DAEMON_FEATURES.agendaTask];

    // Act
    const joined = await withOffer.controller
      .add(['choose', 'a', 'relay'], { ...brief, task: 'F12', offerClose: true })
      .catch((error: unknown) => error);
    const unasked = await without.controller
      .add(['choose', 'a', 'relay'], { ...brief, task: 'F12' })
      .catch((error: unknown) => error);

    // Assert
    for (const failure of [joined, unasked]) {
      should((failure as Error).message).containEql('fy agenda edit A7');
      should((failure as Error).message).not.containEql('Done button');
    }
    should(withOffer.gateway.applied).eql([]);
    should(without.gateway.applied).eql([]);
  });

  it('should not list what a ferret cannot add to: the owner’s items, notices, gates and held changes', async () => {
    // Arrange
    const board = snapshot([
      humanItem('A1', 'approve the deploy'),
      raised('A2', 'a notice', { notice: true }),
      raised('A4', 'allow the change', { confirms: { file: 'machine.yaml' } } as never),
    ]);
    const { controller, gateway } = withCheck([], board);

    // Act
    await controller.add(['choose', 'a', 'relay'], brief);

    // Assert
    should(gateway.applied).have.length(1);
  });

  it('should warn, and still open, when the ask looks like two decisions', async () => {
    // Arrange
    const { controller, gateway, out } = withCheck([]);

    // Act
    await controller.add(['Approve the relay? And rename the app?'], brief);

    // Assert
    should(gateway.applied).have.length(1);
    should(out.diagnostics[0]).containEql('This looks like two decisions: the ask asks 2 questions in one line.');
  });

  it('should print the edit command for the caller’s own item, and raise nothing, with --related A3', async () => {
    // Arrange
    const { controller, gateway, out, search } = withCheck(strong, own);

    // Act
    await controller.add(['choose', 'a', "relay, don't wait"], { ...brief, related: 'A3' });

    // Assert
    should(gateway.applied).eql([]);
    should(search.relatedCalls).eql([]);
    should(out.messages[0]).containEql(
      "fy agenda edit A3 --title 'Pick a relay' --summary 'choose a relay, don'\\''t wait'",
    );
  });

  it('should send the caller to the owner when --related A3 is another ferret’s item', async () => {
    // Arrange
    const { controller, gateway, search } = withCheck(strong, snapshot([]));
    search.answer = response([agendaHit({ sessionId: LIZZETTE })]);

    // Act
    const failure = await controller.add(['choose'], { ...brief, related: 'A3' }).catch((error: unknown) => error);

    // Assert
    should(gateway.applied).eql([]);
    should((failure as Error).message).containEql('belongs to lizzette');
    should((failure as Error).message).containEql('fy send lizzette');
  });

  it('should refuse a --related item nobody has', async () => {
    // Arrange
    const { controller, gateway } = withCheck(strong, snapshot([]));

    // Act
    const failure = await controller.add(['choose'], { ...brief, related: 'A9' }).catch((error: unknown) => error);

    // Assert
    should(gateway.applied).eql([]);
    should((failure as Error).message).match(/no agenda item !?A9/u);
  });

  it('should link the item to a card with --related F12, and skip the strong-duplicate check', async () => {
    // Arrange
    const { controller, gateway } = withCheck(strong);
    gateway.offered = [DAEMON_FEATURES.agendaTask];

    // Act
    await controller.add(['choose', 'a', 'relay'], { ...brief, related: 'F12' });

    // Assert
    should(gateway.applied).have.length(1);
    should(gateway.applied[0]?.request).containEql({ action: 'add', task: { id: 'F12' } });
  });

  it('should refuse --new together with --related', async () => {
    // Arrange
    const { controller, gateway } = withCheck(strong);

    // Act
    const failure = await controller
      .add(['x'], { ...brief, new: 'separate', related: 'A3' })
      .catch((error: unknown) => error);

    // Assert
    should(gateway.applied).eql([]);
    should((failure as Error).message).match(/not both/u);
  });

  it('should raise it with one dim line when the daemon has no search yet', async () => {
    // Arrange
    const { controller, gateway, searchOut } = withCheck(undefined);

    // Act
    await controller.add(['choose', 'a', 'relay'], brief);

    // Assert
    should(gateway.applied).have.length(1);
    should(searchOut.notices).eql(['related check skipped: this daemon has no search yet']);
  });

  it('should open a held configuration change without listing candidates: it answers one change', async () => {
    // Arrange
    const { controller, search } = withCheck([], own);

    // Act — the confirm path itself reads a file this test has no reader for, so only the skipped check is asserted.
    await controller.add(['allow'], { ...brief, confirms: 'machine.yaml' }).catch(() => undefined);

    // Assert
    should(search.relatedCalls).eql([]);
  });
});

describe('agenda link meanings toward an older daemon (agenda.link-meaning.1)', () => {
  const after = snapshot([agentItem('A2', 'pick a cluster')]);
  const links = ['Plan=&F12=The plan to keep the login alive', 'PR=https://example.invalid/pr/1'];

  it('should send the meaning to a daemon that lists agenda.link-meaning.1', async () => {
    // Arrange
    const { controller, gateway, out } = build(SESSION, after);
    gateway.offered = [DAEMON_FEATURES.agendaLinkMeaning];

    // Act
    await controller.add(['pick', 'a', 'cluster'], { ...BRIEF, title: 'Pick a cluster', link: links });
    await controller.edit('A2', { link: links });

    // Assert
    for (const call of gateway.applied) {
      should(call.request).containDeep({
        links: [
          { label: 'Plan', target: '&F12', meaning: 'The plan to keep the login alive' },
          { label: 'PR', target: 'https://example.invalid/pr/1' },
        ],
      });
    }
    should(out.diagnostics.filter(line => line.includes('link meanings'))).be.empty();
  });

  it('should send label=target to an older daemon on add and on edit, and say so', async () => {
    // Arrange
    const { controller, gateway, out } = build(SESSION, after);
    gateway.offered = [];

    // Act
    await controller.add(['pick', 'a', 'cluster'], { ...BRIEF, title: 'Pick a cluster', link: links });
    await controller.edit('A2', { link: links });

    // Assert
    for (const call of gateway.applied) {
      const sent = (call.request as { links?: unknown }).links;
      should(sent).deepEqual([
        { label: 'Plan', target: '&F12' },
        { label: 'PR', target: 'https://example.invalid/pr/1' },
      ]);
    }
    should(gateway.applied).have.length(2);
    should(
      out.diagnostics.filter(line => line.includes('could not confirm the daemon takes link meanings')),
    ).have.length(2);
  });

  it('should say nothing, and send the links untouched, when none carries a meaning', async () => {
    // Arrange
    const { controller, gateway, out } = build(SESSION, after);

    // Act
    await controller.edit('A2', { link: ['Plan=&F12'] });

    // Assert
    should(gateway.applied[0]?.request).containDeep({ links: [{ label: 'Plan', target: '&F12' }] });
    should(out.diagnostics.filter(line => line.includes('link meanings'))).be.empty();
  });

  it('should say, on add and on edit, when a labelled link keeps an = in its target', async () => {
    // Arrange
    const { controller, gateway, out } = build(SESSION, after);
    gateway.offered = [DAEMON_FEATURES.agendaLinkMeaning];
    const keeps = ['Run=https://ci.example.invalid/run?id=7=Failing'];

    // Act
    await controller.add(['pick', 'a', 'cluster'], { ...BRIEF, title: 'Pick a cluster', link: keeps });
    await controller.edit('A2', { link: keeps });

    // Assert
    should(out.diagnostics.filter(line => line.includes('as the whole target of "Run"'))).have.length(2);
    should(gateway.applied[0]?.request).containDeep({
      links: [{ label: 'Run', target: 'https://ci.example.invalid/run?id=7=Failing' }],
    });
  });
});

describe('agenda controller tabs (agenda.tabs.1)', () => {
  const tabbed = snapshot([
    agentItem('A2', 'pick a cluster', {
      whereWeAre: '## Status\nBuilding.',
      tabs: [{ id: 'risks', name: 'Risks', body: 'The export may slip.' }],
    }),
  ]);
  const withTabs = (offered: readonly string[]) => {
    const gateway = new RecordingAgendaGateway(tabbed, tabbed);
    gateway.offered = offered;
    const out = new CapturingOutput();
    const files: Record<string, string> = { 'where.md': '## Status\nShipped.', 'risks.md': 'None left.' };
    const input = { read: async (path: string) => files[path] ?? '' };
    return { gateway, out, controller: new AgendaController(gateway, out, SESSION, input) };
  };
  const BOTH = [DAEMON_FEATURES.agendaChannel, DAEMON_FEATURES.agendaTabs];

  it('should raise an item with its main tab and tabs of its own', async () => {
    // Arrange
    const { controller, gateway } = withTabs(BOTH);

    // Act
    await controller.add(['Pick a cluster'], {
      ...BRIEF,
      title: 'Pick a cluster',
      new: 'a cluster for the tabs test',
      whereFile: 'where.md',
      tabFile: ['Risks=risks.md'],
    });

    // Assert
    should(gateway.applied[0]?.request).containDeep({
      whereWeAre: '## Status\nShipped.',
      tabs: [{ id: 'risks', name: 'Risks', body: 'None left.' }],
    });
  });

  it('should send an edit’s main tab and tab operations', async () => {
    // Arrange
    const { controller, gateway } = withTabs(BOTH);

    // Act
    await controller.edit('A2', { whereFile: 'where.md', tabFile: ['Risks=risks.md'], removeTab: ['Old'] });

    // Assert
    should(gateway.applied[0]?.request).deepEqual({
      action: 'edit',
      id: 'A2',
      whereWeAre: '## Status\nShipped.',
      tabEdits: [
        { tab: 'Risks', body: 'None left.' },
        { tab: 'Old', remove: true },
      ],
    });
  });

  it('should refuse tabs of its own toward a daemon without agenda.tabs.1, and say how to fix it', async () => {
    // Arrange
    const { controller, gateway } = withTabs([DAEMON_FEATURES.agendaChannel]);

    // Act + Assert
    await should(controller.add(['x'], { ...BRIEF, title: 'x', tabFile: ['Risks=risks.md'] })).be.rejectedWith(
      /older than --tab-file; update the daemon first/u,
    );
    await should(controller.edit('A2', { moveTab: ['Risks=1'] })).be.rejectedWith(
      /older than --tab-file, --rename-tab/u,
    );
    // The main tab alone needs only the channel: it is the old whereWeAre, written whole.
    await controller.edit('A2', { whereFile: 'where.md' });
    should(gateway.applied).have.length(1);
  });

  it('should print one tab exactly as written with show --tab', async () => {
    // Arrange
    const { controller, out } = withTabs(BOTH);

    // Act
    await controller.show('!A2', { tab: 'main' });
    await controller.show('A2', { tab: 'Risks' });

    // Assert
    should(out.messages).deepEqual(['## Status\nBuilding.', 'The export may slip.']);
  });

  it('should list the tabs in the item’s full print, and how to read one whole', async () => {
    // Arrange
    const { controller, out } = withTabs(BOTH);

    // Act
    await controller.show('A2', {});

    // Assert
    should(out.messages[0]).containEql('tab Risks: The export may slip.');
    should(out.messages[0]).containEql('tabs: Where we are now · Risks (one in full: agenda show !A2 --tab <name>)');
  });

  it('should refuse a tab file where nothing can read one', async () => {
    const { controller, gateway } = build(SESSION);
    gateway.offered = BOTH;
    await should(controller.edit('A1', { whereFile: 'where.md' })).be.rejectedWith(/where.md cannot be read here/u);
  });
});
