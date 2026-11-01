import { describe, it } from 'bun:test';
import {
  AGENDA_ASK_TARGET_LENGTH,
  AGENDA_PUSH_TITLE_LENGTH,
  AgendaItemSchema,
  type PendingQuestion,
  type StructuredQuestionAnswer,
} from '@ferretry/protocol';
import should from 'should';
import {
  AgendaChangeFanout,
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaReplyDelivery,
  AgendaService,
  HARNESS_PROMPT_ACTOR,
  HarnessPromptAnswerDelivery,
  HarnessPromptAgenda,
  type HarnessQuestionAnswerer,
  harnessQuestionAnswers,
  harnessQuestionRequest,
  harnessWait,
  refusedQuestionId,
  isHarnessConsolePromptRef,
} from '../../../src/lib/agenda/index.ts';

const SESSION = 'session-1';
const NOW = '2026-10-28T10:00:00.000Z';
const HUMAN = { kind: 'human' as const };

class MemoryRepository implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  reads = 0;

  async read(sessionId: string): Promise<AgendaLedger | null> {
    this.reads += 1;
    return this.ledgers.get(sessionId) ?? null;
  }

  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledgers.get(sessionId) ?? null);
    if (mutation.ok && mutation.changed) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

const serial = { run: async <T>(_key: string, work: () => Promise<T>): Promise<T> => await work() };

function board(options: { delivery?: HarnessPromptAnswerDelivery; reply?: AgendaReplyDelivery } = {}) {
  const repository = new MemoryRepository();
  const raised: string[] = [];
  const service = new AgendaService(
    repository,
    { now: () => NOW },
    { has: async sessionId => sessionId === SESSION },
    { raised: async (_sessionId, item) => void raised.push(item.id) },
    new AgendaChangeFanout([
      ...(options.delivery === undefined ? [] : [options.delivery]),
      ...(options.reply === undefined ? [] : [options.reply]),
    ]),
  );
  return { repository, service, raised };
}

type QuestionItem = PendingQuestion['questions'][number];

const REGION: QuestionItem = {
  question: 'Which region should the rollout go to first?',
  options: [{ label: 'eu', description: 'Europe, the smaller fleet' }, { label: 'us' }],
};
const CHECKS: QuestionItem = {
  question: 'Which checks?',
  options: [{ label: 'lint' }, { label: 'unit' }],
  multiSelect: true,
};

const choice: PendingQuestion = { toolUseId: 'toolu_1', questions: [REGION], askedAt: '2026-10-28T09:59:00.000Z' };

const several: PendingQuestion = {
  toolUseId: 'toolu_2',
  questions: [
    { question: 'Which region?', options: [{ label: 'eu' }, { label: 'us' }] },
    CHECKS,
    { question: 'Anything else?' },
  ],
};

/** The request a console prompt raises. */
function promptRequest() {
  const wait = harnessWait({ id: 'session-1', status: 'running', turn: 1, turnState: 'needs-input', turnStateAt: NOW });
  if (wait === undefined) throw new Error('a console prompt must raise a wait');
  return wait.request;
}

const running = (extra: Record<string, unknown> = {}) => ({ id: SESSION, status: 'running', turn: 1, ...extra });

