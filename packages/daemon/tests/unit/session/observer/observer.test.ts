import { describe, it } from 'bun:test';
import type { SessionState } from '@ferretry/protocol';
import should from 'should';
import {
  foldSendEvidenceBatch,
  INITIAL_OBSERVER_STATE,
  livenessSampleOf,
  type ObserverState,
  type QuestionPatch,
  questionDocumentPatch,
  questionReceipts,
  SessionObserver,
  stepQuestion,
  type TurnFacts,
  turnFactsOf,
  turnLeftToSettle,
} from '../../../../src/lib/session/observer/index.ts';
import type { AnswerOperationRecord } from '../../../../src/lib/session/question/answer-ledger.ts';
import type { TurnPaneEvidence } from '../../../../src/lib/session/turn/policy.ts';
import type { TranscriptBatch, TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

/**
 * The session observer's fold over scripted looks: what each part answers, the order its patches come
 * in, and that it holds nothing between steps but the state it hands back.
 */

const NOW = '2026-10-22T08:00:00.000Z';
const digest = (text: string): string => `digest(${text})`;
const IDLE: TurnPaneEvidence = { working: false, atPrompt: true, permission: false };
const BUSY: TurnPaneEvidence = { working: true, atPrompt: false, permission: false };
const running: TurnFacts = { status: 'running', turn: 1 };
// A person's message after the last boundary: the transcript says the turn is still running.
const prompted = { kind: 'message', harness: 'claude', role: 'user', text: 'go' } as unknown as TranscriptEvent;
const question: TranscriptEvent = {
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  timestamp: NOW,
  call: {
    id: 'tool-1',
    name: 'AskUserQuestion',
    input: {},
    questions: [{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }], multiple: false }],
  },
};
const answered: TranscriptEvent = {
  kind: 'tool-result',
  harness: 'claude',
  role: 'tool',
  result: { callId: 'tool-1', content: 'Yes', isError: false },
};
const usage = (model: string): TranscriptEvent =>
  ({ kind: 'usage', harness: 'claude', role: 'assistant', timestamp: NOW, usage: { model } }) as TranscriptEvent;
const state = (fields: Partial<SessionState> = {}): SessionState =>
  ({ id: 'session-a', status: 'running', turn: 1, ...fields }) as SessionState;
const accepted: AnswerOperationRecord = {
  requestId: 'request-1',
  toolUseId: 'tool-1',
  fingerprint: 'fingerprint-1',
  acceptedAt: NOW,
  outcome: 'accepted',
} as AnswerOperationRecord;

