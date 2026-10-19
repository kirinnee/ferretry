import { describe, it } from 'bun:test';
import should from 'should';
import { renderPackNewOutcome, renderPackRecommendation } from '../../../src/lib/pack/render.ts';
import { attempt, recommendation, refused, started, startedView } from './fixtures.ts';

describe('renderPackRecommendation', () => {
  it('should name the use case, its match and the guide, then each ready candidate and the start command', () => {
    // Arrange + Act
    const text = renderPackRecommendation(recommendation());

    // Assert
    should(text.split('\n')).eql([
      "Use case: Bulk edits (bulk, from the task's words; the built-in guide)",
      '',
      '1. ready   Haiku 4.5 (claude-haiku-4-5) on claude-work · effort low',
      '   cheap and quick',
      '',
      'Start the first: fy new --runtime claude-work --model claude-haiku-4-5 "<brief>"',
    ]);
  });

  it('should word every way a use case can be matched and name the owner guide', () => {
    // Arrange + Act
    const named = renderPackRecommendation(
      recommendation({ useCase: { id: 'bulk', title: 'Bulk edits', matchedBy: 'named' }, guideSource: 'file' }),
    );
    const fallback = renderPackRecommendation(
      recommendation({ useCase: { id: 'daily', title: 'Everyday', matchedBy: 'fallback' } }),
    );

    // Assert
    should(named).startWith('Use case: Bulk edits (bulk, as named; your models guide)');
    should(fallback).startWith('Use case: Everyday (daily, no use case matched, so the everyday one; the built-in guide)');
  });

  it('should show a bare model, a missing runtime and effort, and the refusal of a candidate that cannot run', () => {
    // Arrange
    const text = renderPackRecommendation(
      recommendation({
        candidates: [
          {
            rank: 2,
            provider: 'openai',
            model: 'gpt-x',
            why: 'strong',
            ready: false,
            refusal: { code: 'cli_missing', message: 'codex is not installed' },
          },
        ],
        next: undefined,
      }),
    );

    // Assert
    should(text.split('\n').slice(2)).eql([
      '2. cannot  gpt-x',
      '   strong',
      '   cli_missing: codex is not installed',
      '',
      'Nothing can run it here now.',
    ]);
  });

  it('should print an empty candidate list as nothing runnable', () => {
    // Arrange + Act
    const text = renderPackRecommendation(recommendation({ candidates: [], next: undefined }));

    // Assert
    should(text.split('\n').slice(2)).eql(['', 'Nothing can run it here now.']);
  });
});

describe('renderPackNewOutcome', () => {
  it('should say who started, on what, decided by whom, then how to wait', () => {
    // Arrange
    const outcome = started({ view: startedView({ model: 'claude-haiku-4-5' }), decidedBy: 'guide' });

    // Act
    const text = renderPackNewOutcome(outcome, 'fy');

    // Assert
    should(text.split('\n')).eql([
      'Started child-1 on claude-work, claude-haiku-4-5 — decided by guide.',
      'Wait for its result: fy wait child-1',
    ]);
  });

  it('should name the teammate and credit the asking ferret when it decided', () => {
    // Arrange
    const outcome = started({ view: startedView({ teammate: 'Fix Scrolling' }), decidedBy: 'agent' });

    // Act
    const text = renderPackNewOutcome(outcome, 'foo');

    // Assert
    should(text.split('\n')).eql([
      'Started Fix Scrolling (child-1) on claude-work — decided by you.',
      'Wait for its result: foo wait child-1',
    ]);
  });

  it('should include the note and every attempt: started, probed, cached, refused', () => {
    // Arrange
    const outcome = started({
      decidedBy: 'jev',
      note: 'Jev could not decide, so the guide order was used.',
      attempts: [
        attempt({
          runtime: 'codex-work',
          model: 'gpt-x',
          outcome: 'refused',
          probe: 'ran',
          probeMs: 1200,
          refusal: { code: 'probe_failed', message: 'no answer' },
        }),
        attempt({ runtime: 'claude-work', model: 'opus', probe: 'cached' }),
        attempt({ runtime: 'claude-work', probe: 'ran' }),
        attempt({ runtime: 'claude-work', outcome: 'refused' }),
      ],
    });

    // Act
    const text = renderPackNewOutcome(outcome, 'fy');

    // Assert
    should(text.split('\n')).eql([
      'Started child-1 on claude-work — decided by jev.',
      'Jev could not decide, so the guide order was used.',
      '  refused codex-work gpt-x (probe 1200ms) — probe_failed: no answer',
      '  started claude-work opus (probe cached)',
      '  started claude-work (probe 0ms)',
      '  refused claude-work — refused: ',
      'Wait for its result: fy wait child-1',
    ]);
  });

  it('should render a refusal with its remedy and the attempts that led to it', () => {
    // Arrange
    const outcome = refused({
      refusal: { code: 'no_candidate', message: 'nothing can run it', remedy: 'check the models guide' },
      attempts: [attempt({ outcome: 'refused', refusal: { code: 'cli_missing', message: 'not installed' } })],
    });

    // Act
    const text = renderPackNewOutcome(outcome, 'fy');

    // Assert
    should(text.split('\n')).eql([
      'refused (no_candidate): nothing can run it',
      'check the models guide',
      '',
      'Tried:',
      '  refused claude-work — cli_missing: not installed',
    ]);
  });

  it('should render a bare refusal with no remedy and no attempts', () => {
    // Arrange + Act
    const text = renderPackNewOutcome(refused(), 'fy');

    // Assert
    should(text).equal('refused (limit_reached): you have 4 running sub-ferrets');
  });
});
