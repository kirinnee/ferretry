import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId } from '../../../../src/lib/index.ts';
import {
  authorizeResume,
  defaultSessionResumeSettings,
  findRecoveryScopeConflict,
  isTerminalForResume,
  parseSessionResumeSettings,
  planResume,
  resolveResumePolicy,
  resumeTurnDocument,
  resumeTurnInstruction,
  ResumeCancelled,
  ResumeRefused,
  ReviveDedupeConflict,
  type PaneObservation,
  type ResumePolicy,
  type ResumeTarget,
} from '../../../../src/lib/session/resume/index.ts';

const SETTINGS = defaultSessionResumeSettings;
const LIVE: PaneObservation = { alive: true, dead: false, promptReady: true };
const DEAD_PANE: PaneObservation = { alive: true, dead: true, promptReady: false };
const NO_PANE: PaneObservation = { alive: false, dead: false, promptReady: false };

function target(overrides: Partial<ResumeTarget> = {}): ResumeTarget {
  return {
    id: parseSessionId('session-1'),
    status: 'running',
    mode: 'auto',
    cwd: '/workspace/project',
    turn: 3,
    ...overrides,
  };
}

/** The advisory a bare operator resume may dismiss, and the blocking kind nothing here may touch. */
const RELEASED = 'structured-answer-released-unconfirmed';
const UNCONFIRMED = 'structured-answer-unconfirmed';

const OPERATOR: ResumePolicy = { automatic: false, dedupeSharedRecoveryScope: false, humanOperator: true };
const EXPLICIT: ResumePolicy = { automatic: false, dedupeSharedRecoveryScope: false, humanOperator: false };
const AUTOMATIC: ResumePolicy = { automatic: true, dedupeSharedRecoveryScope: true, humanOperator: false };

describe('resume policy resolution', () => {
  it('should treat operator and peer calls as explicit', () => {
    // Act
    const actual = (['admin-cli', 'admin-ui', 'peer'] as const).map(actor => resolveResumePolicy(actor));

    // Assert
    should(actual).deepEqual([OPERATOR, OPERATOR, EXPLICIT]);
  });

  it('should give operator standing to the two admin actors and to nothing else', () => {
    // Arrange — `peer` is the one that matters: it is explicit, so `!automatic` would have handed a
    // relaying daemon the right to dismiss a warning meant for the person at the terminal.
    const actors = ['admin-cli', 'admin-ui', 'peer', 'warden', 'daemon', 'unknown'] as const;

    // Act
    const actual = actors.map(actor => resolveResumePolicy(actor).humanOperator);

    // Assert
    should(actual).deepEqual([true, true, false, false, false, false]);
  });

  it('should treat automated and unrecognised callers as automatic, never as operators', () => {
    // Arrange — an absent policy used to mean "explicit", so a new automated caller silently gained
    // operator privileges by not being listed.
    const actors = ['warden', 'daemon', 'unknown'] as const;

    // Act
    const actual = actors.map(actor => resolveResumePolicy(actor));

    // Assert
    should(actual).deepEqual([AUTOMATIC, AUTOMATIC, AUTOMATIC]);
  });
});

