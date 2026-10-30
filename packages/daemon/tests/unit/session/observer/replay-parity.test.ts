/**
 * REPLAY PARITY: the session observer's fold against the code it replaced, over recorded inputs.
 *
 * Stage 3a of `docs/design/session-workers.md` moved the turn watcher's decision, the monitor's
 * question projection, the Warden's liveness sample and the send tracker's evidence fold into one pure
 * fold. It was meant to change nothing. This suite holds it to that: each scenario is a recording — the
 * transcript lines a harness wrote, parsed by the daemon's own parsers, and the pane frames it drew,
 * read by the daemon's own pane parsers — replayed step by step into BOTH the fold and a verbatim copy
 * of the pre-3a code (`origin/main` at 7525cdb26), each carrying its own document forward. They must
 * record the same changes in the same order and end on the same document.
 *
 * The copies below are deliberately frozen: they are what "today's behaviour" meant when the fold was
 * extracted. Change the fold and this fails; change a copy and you are changing the definition of
 * parity, which needs its own justification.
 */
import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { SessionState } from '@ferretry/protocol';
import should from 'should';
import { backgroundTerminalCount } from '../../../../src/lib/migrate/background-terminals.ts';
import { observedRuntimeStatePatch, projectObservedRuntime } from '../../../../src/lib/session/harness/observation.ts';
import {
  foldSendEvidenceBatch,
  INITIAL_OBSERVER_STATE,
  type ObserverState,
  questionDocumentPatch,
  type SendEvidenceWatch,
  SessionObserver,
  type TurnFacts,
  type TurnStateChange,
  turnFactsOf,
} from '../../../../src/lib/session/observer/index.ts';
import {
  type AnswerOperationRecord,
  reconcileAnswerEvidence,
} from '../../../../src/lib/session/question/answer-ledger.ts';
import {
  projectStructuredQuestion,
  structuredQuestionStatePatch,
} from '../../../../src/lib/session/question/projection.ts';
import {
  isTurnStatus,
  observeTurn,
  settleHarnessDialog,
  settlePermissionRequest,
  settleTurnPrompt,
  settleTurnState,
  type TurnObservation,
  type TurnPaneEvidence,
  transcriptTurnPhase,
} from '../../../../src/lib/session/turn/policy.ts';
import { parseHarnessDialog } from '../../../../src/lib/tmux/harness-dialog.ts';
import { paneBlockingPrompt, paneShowsActiveWork, paneShowsPermissionPrompt } from '../../../../src/lib/tmux/pane.ts';
import { parsePermissionPrompt } from '../../../../src/lib/tmux/permission-prompt.ts';
import { ClaudeTranscriptParser } from '../../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../../src/lib/transcript/codex.ts';
import type {
  ObservedHumanInput,
  TranscriptBatch,
  TranscriptEvent,
  TranscriptIssueCode,
} from '../../../../src/lib/transcript/types.ts';

const NOW = '2026-10-22T08:00:00.000Z';
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// ─── The pre-3a code, verbatim in its decisions ──────────────────────────────────────────────────

/** `SessionTurnWatcher.watch` before 3a: the decision, with the record port left to the caller. */
function referenceTurn(
  state: TurnFacts,
  previous: TurnObservation | undefined,
  gather: () => { events: readonly TranscriptEvent[] | undefined; pane: TurnPaneEvidence | undefined },
): { observation: TurnObservation | undefined; change: TurnStateChange | undefined } {
  const live = isTurnStatus(state.status);
  let observation: TurnObservation | undefined;
  if (live) {
    const { events, pane } = gather();
    observation = observeTurn({
      state,
      transcript: events === undefined ? 'unknown' : transcriptTurnPhase(events),
      pane,
    });
  }
  const next = settleTurnState(state.turnState, observation, previous, live);
  const prompt = settleTurnPrompt(state.turnPrompt, next, observation);
  const request = settlePermissionRequest(state.permissionRequest, next, observation);
  const dialog = settleHarnessDialog(state.harnessDialog, next, observation);
  if (
    next === state.turnState &&
    prompt === state.turnPrompt &&
    request?.id === state.permissionRequest?.id &&
    dialog?.id === state.harnessDialog?.id
  )
    return { observation, change: undefined };
  return {
    observation,
    change: {
      from: state.turnState,
      to: next,
      ...(prompt === undefined ? {} : { prompt }),
      ...(request === undefined ? {} : { request }),
      ...(dialog === undefined ? {} : { dialog }),
    },
  };
}