describe('harnessWait', () => {
  it('should raise nothing for a document that is not a state, a session that ended, or one at work', () => {
    should(harnessWait(null)).be.undefined();
    should(harnessWait(['running'])).be.undefined();
    should(harnessWait(running({ status: 'completed', pendingQuestion: choice }))).be.undefined();
    should(harnessWait(running({ turnState: 'your-turn' }))).be.undefined();
    should(harnessWait(running({ pendingQuestion: { ...choice, toolUseId: 'x'.repeat(600) } }))).be.undefined();
  });

  it('should raise no question whose id is shaped like a daemon reference, and say which (docs/agenda.md § Reserved sourceRefs)', () => {
    // A ferret writes its own question file: an id it chose must never name a daemon producer's item
    for (const toolUseId of [
      'lanes:11111111-1111-4111-8111-111111111111:2',
      'gate:F1:tested:1',
      'gate-followup:F1:1',
      'warden:ask:stuck',
      'warden-orphan:F1',
      'handover:req-1',
      'budget:claude:week:x',
      'prompt:dialog-1',
      'no:colons',
    ]) {
      const state = running({
        status: 'awaiting_question',
        pendingQuestion: { ...choice, toolUseId },
        turnState: 'needs-input',
      });
      should(harnessWait(state)).be.undefined();
      should(refusedQuestionId(state)).equal(toolUseId);
    }
    should(refusedQuestionId(running({ pendingQuestion: choice }))).be.undefined();
    should(refusedQuestionId(null)).be.undefined();
  });

  it('should make one single-choice question a pick between its options, summarised in one short line', () => {
    // Arrange
    const long: PendingQuestion = {
      ...choice,
      questions: [{ ...REGION, question: `${'Should we roll out to the larger region '.repeat(4)}now?` }],
    };

    // Act
    const wait = harnessWait(running({ status: 'awaiting_question', pendingQuestion: long, turnState: 'needs-input' }));

    // Assert
    should(wait?.sourceRef).equal('toolu_1');
    should(wait?.request.source).equal('question');
    should(wait?.request.ask).deepEqual({
      kind: 'multiple-choice',
      options: [{ label: 'eu', description: 'Europe, the smaller fleet' }, { label: 'us' }],
    });
    should(wait?.request.subject.length).be.belowOrEqual(AGENDA_ASK_TARGET_LENGTH);
    should(wait?.request.subject.endsWith('…')).be.true();
    should(wait?.request.waitingSince).equal('2026-10-28T09:59:00.000Z');
  });

  it('should give every harness prompt a plain title and the kind its ask means', () => {
    // Act
    const pick = harnessWait(running({ pendingQuestion: choice }));
    const words = harnessWait(running({ pendingQuestion: several }));
    const permission = harnessWait(
      running({
        turnState: 'needs-input',
        turnStateAt: NOW,
        permissionRequest: { id: 'perm-1', question: 'Do you want to run this command?' },
      }),
    );
    const stuck = harnessWait(running({ turnState: 'needs-input', turnPrompt: 'Make auto mode your default?' }));

    // Assert
    should(pick?.request).containDeep({ title: 'Question from the ferret', kind: 'choice' });
    should(words?.request).containDeep({ title: 'Question from the ferret', kind: 'reply' });
    should(permission?.request).containDeep({ title: 'Permission for a command', kind: 'info' });
    should(stuck?.request).containDeep({ title: 'Ferret stuck on a prompt', kind: 'info' });
    for (const wait of [pick, words, permission, stuck]) {
      should(wait?.request.title?.length).be.belowOrEqual(AGENDA_PUSH_TITLE_LENGTH);
      should(wait?.request.answers).be.undefined();
    }
  });

  it('should ask several questions, or a multi-select, in words with each question kept', () => {
    // Act
    const many = harnessWait(running({ pendingQuestion: several }));
    const multi = harnessWait(running({ pendingQuestion: { toolUseId: 't', questions: [CHECKS] } }));

    // Assert
    should(many?.request.ask).deepEqual({ kind: 'open-question' });
    should(many?.request.questions?.length).equal(3);
    should(many?.request.questions?.[2]).deepEqual({ question: 'Anything else?' });
    should(many?.request.context).containEql('It asks 3 questions');
    should(many?.request.waitingSince).be.undefined();
    should(multi?.request.ask).deepEqual({ kind: 'open-question' });
  });

  it('should drop options the board cannot offer, and keep the question', () => {
    // Arrange
    const odd: PendingQuestion = {
      toolUseId: 't',
      questions: [{ question: 'Pick', options: [{ label: 'only' }] }],
    };
    const wordy: PendingQuestion = {
      toolUseId: 't',
      questions: [{ question: 'Pick', options: [{ label: 'x'.repeat(200) }, { label: 'y', description: '  ' }] }],
    };

    // Act
    const one = harnessWait(running({ pendingQuestion: odd }));
    const long = harnessWait(running({ pendingQuestion: wordy }));

    // Assert
    should(one?.request.questions).deepEqual([{ question: 'Pick' }]);
    should(one?.request.ask).deepEqual({ kind: 'open-question' });
    should(long?.request.questions).deepEqual([{ question: 'Pick' }]);
  });

  it('should hard-cut a summary with no word boundary to break at', () => {
    const wait = harnessWait(
      running({ pendingQuestion: { toolUseId: 't', questions: [{ question: 'x'.repeat(300) }] } }),
    );
    should(wait?.request.subject).equal(`${'x'.repeat(AGENDA_ASK_TARGET_LENGTH - 1)}…`);
  });

  it('should raise a console prompt for a turn that needs input without a question form', () => {
    // Act
    const permission = harnessWait(
      running({
        turnState: 'needs-input',
        turnStateAt: NOW,
        permissionRequest: { id: 'perm-1', question: 'Do you want to run this command?' },
      }),
    );
    const dialog = harnessWait(
      running({ turnState: 'needs-input', turnStateAt: NOW, harnessDialog: { id: 'dlg-1', title: 'Trust hooks?' } }),
    );
    const bare = harnessWait(running({ turnState: 'needs-input', turnPrompt: 'Make auto mode your default?' }));
    const damaged = harnessWait(running({ turnState: 'needs-input', turnStateAt: 7, permissionRequest: 'yes' }));

    // Assert
    should(permission?.sourceRef).equal('prompt:perm-1');
    should(permission?.request.subject).containEql('permission');
    should(permission?.request.context).containEql('It asks: Do you want to run this command?');
    should(permission?.request.ask).be.undefined();
    should(permission?.request.waitingSince).equal(NOW);
    should(dialog?.sourceRef).equal('prompt:dlg-1');
    should(dialog?.request.context).containEql('It asks: Trust hooks?');
    should(bare?.sourceRef).equal('prompt:current');
    should(bare?.request.context).containEql('Make auto mode your default?');
    should(damaged?.sourceRef).equal('prompt:current');
    should(damaged?.request.context).not.containEql('It asks');
    should(isHarnessConsolePromptRef('prompt:current')).be.true();
    should(isHarnessConsolePromptRef('toolu_1')).be.false();
  });

  it('should make a raise the board stores as a valid item', async () => {
    // Arrange
    const { service } = board();

    // Act
    const results = await Promise.all(
      [choice, several, promptRequest()].map(
        async (value, index) =>
          await service.raise(
            SESSION,
            'toolUseId' in value ? harnessQuestionRequest(value, index === 1) : value,
            HARNESS_PROMPT_ACTOR,
          ),
      ),
    );

    // Assert
    for (const result of results) {
      should(result.ok).be.true();
      if (result.ok) should(AgendaItemSchema.safeParse(result.item).success).be.true();
    }
  });
});

