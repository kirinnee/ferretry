import { describe, it } from 'bun:test';
import type { HarnessDialog, PermissionRequest } from '@ferretry/protocol';
import should from 'should';
import {
  isTurnStatus,
  observeTurn,
  settleHarnessDialog,
  settlePermissionRequest,
  settleTurnPrompt,
  settleTurnState,
  type TurnEvidence,
  type TurnPaneEvidence,
  transcriptTurnPhase,
  turnStatePatch,
} from '../../../../src/lib/session/turn/policy.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

/**
 * Whose turn it is, from evidence. The cases that matter most are the ones that must NOT end a turn:
 * a single idle frame against a transcript still mid-turn, and a status word standing in for proof.
 */

const turn = (state: 'started' | 'completed' | 'aborted', harness: 'claude' | 'codex' = 'codex'): TranscriptEvent => ({
  harness,
  role: 'system',
  kind: 'turn',
  state,
});
const said = (role: 'user' | 'assistant'): TranscriptEvent => ({ harness: 'claude', role, kind: 'message', text: 'x' });
const usage: TranscriptEvent = { harness: 'claude', role: 'assistant', kind: 'usage', usage: { model: 'm' } };
const note: TranscriptEvent = { harness: 'codex', role: 'developer', kind: 'message', text: 'instructions' };

const IDLE: TurnPaneEvidence = { working: false, atPrompt: true, permission: false };
const BUSY: TurnPaneEvidence = { working: true, atPrompt: false, permission: false };
const ASKING: TurnPaneEvidence = { working: false, atPrompt: false, permission: true };
const BLANK: TurnPaneEvidence = { working: false, atPrompt: false, permission: false };

const evidence = (overrides: Partial<TurnEvidence> & { status?: TurnEvidence['state']['status'] }): TurnEvidence => ({
  state: { status: overrides.status ?? 'running', turn: 2, ...(overrides.state ?? {}) },
  transcript: overrides.transcript ?? 'unknown',
  pane: overrides.pane,
});

describe('transcriptTurnPhase', () => {
  it('should read the newest turn boundary', () => {
    should(transcriptTurnPhase([turn('started')])).equal('working');
    should(transcriptTurnPhase([turn('started'), turn('completed')])).equal('ended');
    should(transcriptTurnPhase([turn('started'), turn('aborted')])).equal('ended');
  });

  it('should call a Claude turn ended at its end_turn record, and working once anyone speaks after it', () => {
    should(transcriptTurnPhase([said('user'), said('assistant'), turn('completed', 'claude'), usage])).equal('ended');
    should(transcriptTurnPhase([said('assistant'), turn('completed', 'claude'), said('user')])).equal('working');
  });

  it('should ignore bookkeeping and system notes after a boundary', () => {
    const settings: TranscriptEvent = { harness: 'codex', role: 'system', kind: 'settings', settings: {} };
    const attachment: TranscriptEvent = {
      harness: 'claude',
      role: 'user',
      kind: 'attachment',
      attachment: { kind: 'remote-control', url: 'https://x.test' },
    };
    const error: TranscriptEvent = {
      harness: 'codex',
      role: 'assistant',
      kind: 'error',
      error: { message: 'x', recoverable: true },
    };
    should(transcriptTurnPhase([turn('completed'), usage, settings, attachment, error, note])).equal('ended');
  });

  it('should know nothing from an empty or bookkeeping-only tail', () => {
    should(transcriptTurnPhase([])).equal('unknown');
    should(transcriptTurnPhase([usage, note])).equal('unknown');
  });
});

