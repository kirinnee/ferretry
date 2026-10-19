import { describe, it } from 'bun:test';
import should from 'should';
import {
  harnessQuirks,
  planRuntimeSwitch,
  RUNTIME_EFFORT_LEVELS,
  type CodexModelCatalog,
  type HarnessRuntimeSwitchContext,
} from '../../../../src/lib/session/harness/index.ts';

const claudeContext: HarnessRuntimeSwitchContext = {
  wrapper: 'claude-auto-loge',
  allowedModels: ['claude-opus-5', 'claude-sonnet-5'],
};

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

const codexContext: HarnessRuntimeSwitchContext = { wrapper: 'codex-auto-sol', catalog };

describe('harnessQuirks', () => {
  it('should declare that only Claude takes effort as a runtime command', () => {
    // Arrange / Act / Assert
    should(harnessQuirks('claude').effortIsRuntimeCommand).eql(true);
    should(harnessQuirks('codex').effortIsRuntimeCommand).eql(false);
  });

  it('should declare that only Codex needs its picker driven and mints its own ids', () => {
    // Arrange / Act / Assert
    should(harnessQuirks('codex')).eql({
      effortIsRuntimeCommand: false,
      modelSwitchNeedsPicker: true,
      reportsTokenCounter: false,
      fastIsToggle: true,
      mintsOwnSessionIds: true,
      supportsRemoteControl: false,
    });
  });

  it('should declare Claude as the harness with a token counter and remote control', () => {
    // Arrange / Act / Assert
    should(harnessQuirks('claude')).eql({
      effortIsRuntimeCommand: true,
      modelSwitchNeedsPicker: false,
      reportsTokenCounter: true,
      fastIsToggle: false,
      mintsOwnSessionIds: false,
      supportsRemoteControl: true,
    });
  });
});

describe('planRuntimeSwitch on a command harness', () => {
  it('should inject a model command for an allowed model', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'claude', model: ' claude-opus-5 ' }, claudeContext);

    // Assert
    should(plan).eql({
      kind: 'inject',
      command: '/model claude-opus-5',
      requestedModel: 'claude-opus-5',
      claimsOutcome: true,
    });
  });

  it.each(RUNTIME_EFFORT_LEVELS.map(effort => ({ effort })))(
    'should inject an effort command for $effort',
    ({ effort }) => {
      // Arrange / Act
      const plan = planRuntimeSwitch({ harness: 'claude', effort }, claudeContext);

      // Assert
      should(plan).eql({ kind: 'inject', command: `/effort ${effort}`, requestedEffort: effort, claimsOutcome: true });
    },
  );

  it('should refuse an effort level the harness does not have', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'claude', effort: 'ludicrous' }, claudeContext);

    // Assert
    should(plan).eql({ kind: 'refused', reason: 'effort must be one of low, medium, high, xhigh, max' });
  });

  it('should refuse a model the wrapper does not serve', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'claude', model: 'gpt-5-codex' }, claudeContext);

    // Assert
    should(plan).eql({ kind: 'refused', reason: 'model gpt-5-codex is not available on wrapper claude-auto-loge' });
  });

  it.each([
    { name: 'an empty allow list', allowed: [] as readonly string[] },
    { name: 'no allow list at all', allowed: undefined },
  ])('should refuse switching entirely for $name', ({ allowed }) => {
    // Arrange
    const context: HarnessRuntimeSwitchContext = {
      wrapper: 'claude-auto-loge',
      ...(allowed === undefined ? {} : { allowedModels: allowed }),
    };

    // Act
    const plan = planRuntimeSwitch({ harness: 'claude', model: 'claude-opus-5' }, context);

    // Assert
    should(plan).eql({
      kind: 'refused',
      reason: 'in-session model switching is not supported for wrapper claude-auto-loge',
    });
  });

  it.each([
    { name: 'nothing requested', request: {} },
    { name: 'a whitespace-only model', request: { model: '   ' } },
  ])('should refuse $name', ({ request }) => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'claude', ...request }, claudeContext);

    // Assert
    should(plan).eql({ kind: 'refused', reason: 'a model is required for a runtime switch on this harness' });
  });
});

