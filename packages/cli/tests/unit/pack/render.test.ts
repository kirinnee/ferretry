import { describe, it } from 'bun:test';
import should from 'should';
import {
  guideWords,
  renderGuide,
  renderPackNewOutcome,
  renderPackRecommendation,
} from '../../../src/lib/pack/render.ts';
import { attempt, packView, recommendation, refused, started, startedView } from './fixtures.ts';

const SUGGESTED = {
  by: 'gpt-oss-120b',
  via: 'claude-work',
  at: '2026-10-21T09:00:00.000Z',
  acceptedAt: '2026-10-22T10:00:00.000Z',
};

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
    should(fallback).startWith(
      'Use case: Everyday (daily, no use case matched, so the everyday one; the built-in guide)',
    );
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

  it('should say the guide was suggested and accepted, show quota, why a candidate moved down, and the routing guidance', () => {
    // Arrange
    const text = renderPackRecommendation(
      recommendation({
        guideSource: 'file',
        guideSuggested: SUGGESTED,
        routing: 'Bulk work on Haiku.\nTake the next when one refuses.',
        candidates: [
          {
            rank: 1,
            provider: 'anthropic',
            model: 'claude-haiku-4-5',
            why: 'cheap and quick',
            runtime: 'claude-atomi',
            ready: true,
            quota: { state: 'plenty', windows: [], leftPercent: 98, summary: '5h 2% · wk 46%' },
          },
          {
            rank: 2,
            provider: 'anthropic',
            model: 'claude-haiku-4-5',
            why: 'cheap and quick',
            runtime: 'claude-kirin',
            ready: true,
            quota: { state: 'low', windows: [], leftPercent: 9, summary: '5h 10% · wk 91%' },
            movedDown: 'claude-kirin, 91% of the week used',
          },
          {
            rank: 3,
            provider: 'anthropic',
            model: 'claude-haiku-4-5',
            why: 'cheap and quick',
            runtime: 'claude-other',
            ready: true,
            quota: { state: 'unknown', windows: [], summary: 'not measured' },
          },
        ],
      }),
    );

    // Assert
    should(text.split('\n')).eql([
      "Use case: Bulk edits (bulk, from the task's words; your guide, suggested by gpt-oss-120b on 2026-10-22 and accepted)",
      '',
      '1. ready   claude-haiku-4-5 on claude-atomi · quota 5h 2% · wk 46%',
      '   cheap and quick',
      '2. ready   claude-haiku-4-5 on claude-kirin · quota 5h 10% · wk 91%',
      '   cheap and quick',
      '   moved down: claude-kirin, 91% of the week used',
      '3. ready   claude-haiku-4-5 on claude-other',
      '   cheap and quick',
      '',
      'How to choose (the routing guidance):',
      'Bulk work on Haiku.',
      'Take the next when one refuses.',
      '',
      'Start the first: fy new --runtime claude-work --model claude-haiku-4-5 "<brief>"',
    ]);
  });

  it('should word a partly accepted suggestion and both guides with none', () => {
    // Assert
    should(guideWords('file', { ...SUGGESTED, partial: true })).equal(
      'your guide, suggested by gpt-oss-120b on 2026-10-22 and partly accepted',
    );
    should(guideWords('file', undefined)).equal('your models guide');
    should(guideWords('derived', undefined)).equal('the built-in guide');
  });

  it('should print an empty candidate list as nothing runnable', () => {
    // Arrange + Act
    const text = renderPackRecommendation(recommendation({ candidates: [], next: undefined }));

    // Assert
    should(text.split('\n').slice(2)).eql(['', 'Nothing can run it here now.']);
  });
});

describe('renderGuide', () => {
  it('should print where the guide came from, its routing guidance and short line, then each use case', () => {
    // Arrange + Act
    const text = renderGuide(packView({ suggested: SUGGESTED }));

    // Assert
    should(text.split('\n')).eql([
      'Models guide: your guide, suggested by gpt-oss-120b on 2026-10-22 and accepted',
      '',
      'Routing guidance (written in models-guide.yaml):',
      'Plan and review on Opus; take Astra when Opus is low.',
      '',
      "In every Pack ferret's system prompt: Routing: plan-review → claude-opus-5-5 max.",
      '',
      'Use cases (1):',
      '- Hard planning and review (plan-review)',
      '  1. anthropic/claude-opus-5-5 · effort max — The strongest planner.',
      '  2. openai/gpt-6-astra (codex) — A second family.',
    ]);
  });

  it('should say a rendered routing prompt was rendered, and print a guide with no routing at all', () => {
    // Arrange
    const derived = packView({ source: 'derived' });
    const rendered = renderGuide({
      ...derived,
      guide: { ...derived.guide, routing: { prompt: 'Rendered.', short: 'Routing: x.', source: 'derived' } },
    });
    const { routing: _routing, ...bare } = derived.guide;

    // Act
    const none = renderGuide({ ...derived, guide: bare });

    // Assert
    should(rendered).containEql('Routing guidance (rendered from the use cases):');
    should(none.split('\n').slice(0, 3)).eql(['Models guide: the built-in guide', '', 'Use cases (1):']);
  });
});

describe('renderPackNewOutcome', () => {
  it('should time a probe that passed and one that failed, and name a failed probe another start shared', () => {
    // Arrange
    const outcome = refused({
      refusal: { code: 'out_of_quota', message: 'quota' },
      attempts: [
        attempt({
          runtime: 'a',
          outcome: 'refused',
          probe: 'cached',
          probeMs: 10,
          refusal: { code: 'out_of_quota', message: 'q' },
        }),
      ],
    });

    // Act
    const passed = renderPackNewOutcome(started({ attempts: [attempt({ probe: 'ran', probeMs: 640 })] }), 'fy');

    // Assert
    should(passed).containEql('  started claude-work (probe OK 640 ms)');
    should(renderPackNewOutcome(outcome, 'fy')).containEql('  refused a (probe failed, shared) — out_of_quota: q');
  });

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
      '  refused codex-work gpt-x (probe failed 1200 ms) — probe_failed: no answer',
      '  started claude-work opus (probe OK, cached)',
      '  started claude-work (probe OK)',
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
