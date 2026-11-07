import { describe, it } from 'bun:test';
import should from 'should';
import { stepTurn, type TurnFacts, type TurnLook } from '../../../../../daemon/lib/session/observer/index.ts';
import type { TranscriptEvent } from '../../../../../daemon/lib/session/peers/transcript.ts';
import { limitPatch } from '../../../../../daemon/lib/session/peers/turn.ts';

/**
 * A Codex sub-ferret on a spent login (2026-10-31): every message to it ended in half a second with
 * "Usage limit reached" on the pane, and the daemon recorded each one as an ordinary end of turn, so the
 * session sat `running` at `your-turn` for seven hours. Each look goes through the turn part's real path.
 *
 * The transcript is the events the Codex rollout parser (conversation, host-provided in core) reads from what
 * Codex wrote: `task_started` is a turn start, and a `task_complete` carrying `error` is a turn end followed by
 * that error, its `codex_error_info` as the code. How the parser reads the records is its owner's test.
 */

const AT = '2026-10-31T05:18:17.249Z';
const turn = (state: 'started' | 'completed'): TranscriptEvent => ({
  harness: 'codex',
  role: 'system',
  timestamp: AT,
  kind: 'turn',
  state,
});
const REFUSED: readonly TranscriptEvent[] = [
  turn('started'),
  turn('completed'),
  {
    harness: 'codex',
    role: 'system',
    timestamp: AT,
    kind: 'error',
    error: {
      message: 'Your workspace is out of credits. Add credits to continue.',
      code: 'usage_limit_exceeded',
      recoverable: true,
    },
  },
];
const CLEAN: readonly TranscriptEvent[] = [turn('started'), turn('completed')];

/** No pane frame: the transcript alone ends the turn, so it takes two looks, as it does on a live ferret. */
const look = (events: readonly TranscriptEvent[]): TurnLook => ({ transcript: events, pane: undefined });

function endTurn(facts: TurnFacts, at: TurnLook) {
  const first = stepTurn(facts, undefined, at);
  return stepTurn(facts, first.observation, at);
}

describe('a Codex turn that ended on its login limit', () => {
  it('should carry the limit on the turn end, so the session is recorded rate limited', () => {
    // Act
    const step = endTurn({ status: 'running', turn: 4, turnState: 'working' }, look(REFUSED));
    const patch = limitPatch({ status: 'running' }, step.change?.dialog, 0, {
      limit: step.change?.limit,
      to: step.change?.to,
    });

    // Assert
    should(step.change?.to).equal('your-turn');
    should(step.change?.limit).deepEqual({
      notice: 'Your workspace is out of credits. Add credits to continue.',
      spend: false,
    });
    should(patch?.status).equal('rate_limited');
    should(patch?.quota?.limitNotice).equal('Your workspace is out of credits. Add credits to continue.');
  });

  it('should carry no limit on a turn that ended cleanly after it', () => {
    // Act
    const step = endTurn({ status: 'running', turn: 5, turnState: 'working' }, look([...REFUSED, ...CLEAN]));

    // Assert
    should(step.change?.to).equal('your-turn');
    should(step.change?.limit).be.undefined();
  });
});