describe('planRuntimeSwitch on a picker harness', () => {
  it('should open the bare picker and claim nothing when the human will choose', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'codex' }, codexContext);

    // Assert: no success claim — the daemon did not make the selection.
    should(plan).eql({ kind: 'inject', command: '/model', claimsOutcome: false });
  });

  it('should refuse an effort on its own and say where effort actually lives', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'codex', effort: 'high' }, codexContext);

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
    const plan = planRuntimeSwitch({ harness: 'codex', ...request }, codexContext);

    // Assert
    should(plan).eql({
      kind: 'refused',
      reason: 'a targeted switch on this harness requires both a model and a reasoning effort',
    });
  });

  it('should leave the target unmarked when the model opens the reasoning menu', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'gpt-5-codex', effort: 'high' }, codexContext);

    // Assert: an advanced effort exists, so the quick row cannot silently apply a preset. The driver
    // still reads the real screen — it always does — but it has nothing to refuse this target on.
    should(plan).eql({ kind: 'drive_picker', target: { model: 'gpt-5-codex', effort: 'high' } });
  });

  it('should mark the target when the quick row would apply a different preset effort', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'gpt-5-mini', effort: 'high' }, codexContext);

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
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'gpt-5-mini', effort: 'low' }, codexContext);

    // Assert
    should(plan).eql({ kind: 'drive_picker', target: { model: 'gpt-5-mini', effort: 'low' } });
  });

  it('should mark the target when the account advertises no default effort at all', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'gpt-5-terra', effort: 'high' }, codexContext);

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
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'gpt-9', effort: 'high' }, codexContext);

    // Assert
    should(plan).eql({ kind: 'refused', reason: "model gpt-9 is not in this Codex account's current catalog" });
  });

  it('should refuse an effort the model does not advertise', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'gpt-5-mini', effort: 'max' }, codexContext);

    // Assert
    should(plan).eql({ kind: 'refused', reason: 'max is not advertised for Codex model gpt-5-mini' });
  });

  it('should refuse before the catalog has been read', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch(
      { harness: 'codex', model: 'gpt-5-codex', effort: 'high' },
      {
        wrapper: 'codex-auto-sol',
      },
    );

    // Assert
    should(plan).eql({
      kind: 'refused',
      reason: 'the live Codex model catalog must be read before a targeted switch',
    });
  });

  it('should treat a model whose only advertised default is advanced as opening the menu', () => {
    // Arrange: no advanced effort in the list, but the default itself is one.
    const context: HarnessRuntimeSwitchContext = {
      wrapper: 'codex-auto-sol',
      catalog: {
        choices: [{ value: 'gpt-5-pro', reasoningEfforts: [{ value: 'high' }], defaultReasoningEffort: 'ultra' }],
      },
    };

    // Act
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'gpt-5-pro', effort: 'high' }, context);

    // Assert
    should(plan).eql({ kind: 'drive_picker', target: { model: 'gpt-5-pro', effort: 'high' } });
  });
});

describe('planRuntimeSwitch with a custom model id (docs/model-catalog.md)', () => {
  const openCatalog: HarnessRuntimeSwitchContext = { ...claudeContext, acceptsCustomModels: true };

  it('should type an id beyond the list when the login takes any id, context suffix and all', () => {
    should(planRuntimeSwitch({ harness: 'claude', model: '~openai/gpt-sol-latest[1m]' }, openCatalog)).eql({
      kind: 'inject',
      command: '/model ~openai/gpt-sol-latest[1m]',
      requestedModel: '~openai/gpt-sol-latest[1m]',
      claimsOutcome: true,
    });
  });

  it('should still refuse an id a pane could not take as one word, and any id where the login takes none', () => {
    should(planRuntimeSwitch({ harness: 'claude', model: 'two words' }, openCatalog)).match({ kind: 'refused' });
    should(planRuntimeSwitch({ harness: 'claude', model: 'x;rm' }, openCatalog)).match({ kind: 'refused' });
    should(planRuntimeSwitch({ harness: 'claude', model: 'other-model' }, claudeContext)).match({ kind: 'refused' });
  });
});

