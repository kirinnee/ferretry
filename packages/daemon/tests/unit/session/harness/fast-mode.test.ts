import { describe, it } from 'bun:test';
import type { RuntimeModelCatalog } from '@ferretry/protocol';
import should from 'should';
import {
  catalogChoice,
  claudeFastSupport,
  fastInForce,
  fastStartRefusal,
  fastModeFacts,
  modelInForce,
} from '../../../../src/lib/session/harness/fast-mode.ts';
import { claudeRuntimeCatalog } from '../../../../src/lib/session/harness/model-catalog.ts';
import { account, CLAUDE_VIEW, CODEX_VIEW } from '../runtime-control/support.ts';

/** The shape of the facts, not the CLIs: which models, which default, which record wins. */

const catalog: RuntimeModelCatalog = {
  harness: 'codex',
  source: 'codex-app-server',
  choices: [
    { value: 'gpt-6-astra', label: 'GPT-6-Astra', reasoningEfforts: [], fast: true },
    { value: 'gpt-6-sol', label: 'GPT-6-Sol', reasoningEfforts: [], fast: true, fastDefault: true },
    { value: 'gpt-daybreak', label: 'Daybreak Blue', reasoningEfforts: [], fast: false },
    { value: 'unsaid', label: 'Unsaid', reasoningEfforts: [] },
    { value: 'claude-opus-5-5[1m]', label: 'Opus 5.5', reasoningEfforts: [], fast: true },
  ],
};

describe('which Claude models have fast mode', () => {
  it('should follow the 2.1.281 rule: opus-4-8 and opus-5 in the id, either case, and nothing else', () => {
    // Act / Assert
    should(
      ['claude-opus-5-5', 'claude-opus-5', 'CLAUDE-OPUS-5-5[1m]', 'claude-opus-4-8'].map(claudeFastSupport),
    ).deepEqual([true, true, true, true]);
    should(['claude-opus-4-6', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-6-sol'].map(claudeFastSupport)).deepEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('should be stated on every model of a Claude account catalog', () => {
    // Act
    const answer = claudeRuntimeCatalog(
      account({
        models: [
          { id: 'claude-opus-5-5', available: true },
          { id: 'claude-sonnet-5-5', available: true },
        ],
      }),
    );

    // Assert
    should(answer.choices.map(choice => [choice.value, choice.fast])).deepEqual([
      ['claude-opus-5-5', true],
      ['claude-sonnet-5-5', false],
    ]);
  });
});

describe('finding the model in force in a catalog', () => {
  it('should match a model the harness reports without the selector the catalog keeps, and the reverse', () => {
    // Act / Assert
    should(catalogChoice(catalog, 'claude-opus-5-5')?.label).equal('Opus 5.5');
    should(catalogChoice(catalog, 'claude-opus-5-5[1m]')?.label).equal('Opus 5.5');
    should(catalogChoice(catalog, 'nobody')).equal(undefined);
    should(catalogChoice(catalog, undefined)).equal(undefined);
  });

  it('should prefer the model the harness reported over the one the session was launched on', () => {
    // Act / Assert
    should(modelInForce(CLAUDE_VIEW({ observedModel: 'a' }))).equal('a');
    should(modelInForce(CLAUDE_VIEW())).equal(undefined);
  });
});

describe('whether fast mode is on right now', () => {
  const choice = (model: string) => catalogChoice(catalog, model);

  it('should prefer what the harness reported, then what the launch asked for', () => {
    // Act / Assert
    should(fastInForce(CODEX_VIEW({ observedFast: false }), choice('gpt-6-sol'))).equal(false);
    should(fastInForce(CODEX_VIEW({ observedFast: true }), choice('gpt-6-astra'))).equal(true);
  });

  it("should fall back to the model's own default, which is on only where the catalog says so", () => {
    // Act / Assert
    should(fastInForce(CODEX_VIEW(), choice('gpt-6-sol'))).equal(true);
    should(fastInForce(CODEX_VIEW(), choice('gpt-6-astra'))).equal(false);
    should(fastInForce(CODEX_VIEW(), choice('gpt-daybreak'))).equal(false);
  });

  it('should say nothing for a model the catalog does not know', () => {
    // Act / Assert
    should(fastInForce(CODEX_VIEW(), undefined)).equal(undefined);
  });
});

describe('the facts a fast switch is planned from', () => {
  it('should carry support, the label, and the current state', () => {
    // Act
    const facts = fastModeFacts(CODEX_VIEW({ observedModel: 'gpt-6-sol' }), catalog);

    // Assert
    should(facts).deepEqual({ supported: true, model: 'GPT-6-Sol', current: true });
  });

  it('should say nothing about support the catalog did not state, but still name the model', () => {
    // Act
    const facts = fastModeFacts(CODEX_VIEW({ observedModel: 'unsaid' }), catalog);

    // Assert
    should(facts).deepEqual({ model: 'Unsaid', current: false });
  });

  it('should name an unknown model by its id and leave support and state unknown', () => {
    // Act
    const facts = fastModeFacts(CODEX_VIEW({ observedModel: 'mystery' }), catalog);

    // Assert
    should(facts).deepEqual({ model: 'mystery' });
  });

  it('should say nothing at all when no model is known', () => {
    // Act
    const facts = fastModeFacts(CODEX_VIEW(), catalog);

    // Assert
    should(facts).deepEqual({});
  });
});

describe('refusing a start that asks for fast mode the model does not have', () => {
  const choices = catalog.choices;

  it('should refuse a Claude model by its name, and let an Opus through', () => {
    // Act / Assert
    should(fastStartRefusal('claude', 'claude-sonnet-5-5', [])).equal('claude-sonnet-5-5 has no fast mode');
    should(fastStartRefusal('claude', 'claude-opus-5-5', [])).equal(undefined);
  });

  it('should refuse a Codex model only when the catalog says it has no fast tier', () => {
    // Act / Assert
    should(fastStartRefusal('codex', 'gpt-daybreak', choices)).equal('Daybreak Blue has no fast mode');
    should(fastStartRefusal('codex', 'gpt-6-sol', choices)).equal(undefined);
    should(fastStartRefusal('codex', 'unsaid', choices)).equal(undefined);
    should(fastStartRefusal('codex', 'not-listed', choices)).equal(undefined);
    should(fastStartRefusal('codex', 'gpt-daybreak', [])).equal(undefined);
  });
});

describe('reading what the launch decided', () => {
  it('should prefer the launch state when the harness has reported nothing', () => {
    // Act / Assert
    should(fastInForce(CODEX_VIEW({}), catalogChoice(catalog, 'gpt-6-sol'))).equal(true);
    should(
      fastInForce(
        { ...CLAUDE_VIEW(), config: { ...CLAUDE_VIEW().config, launchFast: true } },
        catalogChoice(catalog, 'claude-opus-5-5'),
      ),
    ).equal(true);
    should(
      fastInForce(
        { ...CODEX_VIEW(), config: { ...CODEX_VIEW().config, launchFast: false } },
        catalogChoice(catalog, 'gpt-6-sol'),
      ),
    ).equal(false);
  });
});
