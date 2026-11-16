import { describe, it } from 'bun:test';
import should from 'should';
import {
  CODEX_QUIRKS,
  planRuntimeSwitch,
  type CodexModelCatalog,
  type HarnessRuntimeSwitchContext,
} from '../../daemon/lib/index.ts';

const catalog: CodexModelCatalog = {
  choices: [
    // Reaches the Advanced Reasoning submenu, so the quick row cannot apply a preset.
    {
      value: 'gpt-5-codex',
      reasoningEfforts: [{ value: 'medium' }, { value: 'high' }, { value: 'max' }],
      defaultReasoningEffort: 'medium',
    },
    // A quick-picker-only model: choosing its row applies `low` directly.
    {
      value: 'gpt-5-mini',
      reasoningEfforts: [{ value: 'low' }, { value: 'high' }],
      defaultReasoningEffort: 'low',
    },
    // The account advertises no default at all.
    { value: 'gpt-5-terra', reasoningEfforts: [{ value: 'low' }, { value: 'high' }] },
  ],
};

const codexContext: HarnessRuntimeSwitchContext = { catalog };

describe('CODEX_QUIRKS', () => {
  it('should declare that Codex needs its picker driven, takes no effort command and mints its own ids', () => {
    // Arrange / Act / Assert
    should(CODEX_QUIRKS).eql({
      effortIsRuntimeCommand: false,
      modelSwitchNeedsPicker: true,
      reportsTokenCounter: false,
      fastIsToggle: true,
      mintsOwnSessionIds: true,
      supportsRemoteControl: false,
    });
  });
});

describe('planRuntimeSwitch on a picker harness', () => {
  it('should open the bare picker and claim nothing when the human will choose', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({}, codexContext);

    // Assert: no success claim — the daemon did not make the selection.
    should(plan).eql({ kind: 'inject', command: '/model', claimsOutcome: false });
  });

  it('should refuse an effort on its own and say where effort actually lives', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ effort: 'high' }, codexContext);

    // Assert
    should(plan).eql({
      kind: 'refused',
      reason: 'this harness sets reasoning effort only inside its own picker; request a model and an effort together',
    });
  });

  it.each([
    { name: 'only a model', request: { model: 'gpt-5-codex' } },
    { name: 'a blank effort alongside a model', request: { model: 'gpt-5-codex', effort: '  ' } },
  ])('should refuse a targeted switch given $name', ({ request }) => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ ...request }, codexContext);

    // Assert
    should(plan).eql({
      kind: 'refused',
      reason: 'a targeted switch on this harness requires both a model and a reasoning effort',
    });
  });

  it('should leave the target unmarked when the model opens the reasoning menu', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ model: 'gpt-5-codex', effort: 'high' }, codexContext);

    // Assert: an advanced effort exists, so the quick row cannot silently apply a preset. The driver
    // still reads the real screen — it always does — but it has nothing to refuse this target on.
    should(plan).eql({ kind: 'drive_picker', target: { model: 'gpt-5-codex', effort: 'high' } });
  });

  it('should mark the target when the quick row would apply a different preset effort', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ model: 'gpt-5-mini', effort: 'high' }, codexContext);

    // Assert
    should(plan).eql({
      kind: 'drive_picker',
      target: {
        model: 'gpt-5-mini',
        effort: 'high',
        quickPickerDefaultEffort: 'low',
        // The FLAG is what the driver refuses on; the name above only makes the refusal readable.
        quickPickerAppliesPreset: true,
      },
    });
  });

  it('should leave the target unmarked when the quick row already applies the requested effort', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ model: 'gpt-5-mini', effort: 'low' }, codexContext);

    // Assert
    should(plan).eql({ kind: 'drive_picker', target: { model: 'gpt-5-mini', effort: 'low' } });
  });

  it('should mark the target when the account advertises no default effort at all', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ model: 'gpt-5-terra', effort: 'high' }, codexContext);

    // Assert: an unknown default is not a match. The source compared it as one and
    // selected a quick row that could apply an effort nobody asked for.
    //
    // The flag travels WITHOUT a name beside it, and that pairing is the whole point: this is the
    // case with no preset to name, and a driver that decided from the name alone read it as "no
    // mismatch" and selected the row anyway.
    should(plan).eql({
      kind: 'drive_picker',
      target: { model: 'gpt-5-terra', effort: 'high', quickPickerAppliesPreset: true },
    });
  });

  it('should refuse a model the live catalog does not advertise', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ model: 'gpt-9', effort: 'high' }, codexContext);

    // Assert
    should(plan).eql({ kind: 'refused', reason: "model gpt-9 is not in this Codex account's current catalog" });
  });

  it('should refuse an effort the model does not advertise', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ model: 'gpt-5-mini', effort: 'max' }, codexContext);

    // Assert
    should(plan).eql({ kind: 'refused', reason: 'max is not advertised for Codex model gpt-5-mini' });
  });

  it('should refuse before the catalog has been read', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ model: 'gpt-5-codex', effort: 'high' }, {});

    // Assert
    should(plan).eql({
      kind: 'refused',
      reason: 'the live Codex model catalog must be read before a targeted switch',
    });
  });

  it('should treat a model whose only advertised default is advanced as opening the menu', () => {
    // Arrange: no advanced effort in the list, but the default itself is one.
    const context: HarnessRuntimeSwitchContext = {
      catalog: {
        choices: [{ value: 'gpt-5-pro', reasoningEfforts: [{ value: 'high' }], defaultReasoningEffort: 'ultra' }],
      },
    };

    // Act
    const plan = planRuntimeSwitch({ model: 'gpt-5-pro', effort: 'high' }, context);

    // Assert
    should(plan).eql({ kind: 'drive_picker', target: { model: 'gpt-5-pro', effort: 'high' } });
  });
});