describe('harnessQuestionAnswers', () => {
  it('should type a picked option, and refuse one the form does not offer', () => {
    should(harnessQuestionAnswers(choice, { kind: 'multiple-choice', choice: 'eu' })).deepEqual({
      ok: true,
      answers: [{ kind: 'selection', labels: ['eu'] }],
    });
    should(harnessQuestionAnswers(choice, { kind: 'multiple-choice', choice: 'mars' }).ok).be.false();
    should(harnessQuestionAnswers(several, { kind: 'multiple-choice', choice: 'eu' }).ok).be.false();
    should(harnessQuestionAnswers(choice, { kind: 'permission', decision: 'approve' }).ok).be.false();
  });

  it('should refuse an answer outside the options: a form cannot be filled with it', () => {
    should(harnessQuestionAnswers(choice, { kind: 'other', answer: 'neither' })).deepEqual({
      ok: false,
      reason: 'an answer outside the options cannot fill a form',
    });
  });

  it('should read one answer in words as the option it names, the options it lists, or text', () => {
    const multi: PendingQuestion = { toolUseId: 't', questions: [CHECKS] };
    const open = (answer: string) => ({ kind: 'open-question' as const, answer });
    should(harnessQuestionAnswers(choice, open(' us '))).deepEqual({
      ok: true,
      answers: [{ kind: 'selection', labels: ['us'] }],
    });
    should(harnessQuestionAnswers(choice, open('either'))).deepEqual({
      ok: true,
      answers: [{ kind: 'other', text: 'either' }],
    });
    should(harnessQuestionAnswers(multi, open('lint, unit, lint'))).deepEqual({
      ok: true,
      answers: [{ kind: 'selection', labels: ['lint', 'unit'] }],
    });
    should(harnessQuestionAnswers(multi, open('lint, e2e'))).deepEqual({
      ok: true,
      answers: [{ kind: 'other', text: 'lint, e2e' }],
    });
  });

  it('should split the board numbered reply into one answer per question', () => {
    // Arrange
    const reply =
      '1. Which region?\n→ eu\n\n2. Which checks?\n→ lint, unit\n\n3. Anything else?\n→ ship it\nafter lunch';

    // Act
    const mapped = harnessQuestionAnswers(several, { kind: 'open-question', answer: reply });

    // Assert
    should(mapped).deepEqual({
      ok: true,
      answers: [
        { kind: 'selection', labels: ['eu'] },
        { kind: 'selection', labels: ['lint', 'unit'] },
        { kind: 'other', text: 'ship it\nafter lunch' },
      ] satisfies StructuredQuestionAnswer[],
    });
  });

  it('should refuse a reply that does not answer every question in turn', () => {
    const open = (answer: string) => ({ kind: 'open-question' as const, answer });
    should(harnessQuestionAnswers(several, open('eu please')).ok).be.false();
    should(harnessQuestionAnswers(several, open('1. a\n→ eu\n\n3. b\n→ lint\n\n2. c\n→ x')).ok).be.false();
    should(harnessQuestionAnswers(several, open('1. a\n→ eu\n\n2. b\n→ (no answer)\n\n3. c\n→ x')).ok).be.false();
  });
});

