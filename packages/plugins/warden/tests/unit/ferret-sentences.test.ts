import { describe, expect, test } from 'bun:test';
import {
  actionSentence,
  anomalySentence,
  escalationSentences,
  verdictSentence,
  wardenFixedNudge,
  wardenFixedResumeReason,
  wardenFixedStopReason,
} from '../../daemon/lib/ferret-sentences.ts';
import { WardenActionKindSchema, WardenAnomalyKindSchema, WardenVerdictKindSchema } from '../../contract/index.ts';

describe('the fixed sentences', () => {
  test('every anomaly class, verdict and act has a sentence, and none carries a placeholder or a figure', () => {
    for (const kind of WardenAnomalyKindSchema.options) {
      expect(anomalySentence(kind)).toMatch(/^The Warden flagged this ferret: [a-z].+\.$/u);
      expect(escalationSentences(kind).subject).toBe(anomalySentence(kind));
    }
    for (const verdict of WardenVerdictKindSchema.options) expect(verdictSentence(verdict)).toMatch(/\.$/u);
    for (const action of WardenActionKindSchema.options)
      for (const outcome of ['done', 'held', 'failed'] as const)
        expect(actionSentence(action, outcome)).not.toMatch(/undefined|\$|\d/u);
  });

  test('what is typed into a ferret names only the class of flag', () => {
    expect(wardenFixedNudge('unattended_question')).toBe(
      'The Warden checked on you (it asked a question and nobody has answered). If you are blocked, say exactly what you need; otherwise carry on and post a short status.',
    );
    expect(wardenFixedNudge(undefined)).toContain('a flag on your work');
    expect(wardenFixedStopReason('agent_frozen')).toBe('Warden verdict (it stopped making progress)');
    expect(wardenFixedResumeReason('agent_frozen')).toBe('it stopped making progress');
  });
});
