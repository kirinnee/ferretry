import { describe, it } from 'bun:test';
import should from 'should';
import { stepTurn, type TurnFacts, type TurnLook } from '../../../../src/lib/session/observer/index.ts';
import { limitPatch } from '../../../../src/lib/session/turn/usage-limit.ts';
import { CodexTranscriptParser } from '../../../../src/lib/transcript/codex.ts';

/**
 * A Codex sub-ferret on a spent login (2026-10-31): every message to it ended in half a second with
 * "Usage limit reached" on the pane, and the daemon recorded each one as an ordinary end of turn, so the
 * session sat `running` at `your-turn` for seven hours. The rollout records below are the shape Codex
 * wrote; each look goes through the real transcript parser and the turn part's real path.
 */

const record = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ timestamp: '2026-10-31T05:18:17.249Z', type: 'event_msg', payload: { type, ...extra } });
const REFUSED = [
  record('task_started', { turn_id: 'turn-4' }),
  record('task_complete', {
    turn_id: 'turn-4',
    last_agent_message: null,
    error: {
      message: 'Your workspace is out of credits. Add credits to continue.',
      codex_error_info: 'usage_limit_exceeded',
    },
  }),
];
const CLEAN = [record('task_started', { turn_id: 'turn-5' }), record('task_complete', { turn_id: 'turn-5' })];

const transcript = (lines: readonly string[]) =>
  new CodexTranscriptParser().parse({ text: `${lines.join('\n')}\n` }).events;
/** No pane frame: the transcript alone ends the turn, so it takes two looks, as it does on a live ferret. */
const look = (lines: readonly string[]): TurnLook => ({ transcript: transcript(lines), pane: undefined });

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
