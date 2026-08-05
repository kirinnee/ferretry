import { describe, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import should from 'should';
import {
  ComposerRuntime,
  ComposerRuntimeWithKeyboard,
  codexReasoningObservationChanged,
  modelObservationChanged,
  type RuntimeSwitchLifecycle,
  runtimeModelChipLabel,
  runtimeSwitchDisabledReason,
} from '../../src/components/composer-runtime.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

/**
 * The bar's contract is what its two chips CLAIM: a readout that never asserts an
 * unobserved runtime, a refusal reason carried non-visually, and a stale marker
 * that clears only on fresh harness evidence. All of it is asserted through a real
 * mount, because the chips are dialog triggers and the sheets are document facts.
 */

// `matchMedia` is deliberately NOT installed here. The sheets only read it for
// their entry animation, `usePrefersReducedMotion` already tolerates its absence,
// and bun runs the whole suite in one process — assigning a global stub would
// change the closing behaviour every other sheet suite asserts.

interface SessionOverrides {
  readonly harness?: 'claude' | 'codex';
  readonly id?: string;
  readonly status?: string;
  readonly model?: string;
  readonly modelHint?: string;
  readonly observedModel?: string;
  readonly observedModelAt?: string;
  readonly observedReasoningEffort?: string;
}

const session = (overrides: SessionOverrides): SessionView =>
  ({
    config: {
      id: overrides.id ?? 's1',
      harness: overrides.harness ?? 'claude',
      model: overrides.model,
      modelHint: overrides.modelHint ?? 'claude-opus-5',
    },
    state: {
      status: overrides.status ?? 'running',
      observedModel: overrides.observedModel,
      observedModelAt: overrides.observedModelAt,
      observedReasoningEffort: overrides.observedReasoningEffort,
    },
  }) as unknown as SessionView;

/** The two bar triggers, in render order: model then reasoning. */
const chips = (view: Mounted): HTMLButtonElement[] => [
  ...view.container.querySelectorAll<HTMLButtonElement>('.fy-composer__runtime'),
];
const modelChip = (view: Mounted): HTMLButtonElement => must(chips(view)[0], 'the model chip');
const effortChip = (view: Mounted): HTMLButtonElement => must(chips(view)[1], 'the reasoning chip');
const labelOf = (chip: HTMLButtonElement): string =>
  must(chip.querySelector('span'), 'the chip label').textContent ?? '';
const ariaOf = (chip: HTMLButtonElement): string => chip.getAttribute('aria-label') ?? '';
const reasonOf = (view: Mounted): HTMLElement | null => view.container.querySelector('.sr-only');

describe('modelObservationChanged', () => {
  test('should confirm a re-selection of the running model through its timestamp alone', () => {
    // Assert
    should(modelObservationChanged({ model: 'a', observedAt: 't1' }, { model: 'a', observedAt: 't2' })).be.true();
  });

  test('should confirm a changed model value', () => {
    // Assert
    should(modelObservationChanged({ model: 'a', observedAt: 't1' }, { model: 'b', observedAt: 't1' })).be.true();
  });

  test('should not confirm an identical observation', () => {
    // Assert
    should(modelObservationChanged({ model: 'a', observedAt: 't1' }, { model: 'a', observedAt: 't1' })).be.false();
  });
});

describe('codexReasoningObservationChanged', () => {
  test('should confirm a re-selection of the running level through its timestamp', () => {
    // Assert — the value-only comparison is what left "switching…" stuck.
    should(
      codexReasoningObservationChanged({ effort: 'high', observedAt: 't1' }, { effort: 'high', observedAt: 't2' }),
    ).be.true();
  });

  test('should not confirm an identical observation', () => {
    // Assert
    should(
      codexReasoningObservationChanged({ effort: 'high', observedAt: 't1' }, { effort: 'high', observedAt: 't1' }),
    ).be.false();
  });
});

describe('runtimeSwitchDisabledReason', () => {
  test('should tell a read-only reader about their authority before anything else', () => {
    // Assert
    should(runtimeSwitchDisabledReason(false, true, true)).containEql('Read-only origin');
  });

  test('should prefer a finished session over a busy one', () => {
    // Assert
    should(runtimeSwitchDisabledReason(true, true, true)).containEql('Session finished');
  });

  test('should report a busy session', () => {
    // Assert
    should(runtimeSwitchDisabledReason(true, false, true)).containEql('Busy');
  });

  test('should allow a switch on an idle, live, controllable session', () => {
    // Assert
    should(runtimeSwitchDisabledReason(true, false, false)).be.undefined();
  });
});

describe('runtimeModelChipLabel', () => {
  test('should prefer the observed runtime model', () => {
    // Assert
    should(runtimeModelChipLabel(session({ observedModel: ' gpt-5.6 ', model: 'requested' }))).equal('gpt-5.6');
  });

  test('should not present a launch request or hint as the running model', () => {
    // Assert
    should(runtimeModelChipLabel(session({ model: 'requested' }))).equal('model unavailable');
    should(runtimeModelChipLabel(session({ modelHint: 'hinted' }))).equal('model unavailable');
  });

  test('should show unavailable when no model observation exists', () => {
    // Assert
    should(runtimeModelChipLabel(session({ modelHint: '   ' }))).equal('model unavailable');
  });
});

describe('ComposerRuntime chips', () => {
  test('should name the current model and reasoning in each chip', async () => {
    // Act
    const view = await mount(
      <ComposerRuntime busy={false} canControl view={session({ observedModel: 'claude-opus-5' })} />,
    );

    // Assert
    should(labelOf(modelChip(view))).equal('claude-opus-5');
    should(labelOf(effortChip(view))).equal('effort');
    should(ariaOf(modelChip(view))).equal('Switch model — currently claude-opus-5');
    should(ariaOf(effortChip(view))).equal('Set reasoning effort');
    await view.unmount();
  });

  test("should read Codex's reasoning level from the harness", async () => {
    // Act
    const view = await mount(
      <ComposerRuntime busy={false} canControl view={session({ harness: 'codex', observedReasoningEffort: 'high' })} />,
    );

    // Assert
    should(labelOf(effortChip(view))).equal('high');
    should(ariaOf(effortChip(view))).equal('Set reasoning level — currently high');
    await view.unmount();
  });

  test('should say the Codex level is unknown rather than guess it', async () => {
    // Act
    const view = await mount(<ComposerRuntime busy={false} canControl view={session({ harness: 'codex' })} />);

    // Assert
    should(labelOf(effortChip(view))).equal('reasoning');
    should(ariaOf(effortChip(view))).containEql('currently unknown');
    await view.unmount();
  });

  test('should mark both triggers as dialog openers', async () => {
    // Act
    const view = await mount(<ComposerRuntime busy={false} canControl view={session({})} />);

    // Assert
    should(chips(view).every(chip => chip.getAttribute('aria-haspopup') === 'dialog')).be.true();
    should(chips(view).every(chip => chip.getAttribute('aria-expanded') === 'false')).be.true();
    should(chips(view).every(chip => chip.getAttribute('aria-controls') === null)).be.true();
    await view.unmount();
  });

  test('should point a trigger at its sheet only while that sheet is open', async () => {
    // Arrange
    const view = await mount(<ComposerRuntime busy={false} canControl view={session({})} />);

    // Act
    await interact(() => modelChip(view).click());

    // Assert
    should(modelChip(view).getAttribute('aria-expanded')).equal('true');
    should(modelChip(view).getAttribute('aria-controls')).be.a.String();
    should(effortChip(view).getAttribute('aria-controls')).be.null();
    await view.unmount();
  });

  test('should carry the reason a switch is refused non-visually', async () => {
    // Act
    const view = await mount(<ComposerRuntime busy canControl={false} view={session({})} />);

    // Assert
    const reason = must(reasonOf(view), 'the refusal reason');
    should(reason.textContent).containEql('Read-only origin');
    should(chips(view).every(chip => chip.disabled)).be.true();
    should(chips(view).every(chip => chip.getAttribute('aria-describedby') === reason.id)).be.true();
    should(chips(view).every(chip => (chip.getAttribute('title') ?? '').includes('Read-only origin'))).be.true();
    await view.unmount();
  });

  test('should refuse a switch on a finished session', async () => {
    // Act
    const view = await mount(<ComposerRuntime busy={false} canControl view={session({ status: 'completed' })} />);

    // Assert
    should(modelChip(view).disabled).be.true();
    should(must(reasonOf(view), 'the refusal reason').textContent).containEql('Session finished');
    await view.unmount();
  });

  test('should offer the switch and no reason on an idle live session', async () => {
    // Act
    const view = await mount(<ComposerRuntime busy={false} canControl view={session({})} />);

    // Assert
    should(modelChip(view).disabled).be.false();
    should(reasonOf(view)).be.null();
    should(modelChip(view).getAttribute('title')).equal('Switch model in place');
    await view.unmount();
  });
});

describe('ComposerRuntime stale-until-evidence', () => {
  const codex = { harness: 'codex' as const, observedReasoningEffort: 'high', observedModel: 'gpt-5.6' };

  /** A bar whose model sheet body captures the lifecycle it was handed. */
  const barWithCapture = async (
    overrides: SessionOverrides,
  ): Promise<{ readonly view: Mounted; readonly lifecycle: () => RuntimeSwitchLifecycle }> => {
    let captured: RuntimeSwitchLifecycle | undefined;
    const view = await mount(
      <ComposerRuntime
        busy={false}
        canControl
        renderModelControls={lifecycle => {
          captured = lifecycle;
          return null;
        }}
        view={session(overrides)}
      />,
    );
    await interact(() => modelChip(view).click());
    return { view, lifecycle: () => must(captured, 'the captured sheet lifecycle') };
  };

  const observe = async (view: Mounted, overrides: SessionOverrides): Promise<void> => {
    await view.render(<ComposerRuntime busy={false} canControl view={session(overrides)} />);
  };

  test('should mark the model readout switching once a switch is submitted', async () => {
    // Arrange
    const { view, lifecycle } = await barWithCapture({ observedModel: 'claude-opus-5', observedModelAt: 't1' });

    // Act
    await interact(() => lifecycle().onSwitchSubmitted());

    // Assert
    should(ariaOf(modelChip(view))).endWith(', switching');
    await view.unmount();
  });

  test('should clear the marker when fresh evidence arrives, even for the same model', async () => {
    // Arrange
    const { view, lifecycle } = await barWithCapture({ observedModel: 'claude-opus-5', observedModelAt: 't1' });
    await interact(() => lifecycle().onSwitchSubmitted());

    // Act — the harness re-echoes the same model with a new timestamp.
    await observe(view, { observedModel: 'claude-opus-5', observedModelAt: 't2' });

    // Assert
    should(ariaOf(modelChip(view))).not.endWith(', switching');
    await view.unmount();
  });

  test('should clear the marker when the submit itself failed', async () => {
    // Arrange
    const { view, lifecycle } = await barWithCapture({ observedModel: 'claude-opus-5', observedModelAt: 't1' });
    await interact(() => lifecycle().onSwitchSubmitted());

    // Act
    await interact(() => lifecycle().onSwitchFailed());

    // Assert
    should(ariaOf(modelChip(view))).not.endWith(', switching');
    await view.unmount();
  });

  test('should make both Codex readouts stale, because Codex echoes them together', async () => {
    // Arrange
    const { view, lifecycle } = await barWithCapture({ ...codex, observedModelAt: 't1' });

    // Act
    await interact(() => lifecycle().onSwitchSubmitted());

    // Assert
    should(ariaOf(modelChip(view))).endWith(', switching');
    should(ariaOf(effortChip(view))).endWith(', switching');
    await view.unmount();
  });

  test('should clear both Codex readouts on one observation', async () => {
    // Arrange
    const { view, lifecycle } = await barWithCapture({ ...codex, observedModelAt: 't1' });
    await interact(() => lifecycle().onSwitchSubmitted());

    // Act
    await observe(view, { ...codex, observedModelAt: 't2' });

    // Assert
    should(ariaOf(modelChip(view))).not.endWith(', switching');
    should(ariaOf(effortChip(view))).not.endWith(', switching');
    await view.unmount();
  });

  test('should clear both Codex readouts when the submit failed', async () => {
    // Arrange
    const { view, lifecycle } = await barWithCapture({ ...codex, observedModelAt: 't1' });
    await interact(() => lifecycle().onSwitchSubmitted());

    // Act
    await interact(() => lifecycle().onSwitchFailed());

    // Assert
    should(ariaOf(effortChip(view))).not.endWith(', switching');
    await view.unmount();
  });

  test('should never claim a Claude effort is observed, only that it was sent', async () => {
    // Arrange
    const { view, lifecycle } = await barWithCapture({ observedModel: 'claude-opus-5' });

    // Act
    await interact(() => lifecycle().onClaudeEffortSent('xhigh'));

    // Assert — sent, not switching: Claude never echoes the level back.
    should(labelOf(effortChip(view))).equal('xhigh');
    should(ariaOf(effortChip(view))).equal('Set reasoning effort — last set to xhigh this session');
    await view.unmount();
  });

  test('should forget everything observed about the previous session', async () => {
    // Arrange
    const { view, lifecycle } = await barWithCapture({
      id: 's1',
      observedModel: 'claude-opus-5',
      observedModelAt: 't1',
    });
    await interact(() => lifecycle().onSwitchSubmitted());
    await interact(() => lifecycle().onClaudeEffortSent('xhigh'));

    // Act
    await observe(view, { id: 's2', observedModel: 'claude-opus-5', observedModelAt: 't1' });

    // Assert
    should(ariaOf(modelChip(view))).not.endWith(', switching');
    should(labelOf(effortChip(view))).equal('effort');
    await view.unmount();
  });
});

describe('ComposerRuntime sheets', () => {
  test('should hand each sheet body its own close, so one cannot close the other', async () => {
    // Arrange
    let effortLifecycle: RuntimeSwitchLifecycle | undefined;
    const view = await mount(
      <ComposerRuntime
        busy={false}
        canControl
        renderEffortControls={lifecycle => {
          effortLifecycle = lifecycle;
          return <p>reasoning body</p>;
        }}
        renderModelControls={() => <p>model body</p>}
        view={session({})}
      />,
    );

    // Act
    await interact(() => effortChip(view).click());
    await interact(() => must(effortLifecycle, 'the reasoning lifecycle').onClose());

    // Assert
    should(effortChip(view).getAttribute('aria-expanded')).equal('false');
    should(modelChip(view).getAttribute('aria-expanded')).equal('false');
    await view.unmount();
  });

  test('should open an empty sheet rather than crash when a control is not supplied', async () => {
    // Arrange
    const view = await mount(<ComposerRuntime busy={false} canControl view={session({})} />);

    // Act
    await interact(() => modelChip(view).click());

    // Assert — an unported runtime control is an empty sheet, never a crash.
    should(modelChip(view).getAttribute('aria-expanded')).equal('true');
    await view.unmount();
  });

  test('should close an open sheet if the keyboard rises under it', async () => {
    // Arrange — the row is display:none while the keyboard is up, and it owns the sheet.
    const runtime = session({});
    const view = await mount(
      <ComposerRuntimeWithKeyboard busy={false} canControl view={runtime} keyboardOpen={false} />,
    );
    try {
      await interact(() => modelChip(view).click());

      // Act
      await view.render(<ComposerRuntimeWithKeyboard busy={false} canControl view={runtime} keyboardOpen />);

      // Assert
      should(modelChip(view).getAttribute('aria-expanded')).equal('false');
    } finally {
      await view.unmount();
    }
  });
});
