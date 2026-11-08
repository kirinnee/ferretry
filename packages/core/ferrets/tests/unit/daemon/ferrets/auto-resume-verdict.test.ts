/** W2-a, RULING #27 Q5: an automatic resume spends only on Runtimes' OWN yes (allow === true); every doubt is a no. */
import { describe, expect, test } from 'bun:test';
import type { DecideAnswer } from '@ferretry/kernel/contract';
import {
  AUTO_RESUME_ANSWERER,
  autoResumeVerdict,
  NO_AUTO_RESUME_ANSWER,
} from '../../../../daemon/lib/ferrets/auto-resume.ts';

const answered = (decision: DecideAnswer['decision'], answers: DecideAnswer['answers']): DecideAnswer => ({
  decision,
  answers,
});

describe('W2-a autoResumeVerdict', () => {
  test('W2-a the answerer is Runtimes, by its manifest id', () => {
    expect(AUTO_RESUME_ANSWERER).toBe('runtimes');
  });

  test("W2-a Runtimes' own yes is the one yes", () => {
    expect(autoResumeVerdict(answered({ allow: true }, [{ plugin: 'runtimes', outcome: 'allowed' }]))).toEqual({
      allow: true,
    });
  });

  test('W2-a no taker at all (the kernel answers allow) is a no', () => {
    expect(autoResumeVerdict(answered({ allow: true }, []))).toEqual({ allow: false, reason: NO_AUTO_RESUME_ANSWER });
  });

  test('W2-a a yes from any other plugin is a no', () => {
    expect(autoResumeVerdict(answered({ allow: true }, [{ plugin: 'usage', outcome: 'allowed' }]))).toEqual({
      allow: false,
      reason: NO_AUTO_RESUME_ANSWER,
    });
  });

  test("W2-a Runtimes failed, hung, threw or answered garbage (unanswered) is a no, never the kernel's sentence", () => {
    expect(
      autoResumeVerdict(
        answered({ allow: false, reason: 'runtimes did not answer in time.' }, [
          { plugin: 'runtimes', outcome: 'unanswered' },
        ]),
      ),
    ).toEqual({ allow: false, reason: NO_AUTO_RESUME_ANSWER });
  });

  test("W2-a Runtimes' own no is a no with its reason, bounded", () => {
    expect(
      autoResumeVerdict(
        answered({ allow: false, reason: 'Login work needs sign-in' }, [{ plugin: 'runtimes', outcome: 'refused' }]),
      ),
    ).toEqual({ allow: false, reason: 'Login work needs sign-in' });
    const long = autoResumeVerdict(
      answered({ allow: false, reason: 'x'.repeat(500) }, [{ plugin: 'runtimes', outcome: 'refused' }]),
    );
    expect(long.allow === false && long.reason.length).toBe(200);
  });

  test('W2-a a no from a taker asked before Runtimes stands, with its reason', () => {
    expect(
      autoResumeVerdict(answered({ allow: false, reason: 'paused' }, [{ plugin: 'usage', outcome: 'refused' }])),
    ).toEqual({ allow: false, reason: 'paused' });
  });

  test("W2-a a later taker's no after Runtimes' yes is still a no, with that taker's reason", () => {
    expect(
      autoResumeVerdict(
        answered({ allow: false, reason: 'budget' }, [
          { plugin: 'runtimes', outcome: 'allowed' },
          { plugin: 'usage', outcome: 'refused' },
        ]),
      ),
    ).toEqual({ allow: false, reason: 'budget' });
  });
});