describe('SessionObserver.step', () => {
  it('should remember the facts it is told, and change nothing else', () => {
    // Arrange
    const subject = new SessionObserver(digest);
    const input = { kind: 'facts' as const, facts: { status: 'thinking' as const, turn: 3 } };

    // Act
    const actual = subject.step({ turn: { state: 'working', confirmed: true } }, input);

    // Assert
    should(actual.state).deepEqual({
      turn: { state: 'working', confirmed: true },
      facts: { status: 'thinking', turn: 3 },
    });
    should(actual.patches).deepEqual([]);
    should(actual.samples).deepEqual([]);
    should(Object.isFrozen(actual.state)).be.true();
    should(Object.isFrozen(actual.patches)).be.true();
  });

  it('should record a turn start at once and end it only on the second idle look', () => {
    // Arrange
    const subject = new SessionObserver(digest);
    const look = (pane: TurnPaneEvidence, facts: TurnFacts) => ({
      kind: 'look' as const,
      facts,
      turn: { look: { transcript: [prompted], pane } },
    });

    // Act
    const started = subject.step(INITIAL_OBSERVER_STATE, look(BUSY, running));
    const working = { ...running, turnState: 'working' as const };
    const firstIdle = subject.step(started.state, look({ ...IDLE }, working));
    const secondIdle = subject.step(firstIdle.state, look({ ...IDLE }, working));

    // Assert
    should(started.patches).deepEqual([{ kind: 'turn', change: { from: undefined, to: 'working' } }]);
    should(firstIdle.patches).deepEqual([]);
    should(secondIdle.patches).deepEqual([{ kind: 'turn', change: { from: 'working', to: 'your-turn' } }]);
  });

  it('should decide the turn from the facts it holds when the look carries none, and not without any', () => {
    // Arrange
    const subject = new SessionObserver(digest);
    const told = subject.step(INITIAL_OBSERVER_STATE, { kind: 'facts', facts: running });

    // Act
    const decided = subject.step(told.state, { kind: 'look', turn: { look: { transcript: undefined, pane: BUSY } } });
    const blind = subject.step(INITIAL_OBSERVER_STATE, {
      kind: 'look',
      turn: { look: { transcript: [], pane: BUSY } },
    });

    // Assert
    should(decided.patches).deepEqual([{ kind: 'turn', change: { from: undefined, to: 'working' } }]);
    should(blind.patches).deepEqual([]);
    should(blind.state).deepEqual({});
  });

  it('should put the question patch before the turn patch of the same look (#689)', () => {
    // Arrange
    const subject = new SessionObserver(digest);
    const input = {
      kind: 'look' as const,
      facts: running,
      question: { state: state(), events: [question], answers: new Map() },
      turn: { look: { transcript: [question], pane: BUSY } },
    };

    // Act
    const actual = subject.step(INITIAL_OBSERVER_STATE, input);

    // Assert
    should(actual.patches.map(patch => patch.kind)).deepEqual(['question', 'turn']);
  });

  it('should keep the previous turn observation through a look that has no turn part', () => {
    // Arrange
    const subject = new SessionObserver(digest);
    const before: ObserverState = { facts: running, turn: { state: 'working', confirmed: true } };

    // Act
    const actual = subject.step(before, { kind: 'look', liveness: { screen: 'hello' } });

    // Assert
    should(actual.state).deepEqual(before);
    should(actual.samples).deepEqual([{ pane: 'hello', paneHash: 'digest(hello)' }]);
  });
});

describe('stepQuestion', () => {
  it('should project an open question as a write and nothing to settle', () => {
    // Arrange
    const input = { state: state(), events: [question], answers: new Map<string, AnswerOperationRecord>() };

    // Act
    const actual = stepQuestion(input);

    // Assert
    should(actual?.writes).be.true();
    should(actual?.settlements).deepEqual([]);
    should(actual?.projection.kind).equal('pending');
  });

  it('should answer nothing when the document already says everything the tail does', () => {
    // Arrange
    const input = { state: state(), events: [] as readonly TranscriptEvent[], answers: new Map() };

    // Act + Assert
    should(stepQuestion(input)).be.undefined();
  });

  it('should settle an accepted receipt the tail shows advanced, even when no field changes', () => {
    // Arrange — the form was released by a tool result while the receipt still says only "accepted".
    const input = {
      state: state({ lastAnsweredQuestionToolUseId: 'tool-1' }),
      events: [question, answered],
      answers: new Map([[accepted.requestId, accepted]]),
    };

    // Act
    const actual = stepQuestion(input);

    // Assert
    should(actual?.settlements.map(record => record.outcome)).deepEqual(['confirmed']);
    should(actual?.records.map(record => record.outcome)).deepEqual(['confirmed']);
  });

  it('should carry the observed runtime beside the question', () => {
    // Arrange
    const input = { state: state(), events: [usage('claude-opus-5-5')], answers: new Map() };

    // Act
    const actual = stepQuestion(input);

    // Assert
    should(actual?.runtime).deepEqual({ model: 'claude-opus-5-5', at: NOW });
    should(actual?.writes).be.true();
  });

  it('should carry the context size the transcript last stated beside the model', () => {
    // Arrange
    const sized = {
      kind: 'usage',
      harness: 'claude',
      role: 'assistant',
      timestamp: NOW,
      usage: { model: 'claude-opus-5-5', contextTokens: 118_000 },
    } as TranscriptEvent;

    // Act
    const actual = stepQuestion({ state: state(), events: [sized], answers: new Map() });

    // Assert
    should(actual?.runtime).deepEqual({
      model: 'claude-opus-5-5',
      at: NOW,
      context: { tokens: 118_000, at: NOW },
    });
  });
});