describe('observeTurn', () => {
  it('should describe only a live session', () => {
    for (const status of ['created', 'starting', 'waiting', 'completed', 'failed', 'stopped', 'stalled'] as const)
      should(observeTurn(evidence({ status, pane: IDLE }))).be.undefined();
    should(isTurnStatus('running')).be.true();
    should(isTurnStatus('stopped')).be.false();
  });

  it('should call a question or a permission prompt needs-input, on sight', () => {
    should(observeTurn(evidence({ status: 'awaiting_question' }))).deepEqual({ state: 'needs-input', confirmed: true });
    should(
      observeTurn(
        evidence({
          state: { status: 'running', turn: 2, pendingQuestion: { toolUseId: 't', questions: [{ question: 'q' }] } },
        }),
      ),
    ).deepEqual({ state: 'needs-input', confirmed: true });
    should(observeTurn(evidence({ pane: ASKING, transcript: 'working' }))).deepEqual({
      state: 'needs-input',
      confirmed: true,
    });
  });

  it('should believe a pane showing work over a transcript that says the turn ended', () => {
    should(observeTurn(evidence({ pane: BUSY, transcript: 'ended' }))).deepEqual({ state: 'working', confirmed: true });
  });

  it('should let the transcript end a turn a spinner-shaped line alone still calls working', () => {
    // Arrange — a spinner shape with no status line beside it: what an idle feedback-draft panel drew.
    const spinnerOnly: TurnPaneEvidence = { ...BUSY, spinnerOnly: true };

    // Act
    const actual = {
      ended: observeTurn(evidence({ pane: spinnerOnly, transcript: 'ended' })),
      midTurn: observeTurn(evidence({ pane: spinnerOnly, transcript: 'working' })),
      noRecord: observeTurn(evidence({ pane: spinnerOnly, transcript: 'unknown' })),
    };

    // Assert — weak both ways: the end still needs two looks, and only a proved end overrules the shape.
    should(actual).deepEqual({
      ended: { state: 'your-turn', confirmed: false },
      midTurn: { state: 'working', confirmed: true },
      noRecord: { state: 'working', confirmed: true },
    });
  });

  it('should confirm your-turn at once when the pane and transcript agree, and not when they disagree', () => {
    should(observeTurn(evidence({ pane: IDLE, transcript: 'ended' }))).deepEqual({
      state: 'your-turn',
      confirmed: true,
    });
    should(observeTurn(evidence({ pane: IDLE }))).deepEqual({ state: 'your-turn', confirmed: true });
    // An interrupted Claude turn writes no end: the pane is the only witness, so it needs two frames.
    should(observeTurn(evidence({ pane: IDLE, transcript: 'working' }))).deepEqual({
      state: 'your-turn',
      confirmed: false,
    });
  });

  it('should fall back to the transcript when the pane shows neither', () => {
    should(observeTurn(evidence({ pane: BLANK, transcript: 'working' }))).deepEqual({
      state: 'working',
      confirmed: true,
    });
    should(observeTurn(evidence({ transcript: 'ended' }))).deepEqual({ state: 'your-turn', confirmed: false });
  });

  it('should take the status word only when nothing else speaks', () => {
    should(observeTurn(evidence({ status: 'awaiting_user' }))).deepEqual({ state: 'your-turn', confirmed: true });
    should(observeTurn(evidence({ status: 'interrupted' }))).deepEqual({ state: 'your-turn', confirmed: true });
    should(observeTurn(evidence({ state: { status: 'running', turn: 0 } }))).deepEqual({
      state: 'your-turn',
      confirmed: true,
    });
    should(observeTurn(evidence({}))).be.undefined();
  });
});

describe('settleTurnState', () => {
  const working = { state: 'working', confirmed: true } as const;
  const idleWeak = { state: 'your-turn', confirmed: false } as const;

  it('should clear the record of a session that is no longer live', () => {
    should(settleTurnState('working', working, undefined, false)).be.undefined();
  });

  it('should keep the record when there is no evidence', () => {
    should(settleTurnState('working', undefined, working, true)).equal('working');
  });

  it('should record a confirmed observation at once', () => {
    should(settleTurnState('your-turn', working, undefined, true)).equal('working');
  });

  it('should end a turn on weak evidence only when it is seen twice', () => {
    should(settleTurnState('working', idleWeak, working, true)).equal('working');
    should(settleTurnState('working', idleWeak, idleWeak, true)).equal('your-turn');
    should(settleTurnState('working', idleWeak, undefined, true)).equal('working');
  });
});

describe('a harness dialog on the pane', () => {
  const NUDGE = 'Make auto mode your default permission mode?';
  const PARKED: TurnPaneEvidence = { working: false, atPrompt: true, permission: false, prompt: NUDGE };

  it('should call a session parked on a dialog needs-input, and say which, even when its cursor row reads as a prompt', () => {
    should(observeTurn(evidence({ pane: PARKED }))).deepEqual({ state: 'needs-input', confirmed: true, prompt: NUDGE });
    should(observeTurn(evidence({ pane: PARKED, transcript: 'working' }))).deepEqual({
      state: 'needs-input',
      confirmed: true,
      prompt: NUDGE,
    });
  });

  it('should record the dialog only beside needs-input, and keep it while nothing decides the turn', () => {
    const seen = observeTurn(evidence({ pane: PARKED }));
    should(settleTurnPrompt(undefined, 'needs-input', seen)).equal(NUDGE);
    // A permission prompt names no dialog: the conversation itself shows it.
    should(settleTurnPrompt(NUDGE, 'needs-input', observeTurn(evidence({ pane: ASKING })))).be.undefined();
    // Nothing to look at, or a weak your-turn not yet confirmed: what was recorded stands.
    should(settleTurnPrompt(NUDGE, 'needs-input', undefined)).equal(NUDGE);
    should(settleTurnPrompt(NUDGE, 'needs-input', { state: 'your-turn', confirmed: false })).equal(NUDGE);
    // Answered: the turn moved on, and the dialog goes with it.
    should(settleTurnPrompt(NUDGE, 'your-turn', observeTurn(evidence({ pane: IDLE })))).be.undefined();
    should(settleTurnPrompt(NUDGE, undefined, undefined)).be.undefined();
  });
});