describe('resume refusals', () => {
  it('should refuse a session whose previous shutdown was never confirmed', () => {
    // Act / Assert
    should(() => authorizeResume(target({ status: 'kill_failed' }), NO_PANE, EXPLICIT, [])).throw(
      /shutdown for session-1 was not confirmed/u,
    );
  });

  it('should refuse when the session moved out from under the scheduler', () => {
    // Arrange
    const policy: ResumePolicy = { ...AUTOMATIC, expectedStatus: 'retrying' };

    // Act / Assert
    should(() => authorizeResume(target({ status: 'running' }), NO_PANE, policy, [])).throw(ResumeCancelled);
  });

  it('should accept a guard the session still satisfies', () => {
    // Arrange
    const policy: ResumePolicy = { ...AUTOMATIC, expectedStatus: 'retrying', retryAttempt: 2 };

    // Act / Assert
    should(() => authorizeResume(target({ status: 'retrying', retryAttempt: 2 }), NO_PANE, policy, [])).not.throw();
  });

  it('should refuse when another scheduler already consumed the retry attempt', () => {
    // Arrange
    const policy: ResumePolicy = { ...AUTOMATIC, expectedStatus: 'retrying', retryAttempt: 1 };

    // Act / Assert
    should(() => authorizeResume(target({ status: 'retrying', retryAttempt: 2 }), NO_PANE, policy, [])).throw(
      ResumeCancelled,
    );
  });

  it('should treat an absent retry counter as attempt zero', () => {
    // Arrange
    const policy: ResumePolicy = { ...AUTOMATIC, expectedStatus: 'retrying', retryAttempt: 0 };

    // Act / Assert
    should(() => authorizeResume(target({ status: 'retrying' }), NO_PANE, policy, [])).not.throw();
  });

  it('should refuse to relaunch a live session holding an unanswered question', () => {
    // Arrange
    const holding = target({ pendingQuestion: { toolUseId: 'tool-1' } });

    // Act / Assert
    should(() => authorizeResume(holding, LIVE, EXPLICIT, [])).throw(/answer or abandon the pending question/u);
  });

  it('should allow reviving a terminal session whose question died with its pane', () => {
    // Arrange
    const finished = target({ status: 'stopped', pendingQuestion: { toolUseId: 'tool-1' } });

    // Act / Assert
    should(() => authorizeResume(finished, LIVE, EXPLICIT, [])).not.throw();
  });

  it('should allow reviving when the pane holding the question is already dead', () => {
    // Arrange
    const holding = target({ pendingQuestion: { toolUseId: 'tool-1' } });

    // Act / Assert
    should(() => authorizeResume(holding, DEAD_PANE, EXPLICIT, [])).not.throw();
  });
});

describe('recovery scope dedupe', () => {
  const batched = target({ label: 'my-batch', status: 'failed' });

  it('should suppress an automatic revive when a live sibling shares the batch and checkout', () => {
    // Arrange
    const sibling = target({ id: parseSessionId('session-2'), label: 'my-batch', status: 'running' });

    // Act / Assert
    should(() => authorizeResume(batched, NO_PANE, AUTOMATIC, [sibling])).throw(ReviveDedupeConflict);
  });

  it('should never suppress an operator resume, whatever the batch looks like', () => {
    // Arrange — a label is a batch slug, not lineage; only the automated path may consult it.
    const sibling = target({ id: parseSessionId('session-2'), label: 'my-batch', status: 'running' });

    // Act / Assert
    should(() => authorizeResume(batched, NO_PANE, EXPLICIT, [sibling])).not.throw();
  });

  it('should ignore a sibling that has itself finished', () => {
    // Arrange
    const sibling = target({ id: parseSessionId('session-2'), label: 'my-batch', status: 'stopped' });

    // Act
    const actual = findRecoveryScopeConflict(batched, [sibling]);

    // Assert
    should(actual).be.undefined();
  });

  it('should match on the resolved checkout rather than the literal string', () => {
    // Arrange
    const sibling = target({
      id: parseSessionId('session-2'),
      label: 'my-batch',
      cwd: '/workspace/project/../project',
    });

    // Act
    const actual = findRecoveryScopeConflict(batched, [sibling]);

    // Assert
    should(actual?.id).equal('session-2');
  });

  it('should match nothing for a session with no label, so unlabelled sessions never collide', () => {
    // Arrange
    const sibling = target({ id: parseSessionId('session-2') });

    // Act
    const actual = findRecoveryScopeConflict(target({ label: '   ' }), [sibling]);

    // Assert
    should(actual).be.undefined();
  });

  it('should match nothing when either checkout is blank', () => {
    // Arrange
    const blank = target({ label: 'my-batch', cwd: '   ' });
    const sibling = target({ id: parseSessionId('session-2'), label: 'my-batch', cwd: '  ' });

    // Act
    const actual = [
      findRecoveryScopeConflict(blank, [target({ id: parseSessionId('session-3'), label: 'my-batch' })]),
      findRecoveryScopeConflict(batched, [sibling]),
    ];

    // Assert
    should(actual).deepEqual([undefined, undefined]);
  });

  it('should never match the session against itself', () => {
    // Act
    const actual = findRecoveryScopeConflict(batched, [batched]);

    // Assert
    should(actual).be.undefined();
  });
});