describe('questionReceipts', () => {
  // A look that found the answered form stamped while its copy of the ledger still said `accepted`.
  const looked = (): QuestionPatch => {
    const patch = stepQuestion({
      state: state({ lastAnsweredQuestionToolUseId: 'tool-1' }),
      events: [question, answered],
      answers: new Map([[accepted.requestId, accepted]]),
    });
    if (patch === undefined) throw new Error('the look implied nothing');
    return patch;
  };

  it('should keep a settlement whose receipt is still the accepted row it settles, and lay it over the ledger', () => {
    // Arrange
    const other: AnswerOperationRecord = { ...accepted, requestId: 'request-2', toolUseId: 'tool-2' };
    const input = new Map([
      [accepted.requestId, accepted],
      [other.requestId, other],
    ]);

    // Act
    const actual = questionReceipts(looked(), input);

    // Assert
    should(actual.settlements.map(record => [record.requestId, record.outcome])).deepEqual([
      ['request-1', 'confirmed'],
    ]);
    should(actual.records.map(record => [record.requestId, record.outcome])).deepEqual([
      ['request-1', 'confirmed'],
      ['request-2', 'accepted'],
    ]);
  });

  it.each([
    ['settled since by the drive itself', { outcome: 'confirmed' }],
    ['quarantined since', { outcome: 'quarantined' }],
    ['re-admitted since under a later acceptance', { acceptedAt: '2026-10-22T08:00:01.000Z' }],
    ['re-used since for another answer', { fingerprint: 'fingerprint-2' }],
    ['bound since to another form', { toolUseId: 'tool-2' }],
  ] as const)('should drop a settlement whose receipt was %s, and decide from that receipt', (_case, change) => {
    // Arrange
    const current: AnswerOperationRecord = { ...accepted, ...change };
    const input = new Map([[accepted.requestId, current]]);

    // Act
    const actual = questionReceipts(looked(), input);

    // Assert
    should(actual.settlements).deepEqual([]);
    should(actual.records).deepEqual([current]);
  });

  it('should drop a settlement for a request the ledger holds no receipt for', () => {
    // Act
    const actual = questionReceipts(looked(), new Map());

    // Assert
    should(actual).deepEqual({ settlements: [], records: [] });
  });
});

describe('questionDocumentPatch', () => {
  it('should re-decide against the locked document and name only the question fields it removes', () => {
    // Arrange — the question was answered: the projection clears the picker.
    const patch = stepQuestion({
      state: state({ status: 'awaiting_question', pendingQuestion: { toolUseId: 'tool-1', questions: [] } }),
      events: [question, answered],
      answers: new Map(),
    });
    const locked = state({
      status: 'awaiting_question',
      pendingQuestion: { toolUseId: 'tool-1', questions: [] },
      needsHumanKind: 'structured-question-unrecognized',
    });

    // Act
    const actual = patch === undefined ? undefined : questionDocumentPatch(locked, patch);

    // Assert
    should(actual?.removals).deepEqual(['pendingQuestion', 'needsHumanKind']);
    should(Object.keys(actual?.fields ?? {})).deepEqual(['pendingQuestion', 'needsHumanKind']);
  });

  it('should answer nothing when the locked document already holds the patch', () => {
    // Arrange
    const patch = stepQuestion({ state: state(), events: [usage('m')], answers: new Map() });
    const locked = state({ observedModel: 'm', observedModelAt: NOW });

    // Act + Assert
    should(patch === undefined ? 'missing' : questionDocumentPatch(locked, patch)).be.undefined();
  });
});

