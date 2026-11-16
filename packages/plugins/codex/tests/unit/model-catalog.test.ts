import { describe, it } from 'bun:test';
import should from 'should';
import { codexRuntimeCatalog, codexSwitchContext } from '../../daemon/lib/models.ts';

/**
 * The catalog a live switch may choose from.
 *
 * Every expectation here is about WHERE the answer came from rather than what it contains: the defect this replaces
 * was a second declaration of an account's models that could and did contradict what the account really serves. For
 * Codex the app-server's list is the only one its own picker can switch to.
 */

describe('the runtime model catalog', () => {
  it('should restate the advertised Codex choices as the app-server catalog', async () => {
    // Act
    const catalog = codexRuntimeCatalog([
      { value: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', reasoningEfforts: [{ value: 'high' }] },
    ]);

    // Assert
    should(catalog.harness).equal('codex');
    should(catalog.source).equal('codex-app-server');
    should(catalog.choices).have.length(1);
  });

  it('should narrow the advertised choices to the values and row names a targeted switch is planned against', async () => {
    // The plan needs the model values, the names Codex renders them under, their levels and each
    // model's own default; nothing else about a choice can change which keystrokes reach a target.
    // Act
    const context = codexSwitchContext([
      {
        value: 'gpt-5.6-codex',
        label: 'GPT-5.6-Codex',
        description: 'not part of the decision',
        reasoningEfforts: [{ value: 'medium' }, { value: 'high', description: 'also not' }],
        defaultReasoningEffort: 'medium',
      },
      { value: 'gpt-5.6-terra', label: 'Terra', reasoningEfforts: [] },
    ]);

    // Assert
    should(context).deepEqual({
      choices: [
        {
          value: 'gpt-5.6-codex',
          label: 'GPT-5.6-Codex',
          reasoningEfforts: [{ value: 'medium' }, { value: 'high' }],
          defaultReasoningEffort: 'medium',
        },
        { value: 'gpt-5.6-terra', label: 'Terra', reasoningEfforts: [] },
      ],
    });
  });

  it('should mark the model the runtime launches with as the default, not the first Codex listed', () => {
    // Arrange — a catalog's models come back in its order, and Codex flags the first as its default
    const advertised = [
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', isDefault: true as const, reasoningEfforts: [] },
      { value: 'deepseek-flash', label: 'DeepSeek Flash', reasoningEfforts: [] },
    ];

    // Act
    const marked = codexRuntimeCatalog(advertised, { models: [], defaultModel: 'deepseek-flash' });
    const unknown = codexRuntimeCatalog(advertised, { models: [], defaultModel: 'gpt-6' });
    const none = codexRuntimeCatalog(advertised, { models: [], defaultModel: null });

    // Assert
    should(marked.choices.map(choice => choice.isDefault)).eql([undefined, true]);
    should(unknown.choices.map(choice => choice.isDefault)).eql([true, undefined]);
    should(none.choices.map(choice => choice.isDefault)).eql([true, undefined]);
  });
});

describe('the runtime model catalog from a login catalog (docs/model-catalog.md)', () => {
  it('should give an advertised Codex choice the tier and name its catalog describes', () => {
    // Arrange
    const codex = {
      models: [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', tier: 'balanced' as const, available: true as const }],
      modelCatalog: { id: 'openai', label: 'OpenAI', customIds: false },
    };

    // Act
    const catalog = codexRuntimeCatalog(
      [
        { value: 'gpt-6.1-sol', label: 'gpt-6.1-sol', reasoningEfforts: [{ value: 'medium' }] },
        { value: 'gpt-unknown', label: 'Unknown', reasoningEfforts: [] },
      ],
      codex,
    );

    // Assert
    should(catalog.choices[0]).match({
      label: 'GPT-6.1 Sol',
      tier: 'balanced',
      reasoningEfforts: [{ value: 'medium' }],
    });
    should(catalog.choices[1]).deepEqual({ value: 'gpt-unknown', label: 'Unknown', reasoningEfforts: [] });
    should(catalog.catalog?.id).equal('openai');
    should(codexRuntimeCatalog([], { models: [] }).catalog).be.undefined();
  });
});
