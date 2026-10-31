import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AuthorizedOutcome,
  buildJevJudgeBody,
  type JevQuestionSet,
  JevTriageGuard,
  JUDGE_INSTRUCTIONS,
  JUDGE_NUDGE_KEY,
  jevJudgement,
  NUDGE_MESSAGES,
  parseJevJudgeReply,
} from '../../../src/lib/index.ts';
import { ScriptedAuthorizer, SteppingClock } from './fakes.ts';

/**
 * Jev's yes/no questions: the wire the Warden's decision tree asks over. One request carries every
 * question still open, each its own `choice` between yes and no, so each answer is independent — and
 * a reply that leaves any of them unanswered is no answer at all.
 */

const set: JevQuestionSet = {
  snapshot: {
    anomaly: 'sus_subprocess',
    summary: 'A tool command has run for 20m with nothing moving.',
    facts: { programRunning: true, outputChangedLately: false, subprocessRunningMinutes: 20 },
    recentTurns: ['assistant: running the integration suite'],
    acts: ['nudge', 'restart'],
  },
  questions: [
    { id: 'waiting_on_real', question: 'Is it waiting on something real?', yes: 'It waits.', no: 'It does not.' },
    { id: 'wait_reasonable', question: 'Is the wait reasonable?', yes: 'Normal.', no: 'Too long.' },
  ],
  nudgeMessages: ['stuck_command', 'wait_overdue'],
};

const answer = (choice: string, confidence = 0.9) => ({ type: 'choice', choice, confidence });

const completion = (answers: Record<string, unknown>) =>
  ({
    kind: 'completion' as const,
    payload: { model: 'jev-2026-10', answers, usage: { input_tokens: 800 } },
  }) satisfies AuthorizedOutcome;

describe('the yes/no request', () => {
  it('should ask each question on its own, yes or no, beside the nudge message, over one state', () => {
    // Act
    const body = buildJevJudgeBody(set, 'jev-latest');

    // Assert
    should(Object.keys(body.questions as object)).deepEqual(['waiting_on_real', 'wait_reasonable', JUDGE_NUDGE_KEY]);
    should((body.questions as Record<string, unknown>).waiting_on_real).deepEqual({
      type: 'choice',
      instructions: `${JUDGE_INSTRUCTIONS} Question: Is it waiting on something real?`,
      criteria: { yes: 'It waits.', no: 'It does not.' },
    });
    const nudge = (body.questions as Record<string, { criteria: Record<string, string> }>)[JUDGE_NUDGE_KEY];
    should(Object.keys(nudge?.criteria ?? {})).deepEqual(['stuck_command', 'wait_overdue', 'none']);
    // Nothing is chosen from a list of acts any more: the state carries no acts.
    should(body.state).not.have.property('acts');
    should(body).match({ model: 'jev-latest', state: { anomaly: 'sus_subprocess' } });
  });

  it('should leave the message question out when no nudge can follow', () => {
    const body = buildJevJudgeBody({ ...set, nudgeMessages: [] }, 'jev-latest');
    should(Object.keys(body.questions as object)).deepEqual(['waiting_on_real', 'wait_reasonable']);
  });
});

describe('the yes/no reply', () => {
  it('should read each answer with its own confidence, and the message chosen', () => {
    // Act
    const reply = parseJevJudgeReply(
      completion({
        waiting_on_real: answer('yes', 0.97),
        wait_reasonable: answer('no', 0.71),
        [JUDGE_NUDGE_KEY]: answer('stuck_command', 0.88),
      }).payload,
      set,
    );

    // Assert
    should(reply).deepEqual({
      answers: {
        waiting_on_real: { answer: 'yes', confidence: 0.97 },
        wait_reasonable: { answer: 'no', confidence: 0.71 },
      },
      nudge: { id: 'stuck_command', message: NUDGE_MESSAGES.stuck_command, confidence: 0.88 },
      model: 'jev-2026-10',
      inputTokens: 800,
    });
  });

  it('should be no answer when any question is unanswered, or answered with anything but yes or no', () => {
    should(parseJevJudgeReply(completion({ waiting_on_real: answer('yes') }).payload, set)).be.undefined();
    should(
      parseJevJudgeReply(completion({ waiting_on_real: answer('maybe'), wait_reasonable: answer('no') }).payload, set),
    ).be.undefined();
    should(
      parseJevJudgeReply(
        completion({ waiting_on_real: { choice: 'yes' }, wait_reasonable: answer('no') }).payload,
        set,
      ),
    ).be.undefined();
  });

  it('should drop a message that was not offered, or none', () => {
    const offered = (choice: string) =>
      parseJevJudgeReply(
        completion({ waiting_on_real: answer('yes'), wait_reasonable: answer('no'), [JUDGE_NUDGE_KEY]: answer(choice) })
          .payload,
        set,
      );
    should(offered('peer_gone')).not.have.property('nudge');
    should(offered('none')).not.have.property('nudge');
  });

  it('should turn a provider failure into a judgement with no answers, priced at nothing', () => {
    const failed = jevJudgement({ kind: 'status', status: 429, retryAfterSeconds: 3 }, set, {
      model: 'jev-latest',
      latencyMs: 12,
      usdPerMillionInputTokens: 0.05,
    });
    should(failed).deepEqual({
      answers: {},
      model: 'jev-latest',
      inputTokens: 0,
      latencyMs: 12,
      failure: { code: 'rate_limited', retryAfterMs: 3_000 },
    });
    should(jevJudgement(completion({}), set, { model: 'jev-latest', latencyMs: 1 }).failure).deepEqual({
      code: 'malformed',
    });
  });
});

describe('Jev judging through the outbound holder', () => {
  it('should send ONE request for every open question, and price it from the tokens', async () => {
    // Arrange
    const authorizer = new ScriptedAuthorizer(
      completion({ waiting_on_real: answer('no', 0.93), wait_reasonable: answer('yes', 0.6) }),
    );
    const guard = new JevTriageGuard(authorizer, new SteppingClock([100, 145]), { usdPerMillionInputTokens: 0.05 });

    // Act
    const actual = await guard.judge(set);

    // Assert
    should(authorizer.calls).have.length(1);
    should(JSON.parse(authorizer.calls[0]?.request.body ?? '{}').questions).have.keys(
      'waiting_on_real',
      'wait_reasonable',
      JUDGE_NUDGE_KEY,
    );
    should(actual).match({
      answers: { waiting_on_real: { answer: 'no', confidence: 0.93 } },
      latencyMs: 45,
      inputTokens: 800,
    });
    should(actual.costUsd).be.approximately(0.00004, 1e-12);
  });
});
