/**
 * ChoiceCards and OptionBars: a native radio group with one tab stop whose arrow keys move the focus and never choose, the select animation
 * that never plays on mount or under reduced motion, and the bars' text equivalents.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { ChoiceCards, ChoiceSample } from '../../../src/compose/choice-cards.tsx';
import { barFill, OptionBars, optionBarsText } from '../../../src/compose/option-bars.tsx';
import { StepPageFrame, type StepPageBack, type StepPageNext } from '../../../src/compose/step-page-frame.tsx';
import { Segmented } from '../../../src/compose/setting-row.tsx';
import { RadioChoices } from '../../../src/ui/setup-ui.tsx';
import { StepProgress, stepProgressText } from '../../../src/compose/step-progress.tsx';
import { interact, type Mounted, mount, must, pressKey } from '@ferretry/app/testing';

const OPTIONS = [
  { id: 'a', title: 'Alpha', line: 'First' },
  { id: 'b', title: 'Beta' },
  { id: 'c', title: 'Gamma', disabled: true },
  { id: 'd', title: 'Delta' },
] as const;

function Harness({ start, log }: { readonly start: string | null; readonly log: string[] }) {
  const [value, setValue] = useState<string | null>(start);
  return (
    <ChoiceCards
      label="Pick one"
      options={OPTIONS}
      value={value}
      onChange={next => {
        log.push(next);
        setValue(next);
      }}
    />
  );
}

const radios = (c: HTMLElement) => [...c.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const cardOf = (c: HTMLElement, id: string) =>
  must(c.querySelector<HTMLElement>(`[data-choice="${id}"]`), `card ${id}`);

describe('ChoiceCards', () => {
  let mounted: Mounted | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    delete document.documentElement.dataset.motion;
  });

  it('should be one named radio group with the checked card as the only tab stop', async () => {
    mounted = await mount(<Harness start="b" log={[]} />);
    const group = must(mounted.container.querySelector('[role="radiogroup"]'), 'group');
    expect(group.getAttribute('aria-label')).toBe('Pick one');
    expect(radios(mounted.container).map(r => r.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(cardOf(mounted.container, 'b').getAttribute('data-selected')).toBe('true');
    expect(cardOf(mounted.container, 'a').getAttribute('data-selected')).toBe('false');
  });

  it('should give the first usable card the tab stop while nothing is chosen', async () => {
    mounted = await mount(<Harness start={null} log={[]} />);
    expect(radios(mounted.container).map(r => r.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it('should move the focus with the arrow keys WITHOUT choosing, skipping a disabled card and stopping at the ends', async () => {
    const log: string[] = [];
    mounted = await mount(<Harness start="b" log={log} />);
    const group = must(mounted.container.querySelector('[role="radiogroup"]'), 'group');
    const input = (i: number) => must(radios(mounted!.container)[i], `radio ${i}`);
    input(1).focus();
    await interact(() => pressKey(input(1), 'ArrowRight'));
    expect(document.activeElement).toBe(input(3));
    await interact(() => pressKey(input(3), 'ArrowRight'));
    expect(document.activeElement).toBe(input(3));
    await interact(() => pressKey(input(3), 'Home'));
    expect(document.activeElement).toBe(input(0));
    await interact(() => pressKey(input(0), 'End'));
    expect(document.activeElement).toBe(input(3));
    // Nothing was chosen by any of it: the checked card, the tab stop and the callback are all untouched.
    expect(log).toEqual([]);
    expect(cardOf(mounted.container, 'b').getAttribute('data-selected')).toBe('true');
    expect(radios(mounted.container).map(r => r.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(group.getAttribute('aria-label')).toBe('Pick one');
  });

  it('should choose the focused card on Enter, and on a click, and not before', async () => {
    const log: string[] = [];
    mounted = await mount(<Harness start="a" log={log} />);
    const input = (i: number) => must(radios(mounted!.container)[i], `radio ${i}`);
    input(0).focus();
    await interact(() => pressKey(input(0), 'ArrowDown'));
    expect(log).toEqual([]);
    await interact(() => pressKey(input(1), 'Enter'));
    expect(log).toEqual(['b']);
    expect(cardOf(mounted.container, 'b').getAttribute('data-selected')).toBe('true');
  });

  it('should choose by clicking a card and never report the card it already has', async () => {
    const log: string[] = [];
    mounted = await mount(<Harness start="a" log={log} />);
    await interact(() => radios(mounted!.container)[0]?.click());
    expect(log).toEqual([]);
    await interact(() => radios(mounted!.container)[1]?.click());
    expect(log).toEqual(['b']);
  });

  it('should not play the select animation on mount, but play it on the card just chosen', async () => {
    mounted = await mount(<Harness start="a" log={[]} />);
    expect(cardOf(mounted.container, 'a').getAttribute('data-pulse')).toBe('false');
    await interact(() => radios(mounted!.container)[1]?.click());
    expect(cardOf(mounted.container, 'b').getAttribute('data-pulse')).toBe('true');
    expect(cardOf(mounted.container, 'a').getAttribute('data-pulse')).toBe('false');
  });

  it('should play no animation when motion is reduced', async () => {
    document.documentElement.dataset.motion = 'reduced';
    mounted = await mount(<Harness start="a" log={[]} />);
    await interact(() => radios(mounted!.container)[1]?.click());
    expect(cardOf(mounted.container, 'b').getAttribute('data-selected')).toBe('true');
    expect(cardOf(mounted.container, 'b').getAttribute('data-pulse')).toBe('false');
  });

  it('should draw a sample in a fixed-shape box in EVERY card, the unchosen ones too, and keep it when the choice moves', async () => {
    const SIZE = { width: 200, height: 80 };
    const options = ['a', 'b'].map(id => ({
      id,
      title: id,
      demo: (
        <ChoiceSample size={SIZE}>
          <b data-scene={id}>{id}</b>
        </ChoiceSample>
      ),
    }));
    function Samples() {
      const [value, setValue] = useState<string | null>('a');
      return <ChoiceCards label="Pick" options={options} value={value} onChange={setValue} />;
    }
    mounted = await mount(<Samples />);
    const boxes = () => [...mounted!.container.querySelectorAll<HTMLElement>('[data-choice-sample]')];
    expect(boxes().length).toBe(2);
    for (const box of boxes()) {
      expect(box.getAttribute('aria-hidden')).toBe('true');
      expect(box.style.aspectRatio).toBe('200 / 80');
      expect(box.closest('.fy-cc__demo')).not.toBeNull();
    }
    expect(cardOf(mounted.container, 'b').querySelector('[data-scene="b"]')).not.toBeNull();
    const before = boxes().map(box => box.outerHTML.length);
    await interact(() => radios(mounted!.container)[1]?.click());
    expect(boxes().length).toBe(2);
    expect(boxes().map(box => box.style.aspectRatio)).toEqual(['200 / 80', '200 / 80']);
    expect(boxes().map(box => box.outerHTML.length)).toEqual(before);
    // The sample hangs its movement off the card's own pulse, which is set once, on the card just chosen.
    expect(cardOf(mounted.container, 'b').getAttribute('data-pulse')).toBe('true');
  });

  it('should not let a disabled card be chosen', async () => {
    const log: string[] = [];
    mounted = await mount(<Harness start="a" log={log} />);
    expect(radios(mounted.container)[2]?.disabled).toBe(true);
    expect(cardOf(mounted.container, 'c').getAttribute('aria-disabled')).toBe('true');
  });

  it('should move the first arrow to the SECOND card while nothing is chosen (the first holds the tab stop)', async () => {
    const log: string[] = [];
    mounted = await mount(<Harness start={null} log={log} />);
    const first = must(radios(mounted.container)[0], 'first radio');
    first.focus();
    await interact(() => pressKey(first, 'ArrowRight'));
    expect(document.activeElement).toBe(must(radios(mounted.container)[1], 'second radio'));
    expect(log).toEqual([]);
  });

  it('should tell the grid how many cards it holds, so two never stretch to the page', async () => {
    mounted = await mount(<Harness start="a" log={[]} />);
    const grid = must(mounted.container.querySelector<HTMLElement>('.fy-cc__grid'), 'grid');
    expect(grid.style.getPropertyValue('--cc-n')).toBe('4');
  });
});

describe('the other radio groups follow the same key rule', () => {
  let mounted: Mounted | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });
  const radiosOf = (c: HTMLElement) => [...c.querySelectorAll<HTMLInputElement>('input[type="radio"]')];

  it('should not write a Segmented setting on an arrow, only on Enter', async () => {
    const log: string[] = [];
    mounted = await mount(
      <Segmented
        label="Mode"
        value="a"
        options={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ]}
        onChange={next => log.push(next)}
      />,
    );
    const [first, second] = radiosOf(mounted.container);
    first?.focus();
    await interact(() => pressKey(must(first, 'first'), 'ArrowRight'));
    expect(document.activeElement).toBe(must(second, 'second'));
    expect(log).toEqual([]);
    await interact(() => pressKey(must(second, 'second'), 'Enter'));
    expect(log).toEqual(['b']);
  });

  it('should not choose a setup card (a native radio) on an arrow, only on Enter', async () => {
    const log: string[] = [];
    mounted = await mount(
      <RadioChoices
        legend="Pick"
        name="pick"
        value="a"
        options={[
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
        ]}
        onChoose={next => log.push(next)}
      />,
    );
    const [first, second] = radiosOf(mounted.container);
    first?.focus();
    await interact(() => pressKey(must(first, 'first'), 'ArrowDown'));
    expect(document.activeElement).toBe(must(second, 'second'));
    expect(log).toEqual([]);
    await interact(() => pressKey(must(second, 'second'), 'Enter'));
    expect(log).toEqual(['b']);
  });
});

describe('OptionBars', () => {
  let mounted: Mounted | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });

  it('should say its numbers in one label and hide the drawing', async () => {
    mounted = await mount(
      <OptionBars
        label="Whisper small"
        bars={[
          { label: 'Speed', value: 0.8 },
          { label: 'Size', value: 0.25 },
        ]}
      />,
    );
    const root = must(mounted.container.querySelector('[data-option-bars]'), 'bars');
    expect(root.getAttribute('role')).toBe('img');
    expect(root.getAttribute('aria-label')).toBe('Whisper small: Speed 80%, Size 25%');
    const fills = [...mounted.container.querySelectorAll<HTMLElement>('[data-option-bar-fill]')];
    expect(fills.map(f => f.style.width)).toEqual(['80%', '25%']);
  });

  it('should speak and draw a bar’s own words in place of its percentage', async () => {
    mounted = await mount(
      <OptionBars
        bars={[
          { label: 'Speed', value: 0.9, text: '0.4 s' },
          { label: 'Size', value: 0.1, text: '86 MB' },
        ]}
      />,
    );
    const root = must(mounted.container.querySelector('[data-option-bars]'), 'bars');
    expect(root.getAttribute('aria-label')).toBe('Speed 0.4 s, Size 86 MB');
    expect([...mounted.container.querySelectorAll('[data-option-bar-text]')].map(n => n.textContent)).toEqual([
      '0.4 s',
      '86 MB',
    ]);
    expect(mounted.container.querySelector('[data-option-bar="size"]')).not.toBeNull();
  });

  it('should clamp a value outside 0..1 and read a non-number as empty', () => {
    expect([barFill(2), barFill(-1), barFill(Number.NaN), barFill(0.5)]).toEqual([1, 0, 0, 0.5]);
    expect(optionBarsText([{ label: 'Speed', value: 9 }])).toBe('Speed 100%');
  });
});

const SEGMENTS = [
  { id: 'machine', label: 'Machine' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'device', label: 'This device' },
] as const;

describe('StepProgress', () => {
  let mounted: Mounted | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });

  it('should light the current segment, fill the ones before it and say "X · n of m" once', async () => {
    mounted = await mount(<StepProgress segments={SEGMENTS} current="claude" step={3} of={7} />);
    const states = [...mounted.container.querySelectorAll('[data-segment]')].map(n => n.getAttribute('data-state'));
    expect(states).toEqual(['done', 'current', 'ahead']);
    const bar = must(mounted.container.querySelector('[role="progressbar"]'), 'bar');
    expect(bar.getAttribute('aria-valuetext')).toBe('Claude Code · 3 of 7');
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(mounted.container.querySelector('.fy-sp-progress__text')?.textContent).toBe('Claude Code · 3 of 7');
  });

  it('should fill the current segment n of m only when the counter is its own pages', async () => {
    mounted = await mount(<StepProgress segments={SEGMENTS} current="claude" step={3} of={4} fills />);
    const current = must(mounted.container.querySelector('[data-state="current"]'), 'current segment');
    expect(current.hasAttribute('data-fills')).toBe(true);
    expect((current as HTMLElement).style.getPropertyValue('--fy-sp-fill')).toBe('0.75');
    await mounted.unmount();
    mounted = await mount(<StepProgress segments={SEGMENTS} current="claude" step={3} of={4} />);
    expect(mounted.container.querySelector('[data-fills]')).toBeNull();
  });

  it('should read an unknown segment as just the count', () => {
    expect(stepProgressText(SEGMENTS, 'nope', 2, 5)).toBe('2 of 5');
  });
});

describe('StepPageFrame', () => {
  let mounted: Mounted | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });
  const button = (c: HTMLElement, which: 'back' | 'next') => c.querySelector<HTMLButtonElement>(`[data-step-${which}]`);

  it('should draw the title, the line, the body, the demo and the progress', async () => {
    mounted = await mount(
      <StepPageFrame
        title="Which side?"
        line="Change it later."
        demo={<i data-demo="" />}
        progress={{ segments: SEGMENTS, current: 'machine', step: 1, of: 3 }}
        next={{ label: 'Next', onClick: () => undefined }}
      >
        <p data-body="">body</p>
      </StepPageFrame>,
    );
    const c = mounted.container;
    expect(c.querySelector('h1')?.textContent).toBe('Which side?');
    expect(c.querySelector('.fy-spf__line')?.textContent).toBe('Change it later.');
    expect(c.querySelector('[data-body]')).not.toBeNull();
    expect(c.querySelector('[data-step-demo] [data-demo]')).not.toBeNull();
    expect(c.querySelector('[data-step-progress]')).not.toBeNull();
    expect(button(c, 'back')).toBeNull();
  });

  it('should call Back and Next, label Back "Back" by default and lock Next when disabled or busy', async () => {
    const calls: string[] = [];
    mounted = await mount(
      <StepPageFrame
        title="T"
        back={{ onClick: () => calls.push('back') }}
        next={{ label: 'Continue', onClick: () => calls.push('next') }}
      >
        x
      </StepPageFrame>,
    );
    const c = mounted.container;
    expect(button(c, 'back')?.textContent).toBe('Back');
    expect(button(c, 'next')?.textContent).toBe('Continue');
    await interact(() => button(c, 'back')?.click());
    await interact(() => button(c, 'next')?.click());
    expect(calls).toEqual(['back', 'next']);
    await mounted.unmount();
    mounted = await mount(
      <StepPageFrame title="T" next={{ label: 'Next', busy: true, onClick: () => calls.push('x') }}>
        x
      </StepPageFrame>,
    );
    const next = must(button(mounted.container, 'next'), 'next');
    expect(next.disabled).toBe(true);
    expect(mounted.container.querySelector('[data-spinner]')).not.toBeNull();
    expect(mounted.container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
  });
});

describe('StepPageFrame documented API shape', () => {
  it('should type-check and render a caller that gives next={{label, disabled, busy}} and back={{label}} with no onClick', async () => {
    // The P1 API names next as {label, disabled?, busy?}: a caller written to that shape must compile (tsc is the
    // assertion) and draw.
    const next = { label: 'Next', disabled: false, busy: false } satisfies StepPageNext;
    const back = { label: 'Previous' } satisfies StepPageBack;
    const mounted = await mount(
      <StepPageFrame title="T" back={back} next={next}>
        x
      </StepPageFrame>,
    );
    try {
      expect(mounted.container.querySelector<HTMLButtonElement>('[data-step-next]')?.textContent).toBe('Next');
      expect(mounted.container.querySelector<HTMLButtonElement>('[data-step-back]')?.textContent).toBe('Previous');
      // Clicking with no handler is a no-op, not a throw.
      await interact(() => mounted.container.querySelector<HTMLButtonElement>('[data-step-next]')?.click());
    } finally {
      await mounted.unmount();
    }
  });
});