describe('resume plan', () => {
  it('should type into a live supervised session rather than replacing it', () => {
    // Act
    const actual = planResume(target(), LIVE, '  do the next thing  ', EXPLICIT, SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'send', message: 'do the next thing' });
  });

  it('should replace a live pane when the caller is moving the session to another account', () => {
    // A MIGRATION cannot take the send shortcut: the point of it is that a different executable
    // answers the next turn, so typing the handoff into the harness that is already running would
    // leave the old account serving a session whose own record says it moved. Everything else about
    // the relaunch is the same, which is why this is a policy field and not a second code path.
    // Arrange
    const migrating: ResumePolicy = { ...EXPLICIT, replaceLiveTerminal: true };

    // Act
    const actual = planResume(target(), LIVE, 'read the migration report', migrating, SETTINGS);

    // Assert
    should(actual.kind).equal('relaunch');
    // Snapshot first: the pane is live, and its final frame is the only record of unsent input.
    should(actual).have.property('pane', 'snapshot-and-kill');
    // The turn advances, so the replacement agent reads a NEW document rather than the assignment
    // the agent being replaced was already working from.
    should(actual).have.property('turn', 4);
    should(actual).have.property('prompt', 'read the migration report');
  });

  it('should refuse a message-less resume of a session that is already running', () => {
    // Act / Assert
    should(() => planResume(target(), LIVE, undefined, EXPLICIT, SETTINGS)).throw(ResumeRefused);
  });

  it('should replace a terminal session leftover pane rather than send into it', () => {
    // Arrange — nothing monitors that pane, so a message typed there would simply be lost.
    const finished = target({ status: 'stopped' });

    // Act
    const actual = planResume(finished, LIVE, 'pick this back up', EXPLICIT, SETTINGS);

    // Assert
    should(actual.kind).equal('relaunch');
    should(actual).have.property('pane', 'snapshot-and-kill');
  });

  it('should replace a quarantined session pane even while it looks alive', () => {
    // Arrange
    const quarantined = target({ needsHumanKind: 'picker_cleanup' });

    // Act
    const actual = planResume(quarantined, LIVE, 'retry', EXPLICIT, SETTINGS);

    // Assert
    should(actual.kind).equal('relaunch');
  });

  it('should send through a positively released answer advisory without replacing the live pane', () => {
    const released = target({ needsHumanKind: 'structured-answer-released-unconfirmed' });

    const actual = planResume(released, LIVE, 'reply in prose', EXPLICIT, SETTINGS);

    should(actual).deepEqual({ kind: 'send', message: 'reply in prose' });
  });

  it('should clean a dead pane quietly, with no composer to preserve', () => {
    // Act
    const actual = planResume(target({ status: 'failed' }), DEAD_PANE, 'again', EXPLICIT, SETTINGS);

    // Assert
    should(actual).have.property('pane', 'quiet-cleanup');
  });

  it('should advance the turn and use the default prompt when no message was given', () => {
    // Act
    const actual = planResume(target({ status: 'failed' }), NO_PANE, undefined, EXPLICIT, SETTINGS);

    // Assert
    should(actual).deepEqual({
      kind: 'relaunch',
      pane: 'none',
      bare: false,
      turn: 4,
      prompt: SETTINGS.defaultResumePrompt,
      cancelPendingQuestion: false,
      clearNeedsHuman: true,
      acknowledgeAnswerAttention: false,
      resetRetryAttempt: true,
    });
  });

  it('should give an interactive session its terminal back without inventing a turn', () => {
    // Arrange — telling a human's TUI to "continue the assigned task" is a turn nobody asked for.
    const human = target({ status: 'stopped', mode: 'interactive' });

    // Act
    const actual = planResume(human, NO_PANE, '   ', EXPLICIT, SETTINGS);

    // Assert
    should(actual).have.property('bare', true);
    should(actual).have.property('turn', 3);
    should(actual).have.property('prompt', undefined);
  });

  it('should still write a turn for an interactive session resumed WITH a message', () => {
    // Act
    const actual = planResume(
      target({ status: 'stopped', mode: 'interactive' }),
      NO_PANE,
      'take another look',
      EXPLICIT,
      SETTINGS,
    );

    // Assert
    should(actual).have.property('bare', false);
    should(actual).have.property('prompt', 'take another look');
  });

  it('should not clear human attention on an automatic revive', () => {
    // Arrange — an automatic retry must not clear a flag an operator has not yet seen.
    const quarantined = target({ status: 'failed', needsHumanKind: 'picker_cleanup' });

    // Act
    const actual = planResume(quarantined, NO_PANE, undefined, AUTOMATIC, SETTINGS);

    // Assert
    should(actual).have.property('clearNeedsHuman', false);
  });

  it('should keep the retry counter for an automatic retry and reset it for anything else', () => {
    // Arrange
    const retrying = target({ status: 'retrying', retryAttempt: 2 });

    // Act
    const automatic = planResume(retrying, NO_PANE, undefined, { ...AUTOMATIC, expectedStatus: 'retrying' }, SETTINGS);
    const explicit = planResume(retrying, NO_PANE, undefined, EXPLICIT, SETTINGS);

    // Assert
    should(automatic).have.property('resetRetryAttempt', false);
    should(explicit).have.property('resetRetryAttempt', true);
  });

  it('should flag a pending question for cancellation when the pane is gone', () => {
    // Act
    const actual = planResume(
      target({ status: 'failed', pendingQuestion: { toolUseId: 'tool-1' } }),
      NO_PANE,
      undefined,
      EXPLICIT,
      SETTINGS,
    );

    // Assert
    should(actual).have.property('cancelPendingQuestion', true);
  });
});

