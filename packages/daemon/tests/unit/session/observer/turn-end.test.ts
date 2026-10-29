import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import {
  stepTurn,
  type TurnFacts,
  type TurnLook,
  turnPaneEvidenceOf,
} from '../../../../src/lib/session/observer/index.ts';
import type { TurnObservation } from '../../../../src/lib/session/turn/policy.ts';
import { parsePaneMetadata, paneStateFrom } from '../../../../src/lib/tmux/pane.ts';
import { ClaudeTranscriptParser } from '../../../../src/lib/transcript/claude.ts';

/**
 * A finished turn the daemon held at `working` for three hours — Claude Code 2.1.281's feedback-draft
 * panel stayed on the idle screen and its title read as a spinner. Every look here is the turn part's
 * real path: a REAL captured frame through the pane parsers, and Claude JSONL of the shape the harness
 * wrote at that turn's end (`end_turn`, then `turn_duration`) through the transcript parser.
 */

const FIXTURES = join(import.meta.dir, '../../../fixtures/composer');
const NAME = 'claude-2.1.281-feedback-draft-idle';
const IDLE_FRAME = readFileSync(join(FIXTURES, `${NAME}.txt`), 'utf8');
const [CURSOR_X, CURSOR_Y] = readFileSync(join(FIXTURES, `${NAME}.cursor`), 'utf8')
  .trim()
  .split('|');

const record = (fields: Record<string, unknown>): string =>
  JSON.stringify({ sessionId: 's-1', version: '2.1.281', isSidechain: false, ...fields });
const ENDED = [
  record({ type: 'user', uuid: 'u1', timestamp: '2026-10-29T00:09:27.000Z', message: { role: 'user', content: 'go' } }),
  record({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-10-29T00:09:49.127Z',
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
    },
  }),
  record({ type: 'system', subtype: 'turn_duration', durationMs: 22312, timestamp: '2026-10-29T00:09:49.195Z' }),
];
const transcript = (lines: readonly string[]) =>
  new ClaudeTranscriptParser().parse({ text: `${lines.join('\n')}\n` }).events;

const look = (visible: string, lines: readonly string[]): TurnLook => ({
  transcript: transcript(lines),
  pane: turnPaneEvidenceOf(paneStateFrom(parsePaneMetadata(`0||${CURSOR_X}|${CURSOR_Y}|24|80`), visible)),
});

/** Two looks in a row, as the watcher and a session worker take them: the second confirms the first. */
function twoLooks(facts: TurnFacts, at: TurnLook): { first: TurnFacts; second: TurnFacts } {
  const apply = (state: TurnFacts, previous: TurnObservation | undefined) => {
    const step = stepTurn(state, previous, at);
    return { facts: step.change === undefined ? state : { ...state, turnState: step.change.to }, step };
  };
  const one = apply(facts, undefined);
  const two = apply(one.facts, one.step.observation);
  return { first: one.facts, second: two.facts };
}

const stuck: TurnFacts = { status: 'running', turn: 268, turnState: 'working' };

describe('a finished turn under the feedback-draft panel', () => {
  it('should heal a stuck working to your-turn from the real idle frame', () => {
    // Act
    const actual = twoLooks(stuck, look(IDLE_FRAME, ENDED));

    // Assert — the pane and the transcript agree the turn is over, so it is recorded at once.
    should(actual.first.turnState).equal('your-turn');
    should(actual.second.turnState).equal('your-turn');
  });

  it('should let the transcript boundary end a turn a spinner shape alone still calls working', () => {
    // Arrange — a spinner-shaped line at the left edge with no status line: whatever draws one next.
    const shaped = IDLE_FRAME.replace('│ ✻ Bug report drafted:', '✻ Bug report drafted:');

    // Act
    const actual = twoLooks(stuck, look(shaped, ENDED));

    // Assert — the end is weak against the shape, so it takes the second look to record it.
    should(actual).deepEqual({ first: stuck, second: { ...stuck, turnState: 'your-turn' } });
  });

  it('should keep a turn the transcript shows still running at working', () => {
    // Arrange — the person's next message landed after the boundary, and the spinner shows.
    const next = [...ENDED, record({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'more' } })];
    const shaped = IDLE_FRAME.replace(/^✻ Crunched for .*$/mu, '✽ Tomfoolering…');

    // Act
    const actual = twoLooks(stuck, look(shaped, next));

    // Assert
    should(actual.second.turnState).equal('working');
  });
});