describe('livenessSampleOf', () => {
  it.each([
    [{}, {}],
    [{ transcript: 'line' }, { transcriptHash: 'digest(line)' }],
    [{ children: false }, { subprocessAlive: false }],
    [{ children: true }, { subprocessAlive: true }],
    [
      { screen: '2 background terminals running', children: false },
      {
        pane: '2 background terminals running',
        paneHash: 'digest(2 background terminals running)',
        subprocessAlive: true,
      },
    ],
    [{ screen: 'idle' }, { pane: 'idle', paneHash: 'digest(idle)' }],
  ])('should sample %p as %p', (input, expected) => {
    // Act
    const actual = livenessSampleOf(input, digest);

    // Assert
    should(actual).deepEqual(expected);
  });
});

describe('foldSendEvidenceBatch', () => {
  const batch = (fields: Partial<TranscriptBatch>): TranscriptBatch =>
    ({ reset: false, observedInputs: [], issues: [], ...fields }) as TranscriptBatch;
  const input = (text: string) => ({ text }) as never;

  it('should append inputs, start over on a reset, and go blind on a blinding issue', () => {
    // Arrange
    const start = { inputs: [input('a')], blind: false, partial: false };

    // Act
    const appended = foldSendEvidenceBatch(start, batch({ observedInputs: [input('b')] }));
    const reset = foldSendEvidenceBatch(appended, batch({ reset: true, observedInputs: [input('c')] }));
    const capped = foldSendEvidenceBatch(reset, batch({ issues: [{ code: 'window-capped' } as never] }));
    const unrelated = foldSendEvidenceBatch(start, batch({ issues: [{ code: 'invalid-record' } as never] }));
    // A step that stopped at its read limit is paging: the next step reads on, so nothing was missed.
    const paged = foldSendEvidenceBatch(start, batch({ issues: [{ code: 'source-truncated' } as never] }));

    // Assert
    should(appended).deepEqual({ inputs: [input('a'), input('b')], blind: false, partial: false });
    should(reset.inputs).deepEqual([input('c')]);
    should(capped).deepEqual({ inputs: [input('c')], blind: true, partial: true });
    should(unrelated).deepEqual(start);
    should(paged).deepEqual(start);
  });
});

describe('turn facts', () => {
  it('should keep only the fields a turn decision reads, a null question included', () => {
    // Arrange
    const input = state({
      pendingQuestion: null,
      turnState: 'needs-input',
      turnPrompt: 'Trust this folder?',
      permissionRequest: { id: 'p' } as never,
      harnessDialog: { id: 'd' } as never,
      observedModel: 'not a turn fact',
    });

    // Act
    const actual = turnFactsOf(input);

    // Assert
    should(actual).deepEqual({
      status: 'running',
      turn: 1,
      pendingQuestion: null,
      turnState: 'needs-input',
      turnPrompt: 'Trust this folder?',
      permissionRequest: { id: 'p' },
      harnessDialog: { id: 'd' },
    });
    should(turnFactsOf(state())).deepEqual({ status: 'running', turn: 1 });
  });

  it.each([
    [{ status: 'running', turn: 1 }, true],
    [{ status: 'stopped', turn: 1 }, false],
    [{ status: 'stopped', turn: 1, turnState: 'working' }, true],
    [{ status: 'completed', turn: 1, turnPrompt: 'p' }, true],
    [{ status: 'failed', turn: 1, permissionRequest: {} }, true],
    [{ status: 'stalled', turn: 1, harnessDialog: {} }, true],
  ] as const)('should say whether %p leaves a turn to settle (%p)', (input, expected) => {
    // Act + Assert
    should(turnLeftToSettle(input as unknown as TurnFacts)).equal(expected);
  });
});