describe('turnStatePatch', () => {
  it('should write nothing when the value is already recorded, so the instant only moves on a change', () => {
    should(turnStatePatch({ turnState: 'working', turnStateAt: 'a' }, 'working', 'b')).be.undefined();
    should(turnStatePatch({ turnState: 'working', turnStateAt: 'a' }, 'your-turn', 'b')).deepEqual({
      turnState: 'your-turn',
      turnStateAt: 'b',
    });
    should(turnStatePatch({ turnState: 'working' }, undefined, 'b')).deepEqual({
      turnState: undefined,
      turnStateAt: undefined,
    });
  });
});

describe('a tool-permission prompt read as data', () => {
  const REQUEST: PermissionRequest = {
    id: '0123456789abcdef',
    harness: 'claude',
    tool: 'Read',
    action: 'read',
    what: '/etc/hostname',
    question: 'Do you want to proceed?',
    options: [
      { number: 1, label: 'Yes', kind: 'allow' },
      { number: 2, label: 'No', kind: 'deny' },
    ],
    selected: 1,
  };
  const ON_SCREEN: TurnPaneEvidence = { working: false, atPrompt: false, permission: true, request: REQUEST };

  it('should call it needs-input on sight, and carry the request with the observation', () => {
    should(observeTurn(evidence({ pane: ON_SCREEN }))).deepEqual({
      state: 'needs-input',
      confirmed: true,
      request: REQUEST,
    });
  });

  it('should record the request only beside needs-input, and keep it while nothing decides the turn', () => {
    const seen = observeTurn(evidence({ pane: ON_SCREEN }));
    should(settlePermissionRequest(undefined, 'needs-input', seen)).equal(REQUEST);
    // Nothing to look at, or a weak your-turn not yet confirmed: what was recorded stands.
    should(settlePermissionRequest(REQUEST, 'needs-input', undefined)).equal(REQUEST);
    should(settlePermissionRequest(REQUEST, 'needs-input', { state: 'your-turn', confirmed: false })).equal(REQUEST);
    // A dialog that is not a tool permission replaces it.
    should(settlePermissionRequest(REQUEST, 'needs-input', { state: 'needs-input', confirmed: true })).be.undefined();
    // Answered: the turn moved on, and the request goes with it.
    should(settlePermissionRequest(REQUEST, 'working', observeTurn(evidence({ pane: IDLE })))).be.undefined();
    should(settlePermissionRequest(REQUEST, undefined, undefined)).be.undefined();
  });
});

describe('a harness dialog read as data', () => {
  const DIALOG: HarnessDialog = {
    id: '0123456789abcdef',
    harness: 'codex',
    kind: 'hooks-review',
    title: 'Hooks need review',
    options: [
      { number: 1, label: 'Review hooks', grantsTrust: false },
      { number: 2, label: 'Trust all and continue', grantsTrust: false },
    ],
    selected: 1,
    escape: 'skip',
  };
  const ON_SCREEN: TurnPaneEvidence = { working: false, atPrompt: true, permission: false, dialog: DIALOG };

  it('should call it needs-input on sight, even where the cursor row reads as a composer', () => {
    should(observeTurn(evidence({ pane: ON_SCREEN }))).deepEqual({
      state: 'needs-input',
      confirmed: true,
      dialog: DIALOG,
    });
  });

  it('should carry the dialog alongside a blocking prompt line when the pane has both', () => {
    should(observeTurn(evidence({ pane: { ...ON_SCREEN, prompt: 'Hooks need review' } }))).deepEqual({
      state: 'needs-input',
      confirmed: true,
      dialog: DIALOG,
      prompt: 'Hooks need review',
    });
  });

  it('should rank a question above it, and a dialog above a working pane', () => {
    should(observeTurn(evidence({ pane: ON_SCREEN, status: 'awaiting_question' }))).deepEqual({
      state: 'needs-input',
      confirmed: true,
    });
    should(observeTurn(evidence({ pane: { ...ON_SCREEN, working: true } }))?.dialog).equal(DIALOG);
  });

  it('should record the dialog only beside needs-input, and keep it while nothing decides the turn', () => {
    const seen = observeTurn(evidence({ pane: ON_SCREEN }));
    should(settleHarnessDialog(undefined, 'needs-input', seen)).equal(DIALOG);
    // Nothing to look at, or a weak your-turn not yet confirmed: what was recorded stands.
    should(settleHarnessDialog(DIALOG, 'needs-input', undefined)).equal(DIALOG);
    should(settleHarnessDialog(DIALOG, 'needs-input', { state: 'your-turn', confirmed: false })).equal(DIALOG);
    // A needs-input that is not a harness dialog replaces it.
    should(settleHarnessDialog(DIALOG, 'needs-input', { state: 'needs-input', confirmed: true })).be.undefined();
    // Answered: the turn moved on, and the dialog goes with it.
    should(settleHarnessDialog(DIALOG, 'working', observeTurn(evidence({ pane: IDLE })))).be.undefined();
    should(settleHarnessDialog(DIALOG, undefined, undefined)).be.undefined();
  });
});
