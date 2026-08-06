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
    should(plan).eql({ kind: 'refused', reason: 'effort must be one of low, medium, high, xhigh' });
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

  it('should drive the picker without a preflight when the model opens the reasoning menu', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'gpt-5-codex', effort: 'high' }, codexContext);

    // Assert: an advanced effort exists, so the quick row cannot silently apply a
    // preset and no screen read is needed first.
    should(plan).eql({ kind: 'drive_picker', target: { model: 'gpt-5-codex', effort: 'high' }, needsPreflight: false });
  });

  it('should preflight when the quick row would apply a different preset effort', () => {
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
      needsPreflight: true,
    });
  });

  it('should skip the preflight when the quick row already applies the requested effort', () => {
    // Arrange / Act
    const plan = planRuntimeSwitch({ harness: 'codex', model: 'gpt-5-mini', effort: 'low' }, codexContext);

    // Assert
    should(plan).eql({ kind: 'drive_picker', target: { model: 'gpt-5-mini', effort: 'low' }, needsPreflight: false });
  });

  it('should preflight when the account advertises no default effort at all', () => {
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
      needsPreflight: true,
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
    should(plan).eql({ kind: 'drive_picker', target: { model: 'gpt-5-pro', effort: 'high' }, needsPreflight: false });
  });
});