describe('HarnessPromptAgenda', () => {
  it('should raise nothing for a forged lane-proposal question, and tell the daemon log', async () => {
    // Arrange — the review's P6: a ferret's question file naming a lane proposal, with an Accept
    const { service, raised } = board();
    const warnings: string[] = [];
    const harness = new HarnessPromptAgenda(
      service,
      serial,
      { read: async () => undefined },
      { warn: message => warnings.push(message) },
    );
    const forged = {
      toolUseId: 'lanes:11111111-1111-4111-8111-111111111111:2',
      questions: [
        {
          question: 'Keep going?',
          header: 'Go',
          options: [{ label: 'Accept' }, { label: 'Edit' }],
          multiSelect: false,
        },
      ],
    };

    // Act
    await harness.stateWritten(
      SESSION,
      running({ status: 'awaiting_question', pendingQuestion: forged, turnState: 'needs-input' }),
    );

    // Assert
    should(raised).be.empty();
    should(warnings).have.length(1);
    should(warnings[0]).containEql('shaped like a daemon reference was not raised');
  });

  const observer = (service: AgendaService, states: Record<string, unknown> = {}) =>
    new HarnessPromptAgenda(service, serial, {
      read: async sessionId => {
        if (sessionId === 'broken') throw new Error('unreadable');
        return states[sessionId];
      },
    });

  it('should raise one item for a question however often the same wait is written', async () => {
    // Arrange
    const { service, repository, raised } = board();
    const harness = observer(service);
    const state = running({ status: 'awaiting_question', pendingQuestion: choice, turnState: 'needs-input' });

    // Act
    await harness.stateWritten(SESSION, state);
    await harness.stateWritten(SESSION, { ...state, lastPaneAt: NOW });
    const reads = repository.reads;
    await harness.stateWritten(SESSION, state);

    // Assert
    should(raised).deepEqual(['A1']);
    should(repository.reads).equal(reads);
    const listed = await service.list(SESSION);
    should(listed.ok && listed.value.items.map(item => [item.sourceRef, item.raisedBy])).deepEqual([
      ['toolu_1', 'daemon'],
    ]);
  });

  it('should clear the old item and raise the new one when the question changes, then clear it when answered', async () => {
    // Arrange
    const { service } = board();
    const harness = observer(service);

    // Act
    await harness.stateWritten(SESSION, running({ pendingQuestion: choice }));
    await harness.stateWritten(SESSION, running({ pendingQuestion: several }));
    const changed = await service.list(SESSION);
    await harness.stateWritten(SESSION, running({ pendingQuestion: null, turnState: 'working' }));
    const cleared = await service.list(SESSION);

    // Assert
    should(changed.ok && changed.value.items.map(item => item.sourceRef)).deepEqual(['toolu_2']);
    should(changed.ok && changed.value.resolved.map(item => [item.sourceRef, item.resolvedBy])).deepEqual([
      ['toolu_1', 'daemon'],
    ]);
    should(cleared.ok && cleared.value.count).equal(0);
  });

  it('should raise a console prompt while the turn needs input and clear it once the session ends', async () => {
    // Arrange
    const { service } = board();
    const harness = observer(service);

    // Act
    await harness.stateWritten(SESSION, running({ turnState: 'needs-input', turnStateAt: NOW }));
    const open = await service.list(SESSION);
    await harness.stateWritten(SESSION, running({ status: 'completed', turnState: 'needs-input', turnStateAt: NOW }));
    const ended = await service.list(SESSION);

    // Assert
    should(open.ok && open.value.items.map(item => item.sourceRef)).deepEqual([`prompt:${NOW}`]);
    should(ended.ok && ended.value.count).equal(0);
  });

  it('should leave a board alone when nothing waits and nothing is open', async () => {
    // Arrange
    const { service, repository } = board();
    const harness = observer(service);

    // Act
    await harness.stateWritten(SESSION, running({ turnState: 'working' }));

    // Assert
    should(repository.reads).equal(0);
  });

  it('should never raise a wait again once its item was answered or dismissed, even after a restart', async () => {
    // Arrange
    const { service, raised } = board();
    const state = running({ pendingQuestion: choice });
    await observer(service).stateWritten(SESSION, state);
    await service.dismiss(SESSION, 'A1', HUMAN);

    // Act
    const restarted = observer(service, { [SESSION]: state, other: undefined });
    await restarted.reconcile([SESSION, 'other', 'broken']);
    await restarted.stateWritten(SESSION, { ...state, lastPaneAt: NOW });

    // Assert
    should(raised).deepEqual(['A1']);
    const listed = await service.list(SESSION);
    should(listed.ok && listed.value.count).equal(0);
  });

  it('should keep the item a restart finds already open, and clear one whose wait ended while down', async () => {
    // Arrange
    const { service, raised } = board();
    await observer(service).stateWritten(SESSION, running({ pendingQuestion: choice }));

    // Act
    await observer(service, { [SESSION]: running({ pendingQuestion: choice }) }).reconcile([SESSION]);
    const kept = await service.list(SESSION);
    await observer(service, { [SESSION]: running({ status: 'stopped', attention: { open: 1 } }) }).reconcile([SESSION]);
    const cleared = await service.list(SESSION);

    // Assert
    should(raised).deepEqual(['A1']);
    should(kept.ok && kept.value.count).equal(1);
    should(cleared.ok && cleared.value.count).equal(0);
  });

  it('should read an open board from either name, preferring the agenda one', async () => {
    // Arrange
    const { service, raised } = board();
    await observer(service).stateWritten(SESSION, running({ pendingQuestion: choice }));

    // Act — a stopped ferret whose state names the board only as `agenda` still has its item cleared
    await observer(service, { [SESSION]: running({ status: 'stopped', agenda: { open: 1 } }) }).reconcile([SESSION]);
    const cleared = await service.list(SESSION);

    // Assert
    should(raised).deepEqual(['A1']);
    should(cleared.ok && cleared.value.count).equal(0);
  });

  it('should retry at the next write when the board cannot be read or changed', async () => {
    // Arrange
    const { service } = board();
    let fail: 'list' | 'raise' | 'resolve' | undefined = 'list';
    const flaky = {
      list: async (sessionId: string) =>
        fail === 'list'
          ? { ok: false as const, error: { code: 'corrupt' as const, message: 'x' } }
          : service.list(sessionId),
      raise: async (...parameters: Parameters<AgendaService['raise']>) =>
        fail === 'raise'
          ? { ok: false as const, error: { code: 'full' as const, message: 'x' } }
          : service.raise(...parameters),
      resolveSource: async (...parameters: Parameters<AgendaService['resolveSource']>) =>
        fail === 'resolve'
          ? { ok: false as const, error: { code: 'corrupt' as const, message: 'x' } }
          : service.resolveSource(...parameters),
    };
    const harness = new HarnessPromptAgenda(flaky, serial, { read: async () => undefined });
    const state = running({ pendingQuestion: choice });

    // Act
    await harness.stateWritten(SESSION, state);
    fail = 'raise';
    await harness.stateWritten(SESSION, state);
    fail = undefined;
    await harness.stateWritten(SESSION, state);
    const raised = await service.list(SESSION);
    fail = 'resolve';
    await harness.stateWritten(SESSION, running());
    fail = undefined;
    await harness.stateWritten(SESSION, running());
    const cleared = await service.list(SESSION);

    // Assert
    should(raised.ok && raised.value.count).equal(1);
    should(cleared.ok && cleared.value.count).equal(0);
  });
});

