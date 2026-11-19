import { describe, expect, test } from 'bun:test';

import { ChoiceCards } from '../../../../app/composer/choice-cards-stand-in.tsx';
import { render, run } from '@ferretry/app/testing';

const OPTIONS = [
  { id: 'a', title: 'A', line: 'one' },
  { id: 'b', title: 'B' },
] as const;

const cards = (view: ReturnType<typeof render>) =>
  view.root.findAll(node => node.type === 'label' && node.props['data-choice'] !== undefined);

describe('ChoiceCards stand-in (P1 contract)', () => {
  test('is a native radio group with the dot hidden: one name, the chosen one checked', () => {
    const view = render(<ChoiceCards legend="Pick" name="pick" onChange={() => {}} options={OPTIONS} value="a" />);
    const radios = view.root.findAll(node => node.type === 'input');
    expect(radios.map(radio => [radio.props.type, radio.props.name, radio.props.checked])).toEqual([
      ['radio', 'pick', true],
      ['radio', 'pick', false],
    ]);
    run(() => view.unmount());
  });

  test('plays the pop for a pressed card only, never on first draw', () => {
    let value: 'a' | 'b' = 'a';
    const draw = () => (
      <ChoiceCards
        legend="Pick"
        name="pick"
        onChange={next => {
          value = next;
        }}
        options={OPTIONS}
        value={value}
      />
    );
    const view = render(draw());
    expect(cards(view).map(card => card.props['data-pop'])).toEqual([false, false]);
    run(() => view.root.findAll(node => node.type === 'input')[1]?.props.onChange());
    run(() => view.update(draw()));
    expect(cards(view).map(card => [card.props['data-selected'], card.props['data-pop']])).toEqual([
      [false, false],
      [true, true],
    ]);
    run(() => view.unmount());
  });
});