/** `StorageTurnPorts.record`'s transform before 3a, applied to a document already read under the lock. */
function referenceRecord(raw: Record<string, unknown>, change: TurnStateChange, at: string): Record<string, unknown> {
  const current = raw as unknown as SessionState;
  if (current.turnState !== change.from) return raw;
  if (change.to !== undefined && !isTurnStatus(current.status)) return raw;
  const next: Record<string, unknown> = { ...raw };
  if (change.to === undefined) {
    delete next.turnState;
    delete next.turnStateAt;
  } else if (change.to !== change.from) {
    next.turnState = change.to;
    next.turnStateAt = at;
  }
  if (change.prompt === undefined) delete next.turnPrompt;
  else next.turnPrompt = change.prompt;
  if (change.request === undefined) delete next.permissionRequest;
  else next.permissionRequest = change.request;
  if (change.dialog === undefined) delete next.harnessDialog;
  else next.harnessDialog = change.dialog;
  return next;
}

/**
 * `projectSessionEvidence` before 3a: the settlements it appended, and the document after its locked
 * transform ran against `locked` (the look's own document unless a writer committed in between).
 */
function referenceQuestion(
  current: SessionState,
  events: readonly TranscriptEvent[],
  ledger: ReadonlyMap<string, AnswerOperationRecord>,
  locked: Record<string, unknown>,
): { settlements: readonly AnswerOperationRecord[]; document: Record<string, unknown> | undefined } {
  const projection = projectStructuredQuestion(events);
  const answerEvidence = reconcileAnswerEvidence(ledger, current, {
    ...(projection.kind === 'pending' ? { activeToolUseId: projection.question.toolUseId } : {}),
    ...(projection.kind === 'resolved' ? { resolvedToolUseId: projection.toolUseId } : {}),
  });
  const answerRecords = [...answerEvidence.records.values()];
  const observedRuntime = projectObservedRuntime(events);
  const question = structuredQuestionStatePatch(current, projection, answerRecords);
  const patch = { ...question, ...observedRuntimeStatePatch(current, observedRuntime) };
  if (Object.keys(patch).length === 0) return { settlements: answerEvidence.settlements, document: undefined };
  const verified = locked as unknown as SessionState;
  const currentQuestion = structuredQuestionStatePatch(verified, projection, answerRecords);
  const currentPatch = { ...currentQuestion, ...observedRuntimeStatePatch(verified, observedRuntime) };
  if (Object.keys(currentPatch).length === 0) return { settlements: answerEvidence.settlements, document: locked };
  const next = { ...locked, ...currentPatch } as Record<string, unknown>;
  if (Object.hasOwn(currentQuestion, 'pendingQuestion') && currentQuestion.pendingQuestion === undefined)
    delete next.pendingQuestion;
  if (Object.hasOwn(currentQuestion, 'needsHumanKind') && currentQuestion.needsHumanKind === undefined)
    delete next.needsHumanKind;
  if (Object.hasOwn(currentQuestion, 'needsHuman') && currentQuestion.needsHuman === undefined) delete next.needsHuman;
  return { settlements: answerEvidence.settlements, document: next };
}

/** The Warden's liveness `sample` before 3a, over what its three reads answered. */
function referenceLiveness(
  pane: string | undefined,
  transcript: string | undefined,
  observed: { kind: 'observed'; processes: readonly unknown[] } | { kind: 'unobserved' } | undefined,
) {
  const children = observed?.kind === 'observed' ? observed.processes.length > 0 : undefined;
  const background = pane !== undefined && backgroundTerminalCount(pane) > 0;
  return {
    ...(pane === undefined ? {} : { pane, paneHash: sha256(pane) }),
    ...(transcript === undefined ? {} : { transcriptHash: sha256(transcript) }),
    ...(children === undefined && !background ? {} : { subprocessAlive: children === true || background }),
  };
}

