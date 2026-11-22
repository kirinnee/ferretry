import { describe, it } from 'bun:test';
import should from 'should';
import { paceOf, questionCount, twoDecisionSignals, twoDecisionsWarning } from '../../../cli/lib/two-decisions.ts';

describe('two decisions in one ask', () => {
  it('should count the questions a line asks, not a question mark inside a link', () => {
    should(questionCount('Approve the relay plan? And rename the app?')).equal(2);
    should(questionCount('Approve the relay plan?')).equal(1);
    should(questionCount('Open https://example.test/search?q=relay and pick one')).equal(0);
  });

  it('should read the pace a question speaks of', () => {
    should(paceOf('Can I merge this before the deploy?')).equal('soon');
    should(paceOf('Should the relay go out today?')).equal('soon');
    should(paceOf('Which logo do you want, no rush?')).equal('later');
    should(paceOf('Revisit the pricing next quarter?')).equal('later');
    should(paceOf('Which relay should we use?')).equal(undefined);
  });

  it('should warn on an ask that asks two questions in one line', () => {
    // Act
    const signals = twoDecisionSignals({ subject: 'Ship the relay fix? Also, should we drop Safari 16?' });

    // Assert
    should(signals).eql(['the ask asks 2 questions in one line']);
  });

  it('should warn on questions wanted at different paces', () => {
    // Act
    const signals = twoDecisionSignals({
      subject: 'Two relay questions',
      questions: [{ question: 'Can I merge the fix now?' }, { question: 'Which plan for the cache next month?' }],
    });

    // Assert
    should(signals).eql(['its questions are wanted at different paces (one soon, one later)']);
  });

  it('should stay quiet on one decision, and on several questions of one pace', () => {
    should(twoDecisionSignals({ subject: 'Pick the relay' })).eql([]);
    should(twoDecisionSignals({ subject: 'Approve the relay plan?' })).eql([]);
    should(
      twoDecisionSignals({
        subject: 'Relay plan',
        questions: [{ question: 'Which region?' }, { question: 'Which size?' }],
      }),
    ).eql([]);
    should(twoDecisionsWarning({ subject: 'Pick the relay' })).equal(undefined);
  });

  it('should say both rules in the warning: independent decisions split, dependent ones share', () => {
    // Act
    const warning = twoDecisionsWarning({ subject: 'Ship it? Rename it?' }) ?? '';

    // Assert
    should(warning).startWith('This looks like two decisions: the ask asks 2 questions in one line.');
    should(warning).containEql('different backgrounds or paces belong in two agendas');
    should(warning).containEql('if deciding one changes the\nother, they share one');
  });
});
