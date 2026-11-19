import { describe, expect, test } from 'bun:test';

import {
  COMPOSER_SUGGESTIONS_EXPLANATION,
  COMPOSER_SUGGESTIONS_INTRO,
  COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE,
  ComposerSuggestionsSettings,
} from '../../../../app/composer/composer-suggestions-settings.tsx';
import { DEFAULT_DEVICE_CONTROLS, type DeviceControls } from '@ferretry/app';
import { render, run } from '@ferretry/app/testing';

type Preferences = Pick<DeviceControls, 'suggestionKeys' | 'skillSuggestions'>;

const preferences = (overrides: Partial<Preferences> = {}): Preferences => ({
  suggestionKeys: DEFAULT_DEVICE_CONTROLS.suggestionKeys,
  skillSuggestions: DEFAULT_DEVICE_CONTROLS.skillSuggestions,
  ...overrides,
});

describe('ComposerSuggestionsSettings', () => {
  test('offers the three choices of keys as cards in one radio group, the @ ladder chosen by default', () => {
    const patches: Partial<Preferences>[] = [];
    const view = render(
      <ComposerSuggestionsSettings preferences={preferences()} onChange={patch => patches.push(patch)} />,
    );
    const radios = view.root.findAll(node => node.type === 'input' && node.props.type === 'radio');
    expect(radios.map(radio => [radio.props.value, radio.props.checked])).toEqual([
      ['ladder', true],
      ['symbols', false],
      ['both', false],
    ]);
    // P1's ChoiceCards: ONE native radio group (one name), one tab stop on the chosen card, arrow keys move and select.
    expect(new Set(radios.map(radio => radio.props.name)).size).toBe(1);
    expect(radios.map(radio => radio.props.tabIndex)).toEqual([0, -1, -1]);
    expect(view.root.findByProps({ role: 'radiogroup' }).props['aria-label']).toBe('Open suggestions with');
    // Choosing the card that is already chosen is no change; the other two patch one field each.
    for (const radio of radios) run(() => radio.props.onChange());
    expect(patches).toEqual([{ suggestionKeys: 'symbols' }, { suggestionKeys: 'both' }]);
    run(() => view.unmount());
  });

  test('reflects a stored choice and toggles the $ skills switch both ways', () => {
    const patches: Partial<Preferences>[] = [];
    const view = render(
      <ComposerSuggestionsSettings
        preferences={preferences({ suggestionKeys: 'symbols', skillSuggestions: false })}
        onChange={patch => patches.push(patch)}
      />,
    );
    const checked = view.root.findAll(node => node.type === 'input' && node.props.checked === true);
    expect(checked.map(radio => radio.props.value)).toEqual(['symbols']);
    const skills = view.root.findByProps({ role: 'switch' });
    expect(skills.props['aria-checked']).toBe(false);
    run(() => skills.props.onClick());
    expect(patches).toEqual([{ skillSuggestions: true }]);
    run(() => view.unmount());

    const on = render(
      <ComposerSuggestionsSettings preferences={preferences()} onChange={patch => patches.push(patch)} />,
    );
    run(() => on.root.findByProps({ role: 'switch' }).props.onClick());
    expect(patches.at(-1)).toEqual({ skillSuggestions: false });
    run(() => on.unmount());
  });

  test('the $ skills switch is a plain row: no bordered box around it', () => {
    const view = render(<ComposerSuggestionsSettings preferences={preferences()} onChange={() => {}} />);
    const skills = view.root.findByProps({ role: 'switch' });
    expect(skills.props.className).not.toMatch(/(^|\s)border(\s|$)|border-(accent|border)|bg-accent-soft/);
    expect(skills.props.className).toContain('w-fit');
    run(() => view.unmount());
  });

  test('shows the keys of every card, but explains only the selected one', () => {
    const view = render(<ComposerSuggestionsSettings preferences={preferences()} onChange={() => {}} />);
    const tree = JSON.stringify(view.toJSON());
    for (const card of ['@ ladder', 'Symbols', 'Both']) expect(tree).toContain(card);
    expect(tree).toContain('@ files · @@ agents · @@@ asks · @@@@ tasks · % terminals');
    // Every card lists its own keys, % included (it opens the terminals menu in every mode), Both with the whole ladder.
    for (const keys of ['@ @@ @@@ @@@@ %', '@ : ! & %', '@ @@ @@@ @@@@ : ! & %']) expect(tree).toContain(keys);
    // The other modes' explanations are not drawn: only what is selected.
    expect(tree).not.toContain('@ files · : agents · ! asks · & tasks · % terminals');
    run(() => view.unmount());

    const symbols = render(
      <ComposerSuggestionsSettings preferences={preferences({ suggestionKeys: 'symbols' })} onChange={() => {}} />,
    );
    const symbolsTree = JSON.stringify(symbols.toJSON());
    expect(symbolsTree).toContain('@ files · : agents · ! asks · & tasks · % terminals');
    expect(symbolsTree).not.toContain('@@ agents');
    expect(symbolsTree).toContain('$name skill form');
    run(() => symbols.unmount());
  });

  test('the long words sit behind the (i), closed until pressed, and say authored references still work', () => {
    const view = render(<ComposerSuggestionsSettings preferences={preferences()} onChange={() => {}} />);
    expect(JSON.stringify(view.toJSON())).not.toContain(COMPOSER_SUGGESTIONS_EXPLANATION);
    const info = view.root.findByProps({ 'aria-label': 'More about suggestions' });
    expect(info.props['aria-expanded']).toBe(false);
    run(() => info.props.onClick());
    const open = JSON.stringify(view.toJSON());
    expect(open).toContain(COMPOSER_SUGGESTIONS_EXPLANATION);
    expect(open).toContain(COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE);
    expect(view.root.findByProps({ 'aria-label': 'More about suggestions' }).props['aria-expanded']).toBe(true);

    // The asymmetry is the contract: an offer is removed, never a capability.
    expect(COMPOSER_SUGGESTIONS_EXPLANATION).toContain('offers, not what it understands');
    expect(COMPOSER_SUGGESTIONS_EXPLANATION).toContain('still resolves and still links');
    expect(COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE).toContain('open in every mode');
    // One line of intro, not three.
    expect(COMPOSER_SUGGESTIONS_INTRO.length).toBeLessThan(70);
    run(() => view.unmount());
  });
});