const BLIND: ReadonlySet<TranscriptIssueCode> = new Set([
  'source-missing',
  'source-read-failed',
  'oversized-record',
  'window-capped',
]);

/** `TranscriptSendEvidence.read`'s drain loop before 3a. */
function referenceSendEvidence(
  held: { inputs: readonly ObservedHumanInput[]; partial: boolean },
  batches: readonly TranscriptBatch[],
  finished: boolean,
) {
  let inputs = held.inputs;
  let blind = held.partial;
  let partial = held.partial;
  for (const batch of batches) {
    if (batch.reset) inputs = [];
    inputs = [...inputs, ...batch.observedInputs];
    if (batch.issues.some(issue => BLIND.has(issue.code))) blind = true;
    if (batch.issues.some(issue => issue.code === 'window-capped')) partial = true;
  }
  return { readable: finished && !blind, inputs, partial };
}

// ─── Recordings ─────────────────────────────────────────────────────────────────────────────────

const claude = new ClaudeTranscriptParser();
const codex = new CodexTranscriptParser();
const parse = (harness: 'claude' | 'codex', records: readonly object[]) =>
  (harness === 'claude' ? claude : codex).parse({
    text: records.map(record => `${JSON.stringify(record)}\n`).join(''),
    endOfInput: true,
    sessionId: 's',
  });

const claudeUser = (id: string, content: unknown) => ({
  type: 'user',
  sessionId: 's',
  uuid: id,
  parentUuid: null,
  timestamp: NOW,
  message: { role: 'user', content },
});
const claudeAssistant = (id: string, stop: string | null, content: unknown[], model = 'claude-opus-5-5') => ({
  type: 'assistant',
  sessionId: 's',
  uuid: id,
  parentUuid: null,
  timestamp: NOW,
  message: { id: `m-${id}`, role: 'assistant', model, stop_reason: stop, content },
});
const askUser = claudeAssistant('a-ask', 'tool_use', [
  {
    type: 'tool_use',
    id: 'toolu_ship',
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Ship it?',
          header: 'Ship',
          multiSelect: false,
          options: [
            { label: 'Yes', description: 'ship' },
            { label: 'No', description: 'hold' },
          ],
        },
      ],
    },
  },
]);
const answerShip = claudeUser('u-answer', [{ type: 'tool_result', tool_use_id: 'toolu_ship', content: 'Yes' }]);
const codexEvent = (type: string) => ({ timestamp: NOW, type: 'event_msg', payload: { type, turn_id: 'turn-1' } });
const codexContext = { timestamp: NOW, type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'high' } };

const CLAUDE_IDLE = '  ? for shortcuts · ✻ Welcome back\n╭────────────────────╮\n│ > ';
const CLAUDE_WORKING = '⏺ Reading.\n✽ Pontificating… (3s · ↓ 1.2k tokens · esc to interrupt)\n\n│ > ';
const CLAUDE_PERMISSION = [
  ' Bash command',
  '',
  '   rm -rf build',
  '   Remove the build directory',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for rm commands in this project",
  '   3. No, and tell Claude what to do differently (esc)',
].join('\n');
const CODEX_IDLE = '  100% context left\n\n› Ask Codex to do anything';
const CODEX_WORKING = '• Working (5s • Esc to interrupt)\n\n› ';

/** One pane frame read as turn evidence, by the same parsers `StorageTurnPorts.pane` reads it with. */
const paneOf = (visible: string, atPrompt: boolean): TurnPaneEvidence => {
  const request = parsePermissionPrompt(visible);
  return {
    working: paneShowsActiveWork(visible),
    atPrompt,
    permission: request !== undefined || paneShowsPermissionPrompt(visible),
    prompt: paneBlockingPrompt(visible),
    request,
    dialog: parseHarnessDialog(visible),
  };
};

