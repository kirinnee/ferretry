/**
 * ChoiceCards and OptionBars: a native radio group with one tab stop and arrow-key selection, the select animation
 * that never plays on mount or under reduced motion, and the bars' text equivalents.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { ChoiceCards, choiceAfterKey } from '../../../src/compose/choice-cards.tsx';
import { barFill, OptionBars, optionBarsText } from '../../../src/compose/option-bars.tsx';
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

  it('should move and select with the arrow keys, skipping a disabled card, and stop at the ends', async () => {
    const log: string[] = [];
    mounted = await mount(<Harness start="b" log={log} />);
    const group = must(mounted.container.querySelector('[role="radiogroup"]'), 'group');
    await interact(() => pressKey(group, 'ArrowRight'));
    expect(log).toEqual(['d']);
    await interact(() => pressKey(group, 'ArrowRight'));
    expect(log).toEqual(['d']);
    await interact(() => pressKey(group, 'Home'));
    expect(log).toEqual(['d', 'a']);
    expect(radios(mounted.container).map(r => r.tabIndex)).toEqual([0, -1, -1, -1]);
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

  it('should not let a disabled card be chosen', async () => {
    const log: string[] = [];
    mounted = await mount(<Harness start="a" log={log} />);
    expect(radios(mounted.container)[2]?.disabled).toBe(true);
    expect(cardOf(mounted.container, 'c').getAttribute('aria-disabled')).toBe('true');
  });

  it('should find the next usable option for a key', () => {
    expect(choiceAfterKey(OPTIONS, 'a', 'ArrowDown')?.id).toBe('b');
    expect(choiceAfterKey(OPTIONS, 'b', 'ArrowDown')?.id).toBe('d');
    expect(choiceAfterKey(OPTIONS, 'd', 'ArrowUp')?.id).toBe('b');
    expect(choiceAfterKey(OPTIONS, 'a', 'End')?.id).toBe('d');
    expect(choiceAfterKey(OPTIONS, 'a', 'x')).toBeUndefined();
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

  it('should clamp a value outside 0..1 and read a non-number as empty', () => {
    expect([barFill(2), barFill(-1), barFill(Number.NaN), barFill(0.5)]).toEqual([1, 0, 0, 0.5]);
    expect(optionBarsText([{ label: 'Speed', value: 9 }])).toBe('Speed 100%');
  });
});