class FakeHarness implements HarnessQuestionAnswerer {
  readonly answered: Array<{ toolUseId: string; answers: readonly StructuredQuestionAnswer[]; requestId: string }> = [];
  constructor(
    public current: PendingQuestion | undefined | Error,
    private readonly outcome: 'answer' | 'reject' | 'reject-release' = 'answer',
  ) {}

  async pending(): Promise<PendingQuestion | undefined> {
    if (this.current instanceof Error) throw this.current;
    return this.current;
  }

  async answer(
    _sessionId: string,
    request: { toolUseId: string; answers: readonly StructuredQuestionAnswer[]; requestId: string },
  ): Promise<void> {
    this.answered.push(request);
    if (this.outcome === 'answer') {
      this.current = undefined;
      return;
    }
    if (this.outcome === 'reject-release') this.current = undefined;
    throw this.outcome === 'reject' ? new Error("Couldn't answer automatically.") : 'released';
  }
}

function answering(harness: FakeHarness, journalFails = false, raiseFails = false) {
  const failures: Array<{ id: string; toolUseId: string; reason: string }> = [];
  const sent: string[] = [];
  let service: AgendaService | undefined;
  const delivery = new HarnessPromptAnswerDelivery(
    harness,
    {
      answerFailed: async (_sessionId, failure) => {
        failures.push(failure);
        if (journalFails) throw new Error('disk full');
      },
    },
    {
      raise: async (...parameters) => {
        if (raiseFails) throw new Error('board unwritable');
        if (service === undefined) throw new Error('the board is not built yet');
        return await service.raise(...parameters);
      },
    },
  );
  const reply = new AgendaReplyDelivery({ add: async (_sessionId, _id, message) => void sent.push(message) }, 'fy');
  const built = board({ delivery, reply });
  service = built.service;
  return { ...built, failures, sent };
}