describe('resume turn documents', () => {
  it('should carry the prompt and the protocol reminder', () => {
    // Act
    const actual = resumeTurnDocument('Fix the failing test', SETTINGS);

    // Assert
    should(actual).equal(`Fix the failing test\n\n${SETTINGS.turnProtocolReminder}\n`);
  });

  it('should point the agent at the file rather than paste the turn into a composer', () => {
    // Act
    const actual = resumeTurnInstruction('/state/sessions/session-1/turns/turn-004.md');

    // Assert
    should(actual).containEql('/state/sessions/session-1/turns/turn-004.md');
  });
});

describe('terminal classification', () => {
  it('should treat only genuinely finished statuses as terminal', () => {
    // Arrange
    const statuses = ['created', 'starting', 'running', 'retrying', 'kill_failed', 'failed', 'stopped'] as const;

    // Act
    const actual = statuses.map(status => isTerminalForResume(target({ status })));

    // Assert
    should(actual).deepEqual([false, false, false, false, false, true, true]);
  });

  it('should classify every status the state document can actually hold', () => {
    // The resumable set used to be the LIFECYCLE's six plus `retrying`, so a session sitting in any
    // of these parsed as nothing and the revive answered "session not found" about a session the
    // list was serving. They are ordinary non-terminal states — `stalled` and `rate_limited` are the
    // two an operator revives from — except `completed`, which has no agent left to type into.
    // Arrange
    const statuses = [
      'thinking',
      'tool_running',
      'awaiting_question',
      'awaiting_user',
      'interrupted',
      'rate_limited',
      'waiting',
      'stalled',
      'completed',
    ] as const;

    // Act
    const actual = statuses.map(status => isTerminalForResume(target({ status })));

    // Assert
    should(actual).deepEqual([false, false, false, false, false, false, false, false, true]);
  });
});