describe('planRuntimeSwitch for fast mode', () => {
  it('should name the state it wants on a harness whose command takes one', () => {
    // Arrange / Act
    const on = planRuntimeSwitch({ harness: 'claude', fast: true }, claudeContext);
    const off = planRuntimeSwitch({ harness: 'claude', fast: false }, claudeContext);

    // Assert
    should(on).eql({ kind: 'inject', command: '/fast on', requestedFast: true, claimsOutcome: true });
    should(off).eql({ kind: 'inject', command: '/fast off', requestedFast: false, claimsOutcome: true });
  });

  it('should flip with a bare command on a harness whose command only flips, and only when it must', () => {
    // Codex types `/fast on` into the conversation as a message, so the only safe keystrokes are the bare command.
    // Arrange / Act
    const turnOn = planRuntimeSwitch(
      { harness: 'codex', fast: true },
      { ...codexContext, fast: { supported: true, current: false } },
    );
    const turnOff = planRuntimeSwitch(
      { harness: 'codex', fast: false },
      { ...codexContext, fast: { supported: true, current: true } },
    );

    // Assert
    should(turnOn).eql({ kind: 'inject', command: '/fast', requestedFast: true, claimsOutcome: true });
    should(turnOff).eql({ kind: 'inject', command: '/fast', requestedFast: false, claimsOutcome: true });
  });

  it('should type nothing when a flip would undo the state already asked for', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch(
      { harness: 'codex', fast: true },
      { ...codexContext, fast: { supported: true, current: true } },
    );

    // Assert
    should(plan).eql({ kind: 'unchanged' });
  });

  it('should refuse a flip it cannot place, rather than guess the direction', () => {
    // Arrange / Act
    const unknown = planRuntimeSwitch({ harness: 'codex', fast: true }, { ...codexContext, fast: { supported: true } });
    const none = planRuntimeSwitch({ harness: 'codex', fast: true }, codexContext);

    // Assert
    should(unknown).match({ kind: 'refused', reason: /not known yet/u });
    should(none).match({ kind: 'refused', reason: /not known yet/u });
  });

  it('should refuse a model that has no fast mode, naming it, on either harness', () => {
    // Arrange / Act
    const claude = planRuntimeSwitch(
      { harness: 'claude', fast: true },
      { ...claudeContext, fast: { supported: false, model: 'Sonnet 5.5' } },
    );
    const codex = planRuntimeSwitch(
      { harness: 'codex', fast: false },
      { ...codexContext, fast: { supported: false, current: true } },
    );

    // Assert
    should(claude).eql({ kind: 'refused', reason: 'Sonnet 5.5 has no fast mode' });
    should(codex).eql({ kind: 'refused', reason: 'this model has no fast mode' });
  });

  it('should try a command harness when nothing can say whether the model has it', () => {
    // The CLI answers a wrong guess itself, and the transcript carries that answer.
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'claude', fast: true }, claudeContext);

    // Assert
    should(plan).match({ kind: 'inject', command: '/fast on' });
  });

  it('should refuse fast mode combined with a model or an effort', () => {
    // Arrange / Act
    const withModel = planRuntimeSwitch({ harness: 'claude', fast: true, model: 'claude-opus-5' }, claudeContext);
    const withEffort = planRuntimeSwitch({ harness: 'claude', fast: true, effort: 'high' }, claudeContext);

    // Assert
    should(withModel).match({ kind: 'refused', reason: /on its own/u });
    should(withEffort).match({ kind: 'refused', reason: /on its own/u });
  });
});

describe('a Codex switch on a login catalog (docs/model-catalog.md)', () => {
  const catalogued: HarnessRuntimeSwitchContext = {
    wrapper: 'codex-deepseek',
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
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'deepseek-v4-pro', effort: 'max' }, catalogued);

    // Assert
    should(plan).eql({
      kind: 'drive_picker',
      target: { model: 'deepseek-v4-pro', rowName: 'DeepSeek V4 Pro', effort: 'max' },
    });
  });

  it('should name no row when the display name is the id', () => {
    // Act
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'same-name', effort: 'low' }, catalogued);

    // Assert
    should(plan).eql({ kind: 'drive_picker', target: { model: 'same-name', effort: 'low' } });
  });

  it('should switch to a model that has no level to choose without naming one', () => {
    // Act
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'kimi-k3' }, catalogued);

    // Assert
    should(plan).eql({ kind: 'drive_picker', target: { model: 'kimi-k3', rowName: 'Kimi K3' } });
  });

  it('should still ask for a level when the model has levels to choose from', () => {
    // Act
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'deepseek-v4-pro' }, catalogued);

    // Assert
    should(plan).eql({
      kind: 'refused',
      reason: 'a targeted switch on this harness requires both a model and a reasoning effort',
    });
  });
});
