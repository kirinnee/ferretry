import { describe, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import should from 'should';
import {
  ComposerRuntime,
  ComposerRuntimeWithKeyboard,
  codexReasoningObservationChanged,
  launchedModel,
  modelObservationChanged,
  RUNTIME_SWITCH_CONFIRM_MS,
  type RuntimeSwitchLifecycle,
  runtimeEffortReadout,
  runtimeModelChipLabel,
  runtimePopoverPosition,
  runtimeSwitchDisabledReason,
} from '../../src/components/composer-runtime.tsx';
import { pushEscapeLayer } from '../../src/hooks/use-dialog-focus.ts';
import { interact, type Mounted, mount, must, pressKey } from '../support/dom.ts';

/**
 * The bar's contract is what its two chips CLAIM: what the harness reported,
 * else the runtime the session was launched with — said as such — and never a
 * blank chip; a refusal reason carried non-visually, and a stale marker
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
  readonly harnessFlags?: readonly string[];
  readonly launchReasoningEffort?: string;
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
      harnessFlags: overrides.harnessFlags ?? [],
      launchReasoningEffort: overrides.launchReasoningEffort,
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

  test('should fall back to the model the session was launched on before the harness reports one', () => {
    // Assert
    should(runtimeModelChipLabel(session({ model: 'launched' }))).equal('launched');
    should(runtimeModelChipLabel(session({ modelHint: 'hinted' }))).equal('hinted');
  });

  test('should show unavailable only when neither an observation nor a launch model exists', () => {
    // Assert
    should(runtimeModelChipLabel(session({ modelHint: '   ' }))).equal('model unavailable');
  });
});

describe('launchedModel', () => {
  test("should let the operator's own --model flag win over the resolved default, last one first", () => {
    // Assert
    should(
      launchedModel(session({ model: 'default', harnessFlags: ['--model', 'first', '--model', 'last'] }).config),
    ).equal('last');
    should(launchedModel(session({ model: 'default', harnessFlags: ['--model=inline'] }).config)).equal('inline');
    should(
      launchedModel(session({ harness: 'codex', model: 'default', harnessFlags: ['-m', 'gpt-5.6'] }).config),
    ).equal('gpt-5.6');
  });

  test('should ignore a model flag with no usable value', () => {
    // Assert
    should(launchedModel(session({ model: 'default', harnessFlags: ['--model'] }).config)).equal('default');
    should(launchedModel(session({ model: 'default', harnessFlags: ['--model=  ', '--verbose'] }).config)).equal(
      'default',
    );
  });

  test('should read a hand-built view with no flags at all', () => {
    // Assert
    const view = session({ model: 'default' });
    should(launchedModel({ ...view.config, harnessFlags: undefined } as unknown as SessionView['config'])).equal(
      'default',
    );
  });
});

describe('runtimeEffortReadout', () => {
  test('should prefer what the harness reported or what was sent over the launch level', () => {
    // Assert
    should(
      runtimeEffortReadout(
        session({ harness: 'codex', observedReasoningEffort: 'high', launchReasoningEffort: 'low' }),
        undefined,
      ),
    ).deepEqual({
      label: 'high',
      aria: 'Set reasoning level — currently high',
    });
    should(runtimeEffortReadout(session({ launchReasoningEffort: 'low' }), 'max')).deepEqual({
      label: 'max',
      aria: 'Set reasoning effort — last set to max this session',
    });
  });

  test('should say the launch level before anything is reported, for both harnesses', () => {
    // Assert
    should(runtimeEffortReadout(session({ launchReasoningEffort: 'high' }), undefined)).deepEqual({
      label: 'high',
      aria: 'Set reasoning effort — launched with high',
    });
    should(runtimeEffortReadout(session({ harness: 'codex', launchReasoningEffort: 'medium' }), undefined)).deepEqual({
      label: 'medium',
      aria: 'Set reasoning level — launched with medium',
    });
  });

  test('should name the harness default rather than leave the chip blank', () => {
    // Assert
    should(runtimeEffortReadout(session({}), undefined)).deepEqual({
      label: 'default',
      aria: 'Set reasoning effort — the harness default',
    });
    should(runtimeEffortReadout(session({ harness: 'codex' }), '  ')).deepEqual({
      label: 'default',
      aria: 'Set reasoning level — the harness default',
    });
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
    should(labelOf(effortChip(view))).equal('default');
    should(ariaOf(modelChip(view))).equal('Switch model — currently claude-opus-5');
    should(ariaOf(effortChip(view))).equal('Set reasoning effort — the harness default');
    await view.unmount();
  });

  test('should name the launch runtime on a brand-new session the harness has said nothing about', async () => {
    // Act
    const view = await mount(
      <ComposerRuntime
        busy={false}
        canControl
        view={session({ model: 'claude-opus-5[1m]', launchReasoningEffort: 'high' })}
      />,
    );

    // Assert
    should(labelOf(modelChip(view))).equal('claude-opus-5[1m]');
    should(ariaOf(modelChip(view))).equal('Switch model — launched on claude-opus-5[1m]');
    should(labelOf(effortChip(view))).equal('high');
    should(ariaOf(effortChip(view))).equal('Set reasoning effort — launched with high');
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

  test('should say the Codex level is the harness default rather than leave it blank', async () => {
    // Act
    const view = await mount(<ComposerRuntime busy={false} canControl view={session({ harness: 'codex' })} />);

    // Assert
    should(labelOf(effortChip(view))).equal('default');
    should(ariaOf(effortChip(view))).equal('Set reasoning level — the harness default');
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
    should(labelOf(effortChip(view))).equal('default');
    await view.unmount();
  });
});

describe('ComposerRuntime bounded switching', () => {
  interface BarState {
    readonly overrides: SessionOverrides;
    readonly busy?: boolean;
    readonly confirmMs?: number;
  }

  /** A bar whose model sheet body captures its lifecycle, re-rendered with each new state. */
  const bar = async (
    initial: BarState,
  ): Promise<{
    readonly view: Mounted;
    readonly lifecycle: () => RuntimeSwitchLifecycle;
    readonly rerender: (next: BarState) => Promise<void>;
  }> => {
    let captured: RuntimeSwitchLifecycle | undefined;
    const element = ({ overrides, busy = false, confirmMs = 10 }: BarState) => (
      <ComposerRuntime
        busy={busy}
        canControl
        renderModelControls={lifecycle => {
          captured = lifecycle;
          return null;
        }}
        switchConfirmMs={confirmMs}
        view={session(overrides)}
      />
    );
    const view = await mount(element(initial));
    await interact(() => modelChip(view).click());
    return {
      view,
      lifecycle: () => must(captured, 'the captured sheet lifecycle'),
      rerender: async next => view.render(element(next)),
    };
  };

  const elapse = (ms: number): Promise<void> => interact(() => new Promise(resolve => setTimeout(resolve, ms)));
  const markOf = (chip: HTMLButtonElement): string | null =>
    chip.querySelector('[data-switch-state]')?.getAttribute('data-switch-state') ?? null;
  const observed = { observedModel: 'claude-opus-5', observedModelAt: 't1' };

  test('should bound "switching…" by default so it can never be permanent', async () => {
    // Assert
    should(RUNTIME_SWITCH_CONFIRM_MS).be.within(5_000, 60_000);
  });

  test('should say the switch was not confirmed once the bound passes with no evidence', async () => {
    // Arrange
    const { view, lifecycle } = await bar({ overrides: observed });
    await interact(() => lifecycle().onSwitchSubmitted());

    // Act
    await elapse(40);

    // Assert — the last OBSERVED model stays named; only the claim about it changes.
    should(markOf(modelChip(view))).equal('unconfirmed');
    should(labelOf(modelChip(view))).equal('claude-opus-5');
    should(ariaOf(modelChip(view))).endWith(', could not confirm the switch; showing the last reported value');
    should(modelChip(view).title).equal('Couldn’t confirm the switch — showing the last value the harness reported');
    await view.unmount();
  });

  test('should keep "switching…" while the bound has not passed', async () => {
    // Arrange
    const { view, lifecycle } = await bar({ overrides: observed, confirmMs: 60_000 });

    // Act
    await interact(() => lifecycle().onSwitchSubmitted());

    // Assert
    should(markOf(modelChip(view))).equal('pending');
    should(modelChip(view).title).equal('Switching — waiting for the harness to confirm');
    await view.unmount();
  });

  test('should settle an unconfirmed switch when late evidence arrives', async () => {
    // Arrange
    const { view, lifecycle, rerender } = await bar({ overrides: observed });
    await interact(() => lifecycle().onSwitchSubmitted());
    await elapse(40);

    // Act
    await rerender({ overrides: { observedModel: 'claude-sonnet-5', observedModelAt: 't2' } });

    // Assert
    should(markOf(modelChip(view))).be.null();
    should(labelOf(modelChip(view))).equal('claude-sonnet-5');
    await view.unmount();
  });

  test('should settle a pending switch when the session goes busy', async () => {
    // Arrange
    const { view, lifecycle, rerender } = await bar({ overrides: observed, confirmMs: 60_000 });
    await interact(() => lifecycle().onSwitchSubmitted());

    // Act
    await rerender({ overrides: observed, busy: true, confirmMs: 60_000 });

    // Assert
    should(markOf(modelChip(view))).be.null();
    await view.unmount();
  });

  test('should keep saying unconfirmed while a busy turn runs, until it reports', async () => {
    // Arrange
    const { view, lifecycle, rerender } = await bar({ overrides: observed });
    await interact(() => lifecycle().onSwitchSubmitted());
    await elapse(40);

    // Act
    await rerender({ overrides: observed, busy: true });

    // Assert
    should(markOf(modelChip(view))).equal('unconfirmed');
    await view.unmount();
  });

  test('should settle any switch when the session finishes', async () => {
    // Arrange
    const { view, lifecycle, rerender } = await bar({ overrides: observed });
    await interact(() => lifecycle().onSwitchSubmitted());
    await elapse(40);

    // Act
    await rerender({ overrides: { ...observed, status: 'stopped' } });

    // Assert
    should(markOf(modelChip(view))).be.null();
    await view.unmount();
  });

  test('should clear an unconfirmed switch when a new submit fails', async () => {
    // Arrange
    const { view, lifecycle } = await bar({ overrides: observed });
    await interact(() => lifecycle().onSwitchSubmitted());
    await elapse(40);

    // Act
    await interact(() => lifecycle().onSwitchFailed());

    // Assert
    should(markOf(modelChip(view))).be.null();
    await view.unmount();
  });

  test('should bound both Codex readouts together', async () => {
    // Arrange
    const { view, lifecycle } = await bar({
      overrides: { harness: 'codex', observedModel: 'gpt-5.6', observedReasoningEffort: 'high', observedModelAt: 't1' },
    });
    await interact(() => lifecycle().onSwitchSubmitted());

    // Act
    await elapse(40);

    // Assert
    should(markOf(modelChip(view))).equal('unconfirmed');
    should(markOf(effortChip(view))).equal('unconfirmed');
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

describe('runtimePopoverPosition', () => {
  const viewport = { width: 1280, height: 800 };
  const size = { width: 300, height: 200 };

  test('should open upward, left-aligned with the chip and clear of it', () => {
    // Assert
    should(runtimePopoverPosition({ left: 100, top: 700, bottom: 720 }, size, viewport)).eql({ left: 100, top: 494 });
  });

  test('should drop below the chip when there is no room above it', () => {
    // Assert
    should(runtimePopoverPosition({ left: 100, top: 40, bottom: 60 }, size, viewport)).eql({ left: 100, top: 66 });
  });

  test('should stay on screen at the right edge', () => {
    // Assert
    should(runtimePopoverPosition({ left: 1200, top: 700, bottom: 720 }, size, viewport).left).equal(900);
  });
});

describe('ComposerRuntime presentations', () => {
  const sheetOf = (): Element | null => document.querySelector('[data-bottom-sheet]');
  const popoverOf = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-runtime-popover]');
  const choices = (lifecycle: RuntimeSwitchLifecycle) => (
    <div aria-label="choices" role="menu">
      <button role="menuitemradio" aria-checked type="button">
        {lifecycle.presentation}
      </button>
    </div>
  );
  const bar = (presentation?: 'sheet' | 'popover', view = session({})) => (
    <ComposerRuntime
      busy={false}
      canControl
      {...(presentation === undefined ? {} : { presentation })}
      renderEffortControls={choices}
      renderModelControls={choices}
      view={view}
    />
  );

  test('should keep the bottom sheet on a phone, which is the default', async () => {
    // Arrange
    const view = await mount(bar());

    // Act
    await interact(() => modelChip(view).click());

    // Assert
    should(sheetOf()).not.be.null();
    should(popoverOf()).be.null();
    should(must(document.querySelector('[role="menuitemradio"]'), 'the body').textContent).equal('sheet');
    await view.unmount();
  });

  test('should anchor a small popover at the chip on a desktop, not a sheet', async () => {
    // Arrange
    const view = await mount(bar('popover'));

    // Act
    await interact(() => modelChip(view).click());

    // Assert
    const popover = must(popoverOf(), 'the popover');
    should(sheetOf()).be.null();
    should(popover.getAttribute('role')).equal('dialog');
    should(popover.getAttribute('aria-modal')).be.null();
    should(popover.getAttribute('aria-label')).equal('Switch model');
    should(popover.id).equal(modelChip(view).getAttribute('aria-controls'));
    should(popover.className).containEql('fixed');
    should(popover.style.visibility).equal('visible');
    should(popover.textContent).containEql('claude');
    should(must(popover.querySelector('[role="menuitemradio"]'), 'the body').textContent).equal('popover');
    await view.unmount();
  });

  test('should draw the sheet at the document root when the host sits inside a moving panel', async () => {
    // Arrange
    const view = await mount(
      <ComposerRuntime
        busy={false}
        canControl
        portalOverlays
        renderEffortControls={choices}
        renderModelControls={choices}
        view={session({})}
      />,
    );

    // Act
    await interact(() => modelChip(view).click());

    // Assert: the sheet opened, and it is not inside the chips' host.
    const sheet = must(sheetOf(), 'the sheet');
    should(view.container.contains(sheet)).be.false();
    should(sheet.closest('body')).equal(document.body);
    await view.unmount();
  });

  test('should hand the body the Claude effort the chip names', async () => {
    // Arrange
    let captured: RuntimeSwitchLifecycle | undefined;
    const view = await mount(
      <ComposerRuntime
        busy={false}
        canControl
        presentation="popover"
        renderEffortControls={lifecycle => {
          captured = lifecycle;
          return null;
        }}
        view={session({ launchReasoningEffort: 'high' })}
      />,
    );

    // Act
    await interact(() => effortChip(view).click());

    // Assert
    should(must(captured, 'the lifecycle').claudeEffort).equal('high');
    should(must(popoverOf(), 'the popover').getAttribute('aria-label')).equal('Reasoning effort');
    await interact(() => must(captured, 'the lifecycle').onClaudeEffortSent('low'));
    should(must(captured, 'the lifecycle').claudeEffort).equal('low');
    await view.unmount();
  });

  test('should lift itself above the chip again when its body grows', async () => {
    // Arrange — a resize observer the test can fire, because the body grows on
    // its own render (a catalog arriving) without re-rendering this shell.
    const original = globalThis.ResizeObserver;
    const fired: (() => void)[] = [];
    const disconnected: boolean[] = [];
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        fired.push(callback);
      }
      observe(): void {}
      disconnect(): void {
        disconnected.push(true);
      }
      unobserve(): void {}
    } as unknown as typeof ResizeObserver;
    const view = await mount(bar('popover'));
    try {
      await interact(() => modelChip(view).click());
      const popover = must(popoverOf(), 'the popover');
      modelChip(view).getBoundingClientRect = () => ({ left: 100, top: 700, bottom: 720 }) as DOMRect;
      Object.defineProperty(popover, 'offsetHeight', { configurable: true, value: 200 });
      Object.defineProperty(popover, 'offsetWidth', { configurable: true, value: 300 });

      // Act
      await interact(() => must(fired[0], 'the observer callback')());

      // Assert
      should(popover.style.top).equal('494px');
      should(popover.style.left).equal('100px');
      await interact(() => modelChip(view).click());
      should(disconnected).eql([true]);
    } finally {
      await view.unmount();
      globalThis.ResizeObserver = original;
    }
  });

  test('should close on Escape and hand focus back to the chip', async () => {
    // Arrange
    const view = await mount(bar('popover'));
    await interact(() => effortChip(view).click());

    // Act
    await interact(() => pressKey(must(document.activeElement, 'the focus'), 'Escape'));

    // Assert
    should(popoverOf()).be.null();
    should(effortChip(view).getAttribute('aria-expanded')).equal('false');
    should(document.activeElement).equal(effortChip(view));
    await view.unmount();
  });

  test('should leave Escape to a layer opened over it', async () => {
    // Arrange
    const view = await mount(bar('popover'));
    await interact(() => modelChip(view).click());
    const release = pushEscapeLayer({});

    // Act
    try {
      await interact(() => pressKey(document, 'Escape'));
      await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    } finally {
      release();
    }

    // Assert
    should(popoverOf()).not.be.null();
    await view.unmount();
  });

  test('should ignore keys other than Escape', async () => {
    // Arrange
    const view = await mount(bar('popover'));
    await interact(() => modelChip(view).click());

    // Act
    await interact(() => pressKey(document, 'a'));

    // Assert
    should(popoverOf()).not.be.null();
    await view.unmount();
  });

  test('should close on an outside press but not on a press inside it or on its chip', async () => {
    // Arrange
    const view = await mount(bar('popover'));
    await interact(() => modelChip(view).click());
    const press = (target: EventTarget) =>
      interact(() => target.dispatchEvent(new Event('pointerdown', { bubbles: true })));

    // Act + Assert
    await press(must(popoverOf(), 'the popover'));
    should(popoverOf()).not.be.null();
    await press(modelChip(view));
    should(popoverOf()).not.be.null();
    await press(document.body);
    should(popoverOf()).be.null();
    should(modelChip(view).getAttribute('aria-expanded')).equal('false');
    await view.unmount();
  });

  test('should toggle shut from its own chip', async () => {
    // Arrange
    const view = await mount(bar('popover'));
    await interact(() => modelChip(view).click());

    // Act
    await interact(() => modelChip(view).click());

    // Assert
    should(popoverOf()).be.null();
    await view.unmount();
  });

  test('should close when the window resizes, because the chip it was placed against moved', async () => {
    // Arrange
    const view = await mount(bar('popover'));
    await interact(() => modelChip(view).click());

    // Act
    await interact(() => window.dispatchEvent(new Event('resize')));

    // Assert
    should(popoverOf()).be.null();
    await view.unmount();
  });

  test('should close when focus leaves for the page, but not when it moves inside or to the chip', async () => {
    // Arrange
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const view = await mount(bar('popover'));
    await interact(() => modelChip(view).click());
    const popover = must(popoverOf(), 'the popover');
    const item = must(popover.querySelector<HTMLElement>('[role="menuitemradio"]'), 'the item');
    const blur = (relatedTarget: EventTarget | null) =>
      interact(() => item.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget })));

    try {
      // Act + Assert
      await blur(null);
      should(popoverOf()).not.be.null();
      await blur(popover);
      should(popoverOf()).not.be.null();
      await blur(modelChip(view));
      should(popoverOf()).not.be.null();
      await blur(outside);
      should(popoverOf()).be.null();
    } finally {
      await view.unmount();
      outside.remove();
    }
  });
});
