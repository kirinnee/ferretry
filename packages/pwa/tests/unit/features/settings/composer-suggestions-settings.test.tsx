import { describe, expect, test } from 'bun:test';

import {
  COMPOSER_SUGGESTIONS_EXPLANATION,
  COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE,
  ComposerSuggestionsSettings,
} from '../../../../src/features/settings/composer-suggestions-settings.tsx';
import { DEFAULT_DEVICE_CONTROLS, type DeviceControls } from '../../../../src/lib/controls.ts';
import { render, run } from '../../../support/react.ts';

type Preferences = Pick<DeviceControls, 'suggestionKeys' | 'skillSuggestions'>;

const preferences = (overrides: Partial<Preferences> = {}): Preferences => ({
  suggestionKeys: DEFAULT_DEVICE_CONTROLS.suggestionKeys,
  skillSuggestions: DEFAULT_DEVICE_CONTROLS.skillSuggestions,
  ...overrides,
});

describe('ComposerSuggestionsSettings', () => {
  test('offers the three choices of keys as 44px radios, the @ ladder chosen by default', () => {
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
    for (const label of view.root.findAll(node => node.type === 'label'))
      expect(label.props.className).toContain('min-h-[44px]');
    for (const radio of radios) run(() => radio.props.onChange());
    expect(patches).toEqual([{ suggestionKeys: 'ladder' }, { suggestionKeys: 'symbols' }, { suggestionKeys: 'both' }]);
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

  test('names every key it governs and says out loud that authored references still work', () => {
    const view = render(<ComposerSuggestionsSettings preferences={preferences()} onChange={() => {}} />);
    const tree = JSON.stringify(view.toJSON());

    expect(tree).toContain('Open suggestions with');
    expect(tree).toContain('@ files · @@ agents · @@@ agenda · @@@@ tasks');
    expect(tree).toContain('@ files · : agents · ! agenda · & tasks · % terminals');
    expect(tree).toContain('$name skill form');

    // The asymmetry is the contract: an offer is removed, never a capability.
    expect(COMPOSER_SUGGESTIONS_EXPLANATION).toContain('offers, not what it understands');
    expect(COMPOSER_SUGGESTIONS_EXPLANATION).toContain('still resolves and still links');
    expect(tree).toContain(COMPOSER_SUGGESTIONS_EXPLANATION);
    expect(COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE).toContain('open in every mode');
    expect(tree).toContain(COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE);

    run(() => view.unmount());
  });
});