/** One recorded moment: what the transcript held, what the pane showed, and any status a writer set. */
interface Moment {
  readonly harness: 'claude' | 'codex';
  readonly records: readonly object[];
  readonly pane: TurnPaneEvidence | undefined;
  readonly status?: SessionState['status'];
}

const TURN_RECORDINGS: readonly (readonly [string, readonly Moment[]])[] = [
  [
    'a Claude turn: asked, worked, ended on end_turn, then idle',
    [
      { harness: 'claude', records: [], pane: paneOf(CLAUDE_IDLE, true) },
      { harness: 'claude', records: [claudeUser('u1', 'go')], pane: paneOf(CLAUDE_WORKING, false) },
      {
        harness: 'claude',
        records: [claudeUser('u1', 'go'), claudeAssistant('a1', null, [{ type: 'text', text: 'on it' }])],
        pane: paneOf(CLAUDE_WORKING, false),
      },
      {
        harness: 'claude',
        records: [claudeUser('u1', 'go'), claudeAssistant('a2', 'end_turn', [{ type: 'text', text: 'done' }])],
        pane: paneOf(CLAUDE_IDLE, true),
      },
      {
        harness: 'claude',
        records: [claudeUser('u1', 'go'), claudeAssistant('a2', 'end_turn', [{ type: 'text', text: 'done' }])],
        pane: paneOf(CLAUDE_IDLE, true),
      },
    ],
  ],
  [
    'a Claude turn interrupted: idle prompt over a transcript still saying working, twice',
    [
      { harness: 'claude', records: [claudeUser('u1', 'go')], pane: paneOf(CLAUDE_WORKING, false) },
      { harness: 'claude', records: [claudeUser('u1', 'go')], pane: paneOf(CLAUDE_IDLE, true) },
      { harness: 'claude', records: [claudeUser('u1', 'go')], pane: paneOf(CLAUDE_IDLE, true) },
    ],
  ],
  [
    'a Codex turn: task_started to task_complete, pane unreadable for one look',
    [
      { harness: 'codex', records: [codexEvent('task_started')], pane: paneOf(CODEX_WORKING, false) },
      { harness: 'codex', records: [codexEvent('task_started'), codexContext], pane: undefined },
      {
        harness: 'codex',
        records: [codexEvent('task_started'), codexContext, codexEvent('task_complete')],
        pane: paneOf(CODEX_IDLE, true),
      },
      {
        harness: 'codex',
        records: [codexEvent('task_started'), codexContext, codexEvent('task_complete')],
        pane: paneOf(CODEX_IDLE, true),
      },
    ],
  ],
  [
    'a permission prompt raised, the same one redrawn, then approved',
    [
      { harness: 'claude', records: [claudeUser('u1', 'clean')], pane: paneOf(CLAUDE_WORKING, false) },
      { harness: 'claude', records: [claudeUser('u1', 'clean')], pane: paneOf(CLAUDE_PERMISSION, false) },
      { harness: 'claude', records: [claudeUser('u1', 'clean')], pane: paneOf(CLAUDE_PERMISSION, false) },
      { harness: 'claude', records: [claudeUser('u1', 'clean')], pane: paneOf(CLAUDE_WORKING, false) },
    ],
  ],
  [
    'a structured question pending, then the session stopped mid-turn',
    [
      { harness: 'claude', records: [claudeUser('u1', 'go'), askUser], pane: paneOf(CLAUDE_WORKING, false) },
      {
        harness: 'claude',
        records: [claudeUser('u1', 'go'), askUser],
        pane: paneOf(CLAUDE_IDLE, true),
        status: 'awaiting_question',
      },
      { harness: 'claude', records: [claudeUser('u1', 'go'), askUser], pane: undefined, status: 'stopped' },
      { harness: 'claude', records: [claudeUser('u1', 'go'), askUser], pane: undefined, status: 'stopped' },
    ],
  ],
];

