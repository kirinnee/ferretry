import { describe, it } from 'bun:test';
import should from 'should';
import { renderInventory, renderSuggestion } from '../../../src/lib/pack/guide-render.ts';
import { INVENTORY, JOB, SUGGESTION } from './fixtures.ts';

describe('renderSuggestion', () => {
  it('should show who drafted it, the routing before and after, each use case as a diff, the notes and how to accept', () => {
    // Act
    const text = renderSuggestion(JOB, SUGGESTION, 'fy');

    // Assert
    should(text.split('\n')).deepEqual([
      'Suggested by claude-opus-5-5 on claude-work (2026-10-22 12:05Z), against your guide.',
      '',
      'Routing guidance:',
      '  - Plan and review on Opus; take Astra when Opus is low.',
      '  + Plan on Opus.',
      '  + Bulk on GLM.',
      '  short line: Routing: plan-review → opus max.',
      '',
      'Use cases:',
      '  ~ changed plan-review — Planning and review',
      '      title: "Hard planning and review" → "Planning and review"',
      '      1. anthropic/claude-opus-5-5 @max — The strongest planner.',
      '      2. openai/gpt-6-astra (codex) — A second family.',
      '  + added   bulk — Bulk edits',
      '      1. zai/glm-5 — Cheap: claude-work is at 46% of the week.',
      '',
      'Dropped (1):',
      '  - bulk: x ghost is not in any catalog',
      '',
      'Changed by the check (1):',
      '  - its routing guidance did not check, so it was rendered from the use cases',
      '',
      'Accept it all: fy guide accept run-1',
      'Accept some:   fy guide accept run-1 --only <id,id> [--keep-routing]',
    ]);
  });

  it('should say when the routing is unchanged or new, and show a removed and an unchanged use case on one line', () => {
    // Arrange
    const current = SUGGESTION.current;
    const same = {
      ...SUGGESTION,
      routing: { prompt: current.routing?.prompt ?? '', short: current.routing?.short ?? '' },
      useCases: [],
      dropped: [],
      flagged: [],
    };
    const fresh = {
      ...SUGGESTION,
      useCases: current.useCases,
      current: { source: 'derived' as const, useCases: current.useCases },
    };

    // Act
    const unchanged = renderSuggestion(JOB, same, 'fy').split('\n');
    const first = renderSuggestion(JOB, fresh, 'fy').split('\n');

    // Assert
    should(unchanged).containEql('Routing guidance: unchanged.');
    should(unchanged).containEql('  - removed plan-review — Hard planning and review');
    should(unchanged).not.containEql('Dropped (0):');
    should(first[0]).endWith('against the built-in guide.');
    should(first).containEql('  (none before)');
    should(first).containEql('  = same    plan-review — Hard planning and review');
  });
});

describe('renderInventory', () => {
  it('should list each runtime with its readiness and quota, each model with whose words and its headroom, then the preferences', () => {
    // Act
    const text = renderInventory(INVENTORY);

    // Assert
    should(text.split('\n')).deepEqual([
      'Runtimes (2):',
      '  ready   claude-work (claude, anthropic) · quota 5h 2% · wk 46%',
      '  cannot  codex-off (codex) · quota not measured — codex-off needs signing in.',
      '',
      'Models (2):',
      '  anthropic/claude-opus-5-5 — Claude Opus 5.5, best, retires 2027-06-01',
      '      yours: Strongest; slow.',
      '      1 runtime, 1 ready; most headroom on claude-work: 5h 2% · wk 46%',
      '  openai/gpt-6-astra (codex) — GPT-6 Astra, best',
      '      catalog: GPT-6 Astra: the strongest tier on OpenAI.',
      '      no runtime here runs it',
      '',
      'Your routing preferences:',
      '  Opus for reviews.',
      '  GLM for bulk.',
    ]);
  });

  it('should leave out preferences nobody wrote', () => {
    // Arrange
    const { preferences: _preferences, ...bare } = INVENTORY;

    // Act + Assert
    should(renderInventory(bare)).not.containEql('preferences');
  });
});
