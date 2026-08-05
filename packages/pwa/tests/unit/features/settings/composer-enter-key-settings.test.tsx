import { describe, expect, test } from 'bun:test';

import { ComposerEnterKeySettings } from '../../../../src/features/settings/composer-enter-key-settings.tsx';
import { render, run } from '../../../support/react.ts';

describe('ComposerEnterKeySettings', () => {
  test('writes an explicit browser-local choice and can return to the device default', () => {
    const choices: Array<'send' | 'newline' | null> = [];
    const view = render(<ComposerEnterKeySettings preference="send" onChange={choice => choices.push(choice)} />);

    run(() => view.root.findByProps({ name: 'composer-enter-key', value: 'newline' }).props.onChange());
    const reset = view.root
      .findAllByType('button')
      .find(button => button.children.join('').startsWith('Use this device'));
    if (!reset) throw new Error('Reset button is missing');
    run(() => reset.props.onClick());

    expect(choices).toEqual(['newline', null]);
  });
});