describe('replay parity — the turn part', () => {
  it.each(TURN_RECORDINGS)('should record what the pre-3a watcher recorded: %s', (_name, moments) => {
    // Arrange
    const subject = new SessionObserver(sha256);
    let referenceDocument: Record<string, unknown> = { id: 's', status: 'running', turn: 1 };
    let foldDocument: Record<string, unknown> = { ...referenceDocument };
    let previous: TurnObservation | undefined;
    let observer: ObserverState = INITIAL_OBSERVER_STATE;
    const referenceChanges: (TurnStateChange | undefined)[] = [];
    const foldChanges: (TurnStateChange | undefined)[] = [];

    // Act
    for (const [index, moment] of moments.entries()) {
      const at = new Date(Date.parse(NOW) + index * 2_000).toISOString();
      if (moment.status !== undefined) {
        referenceDocument = { ...referenceDocument, status: moment.status };
        foldDocument = { ...foldDocument, status: moment.status };
      }
      const events = parse(moment.harness, moment.records).events;
      const reference = referenceTurn(referenceDocument as unknown as TurnFacts, previous, () => ({
        events,
        pane: moment.pane,
      }));
      previous = reference.observation;
      referenceChanges.push(reference.change);
      if (reference.change !== undefined) referenceDocument = referenceRecord(referenceDocument, reference.change, at);

      const facts = turnFactsOf(foldDocument as unknown as SessionState);
      const live = isTurnStatus(facts.status);
      const step = subject.step(observer, {
        kind: 'look',
        facts,
        turn: { look: live ? { transcript: events, pane: moment.pane } : undefined },
      });
      observer = step.state;
      const patch = step.patches.find(candidate => candidate.kind === 'turn');
      foldChanges.push(patch?.change);
      if (patch !== undefined) foldDocument = referenceRecord(foldDocument, patch.change, at);
    }

    // Assert
    should(foldChanges).deepEqual(referenceChanges);
    should(foldDocument).deepEqual(referenceDocument);
    should(referenceChanges.some(change => change !== undefined)).be.true();
  });
});

/** A question recording: the document, the transcript, the answer ledger, and what committed meanwhile. */
interface QuestionRecording {
  readonly state: Partial<SessionState>;
  readonly records: readonly object[];
  readonly ledger: readonly AnswerOperationRecord[];
  /** A writer that committed between the look and the locked write, when one did. */
  readonly meanwhile?: Partial<SessionState>;
}

const accepted = (toolUseId: string): AnswerOperationRecord =>
  ({
    requestId: `request-${toolUseId}`,
    toolUseId,
    fingerprint: `fingerprint-${toolUseId}`,
    acceptedAt: NOW,
    outcome: 'accepted',
  }) as AnswerOperationRecord;

const QUESTION_RECORDINGS: readonly (readonly [string, QuestionRecording])[] = [
  ['an unanswered structured question', { state: {}, records: [claudeUser('u1', 'go'), askUser], ledger: [] }],
  [
    'a question answered in the harness',
    {
      state: { status: 'awaiting_question', pendingQuestion: { toolUseId: 'toolu_ship', questions: [] } },
      records: [claudeUser('u1', 'go'), askUser, answerShip],
      ledger: [],
    },
  ],
  [
    'a question answered through the daemon, the receipt still accepted',
    {
      state: { status: 'awaiting_question', lastAnsweredQuestionToolUseId: 'toolu_ship' },
      records: [claudeUser('u1', 'go'), askUser, answerShip],
      ledger: [accepted('toolu_ship')],
    },
  ],
  [
    'an accepted answer the tail shows advanced without proof of which landed',
    { state: { status: 'awaiting_question' }, records: [askUser, answerShip], ledger: [accepted('toolu_ship')] },
  ],
  [
    'a question whose session was stopped between the look and the write',
    { state: {}, records: [askUser], ledger: [], meanwhile: { status: 'kill_failed' } },
  ],
  [
    'a Codex runtime observation and nothing else',
    { state: {}, records: [codexEvent('task_started'), codexContext], ledger: [] },
  ],
  ['a tail with nothing to project', { state: {}, records: [claudeUser('u1', 'hello')], ledger: [] }],
];