describe('HarnessPromptAnswerDelivery', () => {
  it('should type the owner board answer into the form once, and never tell the ferret as a message', async () => {
    // Arrange
    const harness = new FakeHarness(choice);
    const { service, failures, sent } = answering(harness);
    await service.raise(SESSION, harnessQuestionRequest(choice), HARNESS_PROMPT_ACTOR);

    // Act
    const answered = await service.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'us' }, HUMAN);

    // Assert
    should(answered.ok).be.true();
    should(harness.answered).deepEqual([
      { toolUseId: 'toolu_1', answers: [{ kind: 'selection', labels: ['us'] }], requestId: 'attention:session-1:A1' },
    ]);
    should(failures).be.empty();
    should(sent).be.empty();
  });

  it('should not drive a chat reply, a dismissal, a console prompt or an item it did not raise', async () => {
    // Arrange
    const harness = new FakeHarness(choice);
    const { service } = answering(harness);
    await service.raise(SESSION, harnessQuestionRequest(choice), HARNESS_PROMPT_ACTOR);
    await service.raise(SESSION, harnessQuestionRequest({ ...choice, toolUseId: 'toolu_9' }), HARNESS_PROMPT_ACTOR);
    await service.raise(SESSION, promptRequest(), HARNESS_PROMPT_ACTOR);
    await service.raise(
      SESSION,
      {
        source: 'agent-raised',
        sourceRef: null,
        subject: 'Pick',
        why: 'w',
        howToResolve: 'h',
        ask: { kind: 'open-question' },
      },
      { kind: 'agent', sessionId: SESSION, name: null },
    );

    // Act
    await service.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'us' }, HUMAN, null, 'conversation');
    await service.dismiss(SESSION, 'A2', HUMAN);
    await service.resolve(SESSION, 'A3', HUMAN);
    await service.answer(SESSION, 'A4', { kind: 'open-question', answer: 'eu' }, HUMAN);

    // Assert
    should(harness.answered).be.empty();
  });

  it('should journal an answer whose question is gone, and raise nothing', async () => {
    // Arrange
    const harness = new FakeHarness(new Error('state unreadable'));
    const { service, failures } = answering(harness, true);
    await service.raise(SESSION, harnessQuestionRequest(choice), HARNESS_PROMPT_ACTOR);

    // Act
    await service.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'us' }, HUMAN);

    // Assert
    should(harness.answered).be.empty();
    should(failures.map(failure => failure.toolUseId)).deepEqual(['toolu_1']);
    const listed = await service.list(SESSION);
    should(listed.ok && listed.value.count).equal(0);
  });

  it('should journal an answer the form cannot take and raise the open question again saying so', async () => {
    // Arrange
    const harness = new FakeHarness(several);
    const { service, failures, raised } = answering(harness);
    await service.raise(SESSION, harnessQuestionRequest(several), HARNESS_PROMPT_ACTOR);

    // Act
    await service.answer(SESSION, 'A1', { kind: 'open-question', answer: 'eu' }, HUMAN);

    // Assert
    should(harness.answered).be.empty();
    should(failures.map(failure => failure.reason)).deepEqual([
      'the reply does not answer each of the 3 questions in turn',
    ]);
    should(raised).deepEqual(['A1', 'A2']);
    const listed = await service.list(SESSION);
    should(listed.ok && listed.value.items.map(item => [item.sourceRef, item.subject])).deepEqual([
      ['toolu_2', 'Your answer did not reach the ferret. Answer again.'],
    ]);
  });

  it('should report a drive that failed, and raise again only while the form is still open', async () => {
    // Arrange
    const stuck = new FakeHarness(choice, 'reject');
    const released = new FakeHarness(choice, 'reject-release');
    const first = answering(stuck);
    const unwritable = answering(new FakeHarness(choice, 'reject'), false, true);
    const second = answering(released);
    for (const { service } of [first, second, unwritable])
      await service.raise(SESSION, harnessQuestionRequest(choice), HARNESS_PROMPT_ACTOR);

    // Act
    await first.service.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'eu' }, HUMAN);
    await second.service.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'eu' }, HUMAN);
    const lost = await unwritable.service.answer(SESSION, 'A1', { kind: 'multiple-choice', choice: 'eu' }, HUMAN);

    // Assert
    should(stuck.answered.length).equal(1);
    should(first.failures.map(failure => failure.reason)).deepEqual(["Couldn't answer automatically."]);
    should(first.raised).deepEqual(['A1', 'A2']);
    should(released.answered.length).equal(1);
    should(second.failures.map(failure => failure.reason)).deepEqual(['released']);
    should(second.raised).deepEqual(['A1']);
    should(lost.ok).be.true();
    should(unwritable.failures.length).equal(1);
  });
});

