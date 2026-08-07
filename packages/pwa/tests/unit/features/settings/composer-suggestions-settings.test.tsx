import { describe, expect, test } from 'bun:test';

import {
  COMPOSER_SUGGESTIONS_EXPLANATION,
  COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE,
  ComposerSuggestionsSettings,
} from '../../../../src/features/settings/composer-suggestions-settings.tsx';
import { DEFAULT_DEVICE_CONTROLS } from '../../../../src/lib/controls.ts';
import { render, run } from '../../../support/react.ts';

const preferences = (overrides: Partial<typeof DEFAULT_DEVICE_CONTROLS> = {}) => ({
  mentionSuggestions: DEFAULT_DEVICE_CONTROLS.mentionSuggestions,
  directReferenceSuggestions: DEFAULT_DEVICE_CONTROLS.directReferenceSuggestions,
  skillSuggestions: DEFAULT_DEVICE_CONTROLS.skillSuggestions,
  ...overrides,
});

describe('ComposerSuggestionsSettings', () => {
  test('offers one 44px switch per family, on by default, and patches only the family pressed', () => {
    const patches: Array<Record<string, boolean>> = [];
    const view = render(
      <ComposerSuggestionsSettings preferences={preferences()} onChange={patch => patches.push(patch)} />,
    );
    const switches = view.root.findAllByProps({ role: 'switch' });

    expect(switches).toHaveLength(3);
    for (const control of switches) {
      expect(control.props['aria-checked']).toBe(true);
      expect(control.props.className).toContain('min-h-[44px]');
    }

    for (const control of switches) run(() => control.props.onClick());
    expect(patches).toEqual([
      { mentionSuggestions: false },
      { directReferenceSuggestions: false },
      { skillSuggestions: false },
    ]);

    run(() => view.unmount());
  });

  test('turns a family back on from off, and reflects each stored value independently', () => {
    const patches: Array<Record<string, boolean>> = [];
    const view = render(
      <ComposerSuggestionsSettings
        preferences={preferences({ directReferenceSuggestions: false })}
        onChange={patch => patches.push(patch)}
      />,
    );
    const switches = view.root.findAllByProps({ role: 'switch' });

    expect(switches.map(control => control.props['aria-checked'])).toEqual([true, false, true]);
    run(() => switches[1]?.props.onClick());
    expect(patches).toEqual([{ directReferenceSuggestions: true }]);

    run(() => view.unmount());
  });

  test('names every governed sigil and says out loud that authored references still work', () => {
    const view = render(<ComposerSuggestionsSettings preferences={preferences()} onChange={() => {}} />);
    const tree = JSON.stringify(view.toJSON());

    // The whole @ ladder, including bare @, is one switch.
    expect(tree).toContain('@ ladder');
    expect(tree).toContain('files with @, agents with @@, tasks with @@@, attention with @@@@');
    expect(tree).toContain(':agent, &task and !attention');
    expect(tree).toContain('$name skill form');

    // The asymmetry is the contract: an offer is removed, never a capability.
    expect(COMPOSER_SUGGESTIONS_EXPLANATION).toContain('offers, not what it understands');
    expect(COMPOSER_SUGGESTIONS_EXPLANATION).toContain('still resolves and still links');
    expect(COMPOSER_SUGGESTIONS_EXPLANATION).toContain('Add to chat is unaffected');
    expect(tree).toContain(COMPOSER_SUGGESTIONS_EXPLANATION);

    // `/` and `%` are named as ungoverned, so nobody looks for a switch for them.
    expect(COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE).toContain('/ command menu is never suppressed');
    expect(COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE).toContain('% terminal and browser surfaces');
    expect(tree).toContain(COMPOSER_SUGGESTIONS_UNGOVERNED_NOTE);

    // A labelled fieldset rather than role="group", which this repo's a11y lint refuses.
    expect(view.root.findAllByType('fieldset')).toHaveLength(1);
    expect(view.root.findByType('fieldset').props['aria-label']).toBe('Composer reference suggestions');

    run(() => view.unmount());
  });
});