describe('replay parity — the question and runtime part', () => {
  it.each(QUESTION_RECORDINGS)('should write what the pre-3a projection wrote: %s', (_name, recording) => {
    // Arrange
    const subject = new SessionObserver(sha256);
    const harness = recording.records.some(record => 'payload' in record) ? 'codex' : 'claude';
    const events = parse(harness, recording.records).events;
    const current = { id: 's', status: 'running', turn: 1, ...recording.state } as SessionState;
    const locked = { ...current, ...recording.meanwhile } as unknown as Record<string, unknown>;
    const ledger = new Map(recording.ledger.map(record => [record.requestId, record]));

    // Act
    const reference = referenceQuestion(current, events, ledger, locked);
    const step = subject.step(INITIAL_OBSERVER_STATE, {
      kind: 'look',
      question: { state: current, events, answers: ledger },
    });
    const patch = step.patches.find(candidate => candidate.kind === 'question');
    let document: Record<string, unknown> | undefined;
    if (patch?.writes === true) {
      const decided = questionDocumentPatch(locked as unknown as SessionState, patch);
      document = decided === undefined ? locked : { ...locked, ...decided.fields };
      for (const field of decided?.removals ?? []) delete document[field];
    }

    // Assert
    should(patch?.settlements ?? []).deepEqual(reference.settlements);
    should(document === undefined ? undefined : JSON.parse(JSON.stringify(document))).deepEqual(
      reference.document === undefined ? undefined : JSON.parse(JSON.stringify(reference.document)),
    );
  });
});

describe('replay parity — the liveness sample', () => {
  it.each([
    [
      'a working screen, a transcript, children',
      CLAUDE_WORKING,
      'line 1\nline 2',
      { kind: 'observed', processes: [1] },
    ],
    [
      'a screen with background terminals and no children',
      '3 background terminals running',
      'x',
      { kind: 'observed', processes: [] },
    ],
    ['an unobserved tree', CODEX_IDLE, undefined, { kind: 'unobserved' }],
    ['nothing readable', undefined, undefined, undefined],
  ] as const)('should sample what the pre-3a sampler sampled: %s', (_name, pane, transcript, observed) => {
    // Arrange
    const subject = new SessionObserver(sha256);
    const children = observed?.kind === 'observed' ? observed.processes.length > 0 : undefined;

    // Act
    const step = subject.step(INITIAL_OBSERVER_STATE, {
      kind: 'look',
      liveness: { screen: pane, transcript, children },
    });

    // Assert
    should(step.samples).deepEqual([referenceLiveness(pane, transcript, observed)]);
  });
});

describe('replay parity — the send evidence', () => {
  const sent = parse('claude', [claudeUser('u-send', 'please rebase'), claudeUser('u-more', 'and push')]);
  const recordings: readonly (readonly [string, readonly TranscriptBatch[], boolean, boolean])[] = [
    ['a send delivered: its input appears', [{ ...sent, reset: false } as unknown as TranscriptBatch], true, false],
    ['a send queued: nothing yet, the read finished', [], true, false],
    [
      'a typed-not-sent look over a rotated file: a reset, then a truncation',
      [
        { ...sent, reset: false } as unknown as TranscriptBatch,
        { reset: true, observedInputs: [], issues: [{ code: 'source-truncated' }] } as unknown as TranscriptBatch,
      ],
      true,
      false,
    ],
    ['a read that did not finish', [{ ...sent, reset: false } as unknown as TranscriptBatch], false, true],
  ];

  it.each(recordings)('should fold what the pre-3a evidence loop folded: %s', (_name, batches, finished, partial) => {
    // Arrange
    const held = { inputs: [] as readonly ObservedHumanInput[], partial };

    // Act
    const reference = referenceSendEvidence(held, batches, finished);
    let watch: SendEvidenceWatch = { inputs: held.inputs, blind: held.partial, partial: held.partial };
    for (const batch of batches) watch = foldSendEvidenceBatch(watch, batch);

    // Assert
    should({ readable: finished && !watch.blind, inputs: watch.inputs, partial: watch.partial }).deepEqual(reference);
  });
});
