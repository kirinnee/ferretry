import { describe, it } from 'bun:test';
import should from 'should';
import {
  catalogChoice,
  fastInForce,
  fastStartRefusal,
  fastModeFacts,
  modelInForce,
} from '../../daemon/lib/fast-mode.ts';
import type { RuntimeModelCatalog } from '../../daemon/lib/models.ts';

/** The shape of the facts, not the CLI: which models, which default, which record wins. */

/** A session's records as the planner reads them: what the harness reported and what the launch asked for. */
const VIEW = (
  state: { observedModel?: string; observedFast?: boolean; launchModel?: string; launchFast?: boolean } = {},
) => state;

const catalog: RuntimeModelCatalog = {
  harness: 'codex',
  source: 'codex-app-server',
  choices: [
    { value: 'gpt-6-astra', label: 'GPT-6-Astra', reasoningEfforts: [], fast: true },
    { value: 'gpt-6-sol', label: 'GPT-6-Sol', reasoningEfforts: [], fast: true, fastDefault: true },
    { value: 'gpt-daybreak', label: 'Daybreak Blue', reasoningEfforts: [], fast: false },
    { value: 'unsaid', label: 'Unsaid', reasoningEfforts: [] },
    { value: 'gpt-6-luna[1m]', label: 'Luna', reasoningEfforts: [], fast: true },
  ],
};

describe('finding the model in force in a catalog', () => {
  it('should match a model the harness reports without the selector the catalog keeps, and the reverse', () => {
    // Act / Assert
    should(catalogChoice(catalog, 'gpt-6-luna')?.label).equal('Luna');
    should(catalogChoice(catalog, 'gpt-6-luna[1m]')?.label).equal('Luna');
    should(catalogChoice(catalog, 'nobody')).equal(undefined);
    should(catalogChoice(catalog, undefined)).equal(undefined);
  });

  it('should prefer the model the harness reported over the one the session was launched on', () => {
    // Act / Assert
    should(modelInForce(VIEW({ observedModel: 'a', launchModel: 'b' }))).equal('a');
    should(modelInForce(VIEW({ launchModel: 'b' }))).equal('b');
    should(modelInForce(VIEW())).equal(undefined);
  });
});

describe('whether fast mode is on right now', () => {
  const choice = (model: string) => catalogChoice(catalog, model);

  it('should prefer what the harness reported, then what the launch asked for', () => {
    // Act / Assert
    should(fastInForce(VIEW({ observedFast: false }), choice('gpt-6-sol'))).equal(false);
    should(fastInForce(VIEW({ observedFast: true }), choice('gpt-6-astra'))).equal(true);
  });

  it("should fall back to the model's own default, which is on only where the catalog says so", () => {
    // Act / Assert
    should(fastInForce(VIEW(), choice('gpt-6-sol'))).equal(true);
    should(fastInForce(VIEW(), choice('gpt-6-astra'))).equal(false);
    should(fastInForce(VIEW(), choice('gpt-daybreak'))).equal(false);
  });

  it('should say nothing for a model the catalog does not know', () => {
    // Act / Assert
    should(fastInForce(VIEW(), undefined)).equal(undefined);
  });
});

describe('the facts a fast switch is planned from', () => {
  it('should carry support, the label, and the current state', () => {
    // Act
    const facts = fastModeFacts(VIEW({ observedModel: 'gpt-6-sol' }), catalog);

    // Assert
    should(facts).deepEqual({ supported: true, model: 'GPT-6-Sol', current: true });
  });

  it('should say nothing about support the catalog did not state, but still name the model', () => {
    // Act
    const facts = fastModeFacts(VIEW({ observedModel: 'unsaid' }), catalog);

    // Assert
    should(facts).deepEqual({ model: 'Unsaid', current: false });
  });

  it('should name an unknown model by its id and leave support and state unknown', () => {
    // Act
    const facts = fastModeFacts(VIEW({ observedModel: 'mystery' }), catalog);

    // Assert
    should(facts).deepEqual({ model: 'mystery' });
  });

  it('should say nothing at all when no model is known', () => {
    // Act
    const facts = fastModeFacts(VIEW(), catalog);

    // Assert
    should(facts).deepEqual({});
  });
});

describe('refusing a start that asks for fast mode the model does not have', () => {
  const choices = catalog.choices;

  it('should refuse a Codex model only when the catalog says it has no fast tier', () => {
    // Act / Assert
    should(fastStartRefusal('gpt-daybreak', choices)).equal('Daybreak Blue has no fast mode');
    should(fastStartRefusal('gpt-6-sol', choices)).equal(undefined);
    should(fastStartRefusal('unsaid', choices)).equal(undefined);
    should(fastStartRefusal('not-listed', choices)).equal(undefined);
    should(fastStartRefusal('gpt-daybreak', [])).equal(undefined);
  });
});

describe('reading what the launch decided', () => {
  it('should prefer the launch state when the harness has reported nothing', () => {
    // Act / Assert
    should(fastInForce(VIEW({}), catalogChoice(catalog, 'gpt-6-sol'))).equal(true);
    should(fastInForce(VIEW({ launchFast: false }), catalogChoice(catalog, 'gpt-6-sol'))).equal(false);
    should(fastInForce(VIEW({ launchFast: true }), catalogChoice(catalog, 'gpt-daybreak'))).equal(true);
  });
});
