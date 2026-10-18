import { describe, expect, test } from 'bun:test';

import { ComposerEnterKeySettings } from '../../../../src/features/settings/composer-enter-key-settings.tsx';
import { MotionSetting, SessionsListSetting } from '../../../../src/features/settings/conversation-settings.tsx';
import { render, run } from '../../../support/react.ts';

const radios = (view: ReturnType<typeof render>, name: string) =>
  view.root.findAll(node => node.type === 'input' && node.props.name === name);

describe('ComposerEnterKeySettings', () => {
  test('defaults a keyboard to ↵ sends and a phone to return = new line', () => {
    const patches: unknown[] = [];
    const view = render(
      <ComposerEnterKeySettings onChange={patch => patches.push(patch)} phonePreference={null} preference={null} />,
    );
    expect(radios(view, 'composer-enter-key').map(radio => [radio.props.value, radio.props.checked])).toEqual([
      ['send', true],
      ['newline', false],
    ]);
    expect(radios(view, 'composer-phone-enter-key').map(radio => [radio.props.value, radio.props.checked])).toEqual([
      ['newline', true],
      ['send', false],
    ]);
    run(() => radios(view, 'composer-enter-key')[1]?.props.onChange());
    run(() => radios(view, 'composer-phone-enter-key')[1]?.props.onChange());
    expect(patches).toEqual([{ composerEnterKey: 'newline' }, { composerPhoneEnterKey: 'send' }]);
    expect(JSON.stringify(view.toJSON())).toContain('⌘/Ctrl+↵ always sends');
  });

  test('reflects stored choices for both devices', () => {
    const view = render(<ComposerEnterKeySettings onChange={() => {}} phonePreference="send" preference="newline" />);
    expect(radios(view, 'composer-enter-key').find(radio => radio.props.checked)?.props.value).toBe('newline');
    expect(radios(view, 'composer-phone-enter-key').find(radio => radio.props.checked)?.props.value).toBe('send');
  });
});

describe('conversation and motion settings', () => {
  test('motion follows the system unless reduced is chosen', () => {
    const changes: string[] = [];
    const view = render(<MotionSetting motion="system" onChange={next => changes.push(next)} />);
    const options = radios(view, 'appearance-motion');
    expect(options.map(option => [option.props.value, option.props.checked])).toEqual([
      ['system', true],
      ['reduced', false],
    ]);
    run(() => options[1]?.props.onChange());
    expect(changes).toEqual(['reduced']);
  });
});

describe('the sessions list setting', () => {
  test('lists every machine unless the current machine alone is chosen', () => {
    const changes: string[] = [];
    const view = render(<SessionsListSetting scope="all" onChange={next => changes.push(next)} />);
    const options = radios(view, 'behaviour-sessions-list');
    expect(options.map(option => [option.props.value, option.props.checked])).toEqual([
      ['all', true],
      ['current', false],
    ]);
    run(() => options[1]?.props.onChange());
    expect(changes).toEqual(['current']);
  });
});
