import { describe, it } from 'bun:test';
import { RuntimeModelCatalogSchema } from '@ferretry/protocol';
import should from 'should';
import type { CoreAccount } from '../../../../src/lib/core/inventory.ts';
import {
  claudeRuntimeCatalog,
  codexRuntimeCatalog,
  codexSwitchContext,
} from '../../../../src/lib/session/harness/model-catalog.ts';

/**
 * The catalog a live switch may choose from.
 *
 * Every expectation here is about WHERE the answer came from rather than what it contains: the
 * defect this replaces was a second declaration of an account's models — a table of wrapper-name
 * regexes — that could and did contradict the manifest the fleet actually published.
 */

const account = (overrides: Partial<CoreAccount> = {}): CoreAccount => ({
  id: 'acct-1',
  kind: 'claude',
  mode: 'auto',
  wrapper: '/fleet/bin/claude-auto-loge',
  home: '/fleet/homes/loge',
  displayName: 'Loge',
  defaultModel: 'claude-opus-5',
  models: [
    { id: 'claude-opus-5', displayName: 'Opus 5', available: true },
    { id: 'claude-sonnet-5', available: true },
  ],
  available: true,
  unavailableReason: null,
  agent: 'claude-auto-loge',
  ...overrides,
});

describe('the runtime model catalog', () => {
  it('should offer a Claude account exactly what the manifest says it serves', async () => {
    // Arrange
    const subject = account();

    // Act
    const catalog = RuntimeModelCatalogSchema.parse(claudeRuntimeCatalog(subject));

    // Assert
    should(catalog.harness).equal('claude');
    should(catalog.source).equal('wrapper-inventory');
    should(catalog.choices.map(choice => choice.value)).deepEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('should fall back to the model id when the manifest names no display name', async () => {
    // A nameless row must still be selectable: the label is what a person reads, and an empty one
    // would render a button with nothing on it.
    // Act
    const catalog = claudeRuntimeCatalog(account());

    // Assert
    should(catalog.choices[0]?.label).equal('Opus 5');
    should(catalog.choices[1]?.label).equal('claude-sonnet-5');
  });

  it('should mark only the account default as default', async () => {
    // Act
    const catalog = claudeRuntimeCatalog(account());

    // Assert
    should(catalog.choices[0]?.isDefault).equal(true);
    should(catalog.choices[1]?.isDefault).equal(undefined);
  });

  it('should advertise no reasoning levels for a Claude choice', async () => {
    // Claude sets effort with a command that takes any level whatever the model is, so a level is
    // not a property OF a model. Publishing them per choice would state a dependency that does not
    // exist — and the browser reads an empty list as "use the harness-wide levels".
    // Act
    const catalog = claudeRuntimeCatalog(account());

    // Assert
    should(catalog.choices.every(choice => choice.reasoningEfforts.length === 0)).equal(true);
  });

  it('should hide a model the manifest declared unavailable', async () => {
    // Arrange
    const subject = account({
      models: [
        { id: 'claude-opus-5', available: true },
        { id: 'claude-haiku-4-5', available: false, unavailableReason: 'retired' },
      ],
    });

    // Act
    const catalog = claudeRuntimeCatalog(subject);

    // Assert
    should(catalog.choices.map(choice => choice.value)).deepEqual(['claude-opus-5']);
  });

  it('should offer nothing at all from an unavailable account', async () => {
    // An account that cannot serve a session cannot serve a switch into one either.
    // Arrange
    const subject = account({ available: false, unavailableReason: 'no credentials' });

    // Act
    const catalog = claudeRuntimeCatalog(subject);

    // Assert
    should(catalog.choices).deepEqual([]);
  });

  it('should restate the advertised Codex choices as the app-server catalog', async () => {
    // Act
    const catalog = RuntimeModelCatalogSchema.parse(
      codexRuntimeCatalog([{ value: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', reasoningEfforts: [{ value: 'high' }] }]),
    );

    // Assert
    should(catalog.harness).equal('codex');
    should(catalog.source).equal('codex-app-server');
    should(catalog.choices).have.length(1);
  });

  it('should narrow a catalog to the values a targeted switch is planned against', async () => {
    // The plan needs the model values, their levels and each model's own default; nothing else about
    // a choice can change which keystrokes reach a target.
    // Arrange
    const catalog = codexRuntimeCatalog([
      {
        value: 'gpt-5.6-codex',
        label: 'GPT-5.6 Codex',
        description: 'not part of the decision',
        reasoningEfforts: [{ value: 'medium' }, { value: 'high', description: 'also not' }],
        defaultReasoningEffort: 'medium',
      },
      { value: 'gpt-5.6-terra', label: 'Terra', reasoningEfforts: [] },
    ]);

    // Act
    const context = codexSwitchContext(catalog);

    // Assert
    should(context).deepEqual({
      choices: [
        {
          value: 'gpt-5.6-codex',
          reasoningEfforts: [{ value: 'medium' }, { value: 'high' }],
          defaultReasoningEffort: 'medium',
        },
        { value: 'gpt-5.6-terra', reasoningEfforts: [] },
      ],
    });
  });
});