describe('harnessWait for a login that hit its limit', () => {
  const limited = (extra: Record<string, unknown> = {}) =>
    running({
      status: 'rate_limited',
      turnState: 'needs-input',
      turnStateAt: NOW,
      quota: { atLimit: true, resetAt: Date.parse('2026-11-01T00:00:00.000Z') },
      harnessDialog: {
        id: 'd1',
        kind: 'usage-limit',
        title: 'What do you want to do?',
        body: "You've hit your org's monthly spend limit · run /usage-credits",
      },
      ...extra,
    });

  it('should say the login hit its spend limit and when it resets, not that the ferret is stuck', () => {
    // Act
    const wait = harnessWait(limited());

    // Assert
    should(wait?.request.title).equal('Login hit its spend limit');
    should(wait?.request.subject).containEql('Nov 1, 00:00 UTC');
    should(wait?.request.subject).not.containEql('stuck');
    should(wait?.request.waitingSince).equal(NOW);
  });

  it('should tolerate a limit with no reset time', () => {
    // Act
    const wait = harnessWait(limited({ quota: { atLimit: true } }));

    // Assert
    should(wait?.request.subject).equal("The ferret's login hit its spend limit. Raise the limit or switch logins.");
  });

  it('should keep the generic wording for any other dialog', () => {
    // Act
    const wait = harnessWait(limited({ harnessDialog: { id: 'd2', kind: 'other', title: 'Pick one' } }));

    // Assert
    should(wait?.request.title).equal('Ferret stuck on a prompt');
  });
});

describe('harnessWait for a usage window limit', () => {
  it('should say usage limit, with the reset when known', () => {
    // Act
    const wait = harnessWait(
      running({
        status: 'rate_limited',
        turnState: 'needs-input',
        quota: { atLimit: true, resetAt: Date.parse('2026-11-01T00:00:00.000Z') },
        harnessDialog: {
          id: 'd3',
          kind: 'usage-limit',
          title: 'What do you want to do?',
          body: "You've hit your session limit",
        },
      }),
    );

    // Assert
    should(wait?.request.title).equal('Login hit its usage limit');
    should(wait?.request.subject).equal(
      "The ferret's login hit its usage limit and resets Nov 1, 00:00 UTC. Wait or switch logins.",
    );
  });
});