describe('resume plan for a released structured-answer advisory', () => {
  const advisory = (overrides: Partial<ResumeTarget> = {}): ResumeTarget =>
    target({ needsHumanKind: RELEASED, ...overrides });

  it('should let a bare operator resume reach a relaunch on a live pane', () => {
    // Arrange — the advisory is not an input modal, so this pane kept the send shortcut and a
    // message-free resume met `already running`: the one action allowed to dismiss the warning was
    // unreachable on exactly the sessions that carry it.
    // Act
    const actual = planResume(advisory(), LIVE, undefined, OPERATOR, SETTINGS);

    // Assert
    should(actual.kind).equal('relaunch');
    should(actual).have.property('acknowledgeAnswerAttention', true);
    should(actual).have.property('clearNeedsHuman', true);
    should(actual).have.property('pane', 'snapshot-and-kill');
  });

  it('should dismiss from an auto-mode session, whose relaunch is never a bare one', () => {
    // Arrange — the trap: `ResumeAction.bare` also means "interactive, so invent no turn". An auto
    // session with no message synthesises the default prompt and is NOT bare by that field, yet it
    // is still the operator's message-free dismissal. Reading the action's field instead of the
    // request would leave every auto session unable to clear its advisory.
    // Act
    const actual = planResume(advisory({ status: 'stopped', mode: 'auto' }), NO_PANE, undefined, OPERATOR, SETTINGS);

    // Assert
    should(actual).have.property('bare', false);
    should(actual).have.property('prompt', SETTINGS.defaultResumePrompt);
    should(actual).have.property('acknowledgeAnswerAttention', true);
  });

  it('should treat any caller-supplied message as prose that dismisses nothing', () => {
    // Act
    const live = planResume(advisory(), LIVE, 'reply in prose', OPERATOR, SETTINGS);
    const relaunched = planResume(advisory({ status: 'stopped' }), NO_PANE, 'pick this up', OPERATOR, SETTINGS);

    // Assert — one stays a send, one is a relaunch, and neither closes the warning.
    should(live).deepEqual({ kind: 'send', message: 'reply in prose' });
    should(relaunched).have.property('acknowledgeAnswerAttention', false);
    should(relaunched).have.property('clearNeedsHuman', false);
  });

  it('should not let a whitespace message buy the dismissal', () => {
    // Arrange — `ResumeSessionRequest` only requires a non-empty string, so `"   "` is a message the
    // caller supplied. Testing the TRIMMED value would hand the one privileged action to any payload
    // willing to send a space, which is the cheapest possible way to launder prose into a dismissal.
    // Act
    const stopped = planResume(advisory({ status: 'stopped' }), NO_PANE, '   ', OPERATOR, SETTINGS);

    // Assert — it still relaunches, and it still dismisses nothing.
    should(stopped.kind).equal('relaunch');
    should(stopped).have.property('acknowledgeAnswerAttention', false);
    should(stopped).have.property('clearNeedsHuman', false);
    // And on a live pane it keeps the ordinary refusal rather than gaining the relaunch path.
    should(() => planResume(advisory(), LIVE, '   ', OPERATOR, SETTINGS)).throw(/already running/u);
  });

  it('should refuse a peer and an automatic reviver the dismissal', () => {
    // Act
    const peer = planResume(advisory({ status: 'stopped' }), NO_PANE, undefined, EXPLICIT, SETTINGS);
    const automatic = planResume(advisory({ status: 'stopped' }), NO_PANE, undefined, AUTOMATIC, SETTINGS);

    // Assert
    should(peer).have.property('acknowledgeAnswerAttention', false);
    should(peer).have.property('clearNeedsHuman', false);
    should(automatic).have.property('acknowledgeAnswerAttention', false);
    should(automatic).have.property('clearNeedsHuman', false);
  });

  it('should still refuse a bare peer resume of a live session as already running', () => {
    // Arrange — giving up the send shortcut is the dismissal's privilege, not everyone's.
    // Act / Assert
    should(() => planResume(advisory(), LIVE, undefined, EXPLICIT, SETTINGS)).throw(/already running/u);
  });

  it('should never dismiss or clear the blocking unconfirmed kind', () => {
    // Arrange — a possibly-live form is an unknown native modal; no relaunch can reason about it.
    const blocked = target({ status: 'stopped', needsHumanKind: UNCONFIRMED });

    // Act
    const actual = planResume(blocked, NO_PANE, undefined, OPERATOR, SETTINGS);

    // Assert
    should(actual).have.property('acknowledgeAnswerAttention', false);
    should(actual).have.property('clearNeedsHuman', false);
  });

  it('should leave every other attention kind clearing exactly as it did', () => {
    // Arrange — the narrowing is for the two answer kinds only.
    const other = target({ status: 'failed', needsHumanKind: 'picker_cleanup' });

    // Act
    const operator = planResume(other, NO_PANE, undefined, OPERATOR, SETTINGS);
    const peer = planResume(other, NO_PANE, undefined, EXPLICIT, SETTINGS);
    const automatic = planResume(other, NO_PANE, undefined, AUTOMATIC, SETTINGS);

    // Assert
    should(operator).have.property('clearNeedsHuman', true);
    should(peer).have.property('clearNeedsHuman', true);
    should(automatic).have.property('clearNeedsHuman', false);
  });

  it('should still refuse a live session holding a newer question', () => {
    // Arrange — the advisory does not license replacing a pane that is mid-conversation.
    const asking = advisory({ pendingQuestion: { toolUseId: 'tool-2' } });

    // Act / Assert
    should(() => authorizeResume(asking, LIVE, OPERATOR, [])).throw(/answer or abandon/u);
  });
});

describe('resume settings', () => {
  it('should accept the shipped defaults', () => {
    // Act
    const actual = parseSessionResumeSettings({ ...SETTINGS });

    // Assert
    should(actual).deepEqual(SETTINGS);
  });

  it('should refuse a backoff ceiling below its own first step', () => {
    // Act / Assert
    should(() => parseSessionResumeSettings({ ...SETTINGS, retryBackoffMaxMs: 1 })).throw(
      /retryBackoffMaxMs must be at least retryBackoffBaseMs/u,
    );
  });

  it('should refuse an empty default prompt, which would revive an agent with no instruction', () => {
    // Act / Assert
    should(() => parseSessionResumeSettings({ ...SETTINGS, defaultResumePrompt: '' })).throw();
  });
});