describe('planRuntimeSwitch for fast mode', () => {
  it('should flip with a bare command on a harness whose command only flips, and only when it must', () => {
    // Codex types `/fast on` into the conversation as a message, so the only safe keystrokes are the bare command.
    // Arrange / Act
    const turnOn = planRuntimeSwitch({ fast: true }, { ...codexContext, fast: { supported: true, current: false } });
    const turnOff = planRuntimeSwitch({ fast: false }, { ...codexContext, fast: { supported: true, current: true } });

    // Assert
    should(turnOn).eql({ kind: 'inject', command: '/fast', requestedFast: true, claimsOutcome: true });
    should(turnOff).eql({ kind: 'inject', command: '/fast', requestedFast: false, claimsOutcome: true });
  });

  it('should type nothing when a flip would undo the state already asked for', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ fast: true }, { ...codexContext, fast: { supported: true, current: true } });

    // Assert
    should(plan).eql({ kind: 'unchanged' });
  });

  it('should refuse a flip it cannot place, rather than guess the direction', () => {
    // Arrange / Act
    const unknown = planRuntimeSwitch({ fast: true }, { ...codexContext, fast: { supported: true } });
    const none = planRuntimeSwitch({ fast: true }, codexContext);

    // Assert
    should(unknown).match({ kind: 'refused', reason: /not known yet/u });
    should(none).match({ kind: 'refused', reason: /not known yet/u });
  });

  it('should refuse a model that has no fast mode', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ fast: false }, { ...codexContext, fast: { supported: false, current: true } });

    // Assert
    should(plan).eql({ kind: 'refused', reason: 'this model has no fast mode' });
  });

  it('should refuse fast mode combined with a model or an effort', () => {
    // Arrange / Act
    const withModel = planRuntimeSwitch({ fast: true, model: 'gpt-5-codex' }, codexContext);
    const withEffort = planRuntimeSwitch({ fast: true, effort: 'high' }, codexContext);

    // Assert
    should(withModel).match({ kind: 'refused', reason: /on its own/u });
    should(withEffort).match({ kind: 'refused', reason: /on its own/u });
  });
});

describe('a Codex switch on a login catalog (docs/model-catalog.md)', () => {
  const catalogued: HarnessRuntimeSwitchContext = {
    catalog: {
      choices: [
        {
          value: 'deepseek-v4-pro',
          label: 'DeepSeek V4 Pro',
          reasoningEfforts: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
          defaultReasoningEffort: 'high',
        },
        { value: 'kimi-k3', label: 'Kimi K3', reasoningEfforts: [] },
        { value: 'same-name', label: 'same-name', reasoningEfforts: [{ value: 'low' }], defaultReasoningEffort: 'low' },
      ],
    },
  };

  it('should name the row Codex renders when its display name is not the id', () => {
    // Act
    const plan = planRuntimeSwitch({ model: 'deepseek-v4-pro', effort: 'max' }, catalogued);

    // Assert
    should(plan).eql({
      kind: 'drive_picker',
      target: { model: 'deepseek-v4-pro', rowName: 'DeepSeek V4 Pro', effort: 'max' },
    });
  });

  it('should name no row when the display name is the id', () => {
    // Act
    const plan = planRuntimeSwitch({ model: 'same-name', effort: 'low' }, catalogued);

    // Assert
    should(plan).eql({ kind: 'drive_picker', target: { model: 'same-name', effort: 'low' } });
  });

  it('should switch to a model that has no level to choose without naming one', () => {
    // Act
    const plan = planRuntimeSwitch({ model: 'kimi-k3' }, catalogued);

    // Assert
    should(plan).eql({ kind: 'drive_picker', target: { model: 'kimi-k3', rowName: 'Kimi K3' } });
  });

  it('should still ask for a level when the model has levels to choose from', () => {
    // Act
    const plan = planRuntimeSwitch({ model: 'deepseek-v4-pro' }, catalogued);

    // Assert
    should(plan).eql({
      kind: 'refused',
      reason: 'a targeted switch on this harness requires both a model and a reasoning effort',
    });
  });
});
