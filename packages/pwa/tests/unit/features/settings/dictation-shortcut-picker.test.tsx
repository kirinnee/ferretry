import { describe, expect, it } from 'bun:test';

import {
  BARE_ALT_WARNING,
  beginDictationShortcutCapture,
  DEFAULT_DICTATION_SHORTCUT,
  dictationShortcutFromEvent,
  dictationShortcutLabel,
  sameDictationShortcutTrigger,
  validateDictationShortcut,
} from '../../../../src/features/settings/dictation-shortcut.ts';
import { DictationShortcutPicker } from '../../../../src/features/settings/dictation-shortcut-picker.tsx';
import { render, run } from '../../../support/react.ts';

const key = (overrides: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({
    key: 'v',
    code: 'KeyV',
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: true,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    ...overrides,
  }) as KeyboardEvent;

describe('DictationShortcutPicker', () => {
  it('renders the original hybrid gesture, phone fallback, 44px target, and bare-Alt warning', () => {
    const page = render(<DictationShortcutPicker binding={DEFAULT_DICTATION_SHORTCUT} onChange={() => undefined} />);
    const tree = JSON.stringify(page.toJSON());

    expect(tree).toContain('Alt (either side)');
    expect(tree).toContain('Hold to record and release to finish');
    expect(tree).toContain('tap once to latch');
    expect(tree).toContain('On a phone, use the mic button');
    expect(tree).toContain('never sends the message');
    expect(tree).toContain('min-h-[44px]');
    expect(tree).toContain(BARE_ALT_WARNING);
    expect(page.root.findAllByType('input')).toHaveLength(0);
    expect(page.root.findAllByType('textarea')).toHaveLength(0);
    run(() => page.unmount());
  });

  it('captures a safe chord only after its matching key release', () => {
    const changes: unknown[] = [];
    const page = render(
      <DictationShortcutPicker binding={DEFAULT_DICTATION_SHORTCUT} onChange={binding => changes.push(binding)} />,
    );
    const button = page.root.findByProps({ 'aria-pressed': false });

    run(() => button.props.onClick());
    run(() =>
      button.props.onKeyDown({ nativeEvent: key(), preventDefault: () => undefined, stopPropagation: () => undefined }),
    );
    expect(changes).toEqual([]);
    run(() =>
      button.props.onKeyUp({ nativeEvent: key(), preventDefault: () => undefined, stopPropagation: () => undefined }),
    );

    expect(changes).toEqual([{ code: 'KeyV', key: 'v', modifiers: ['Alt', 'Shift'] }]);
    expect(JSON.stringify(page.toJSON())).toContain('Alt + Shift + V saved.');
    run(() => page.unmount());
  });

  it('cancels capture on Escape or focus loss and keeps an invalid candidate out', () => {
    const page = render(<DictationShortcutPicker binding={DEFAULT_DICTATION_SHORTCUT} onChange={() => undefined} />);
    const button = page.root.findByProps({ 'aria-pressed': false });
    const event = (nativeEvent: KeyboardEvent) => ({
      nativeEvent,
      key: nativeEvent.key,
      repeat: false,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });

    run(() => button.props.onClick());
    run(() => button.props.onKeyDown(event(key({ key: 'Escape', code: 'Escape' }))));
    expect(JSON.stringify(page.toJSON())).toContain('Shortcut capture cancelled.');

    run(() => page.root.findByProps({ 'aria-pressed': false }).props.onClick());
    run(() =>
      page.root
        .findByProps({ 'aria-pressed': true })
        .props.onKeyDown(event(key({ key: 'F1', code: 'F1', altKey: false, shiftKey: false }))),
    );
    run(() =>
      page.root
        .findByProps({ 'aria-pressed': true })
        .props.onKeyUp(event(key({ key: 'F1', code: 'F1', altKey: false, shiftKey: false }))),
    );
    expect(JSON.stringify(page.toJSON())).toContain('function key is reserved');

    run(() => page.root.findByProps({ 'aria-pressed': true }).props.onClick());
    run(() => page.root.findByProps({ 'aria-pressed': false }).props.onClick());
    run(() => page.root.findByProps({ 'aria-pressed': true }).props.onKeyDown(event(key())));
    run(() => page.root.findByProps({ 'aria-pressed': true }).props.onBlur());
    expect(JSON.stringify(page.toJSON())).toContain('operating system took focus before keyup');

    run(() => page.root.findByProps({ 'aria-pressed': false }).props.onClick());
    run(() => page.root.findByProps({ 'aria-pressed': true }).props.onBlur());
    expect(JSON.stringify(page.toJSON())).toContain('Shortcut capture cancelled.');
    run(() => page.unmount());
  });

  it('offers the default reset when a custom shortcut is configured', () => {
    const changes: unknown[] = [];
    const page = render(
      <DictationShortcutPicker
        binding={{ code: 'KeyV', key: 'v', modifiers: ['Alt', 'Shift'] }}
        onChange={binding => changes.push(binding)}
      />,
    );
    const reset = page.root.findAllByType('button').find(button => button.props['aria-pressed'] === undefined)!;

    run(() => reset.props.onClick());
    expect(changes).toEqual([{ code: 'Alt', key: 'Alt', modifiers: [] }]);
    expect(JSON.stringify(page.toJSON())).toContain('Reset to Alt (either side).');
    run(() => page.unmount());
  });

  it('keeps unsafe browser shortcuts out of the configured binding', () => {
    expect(validateDictationShortcut({ code: 'KeyK', key: 'k', modifiers: ['Control'] }).reason).toContain(
      'command palette',
    );
    expect(validateDictationShortcut({ code: 'KeyD', key: 'd', modifiers: [] }).reason).toContain('while you type');
    expect(validateDictationShortcut({ code: 'ControlLeft', key: 'Control', modifiers: [] }).reason).toContain(
      'system controls',
    );
    expect(validateDictationShortcut({ code: 'ArrowDown', key: 'ArrowDown', modifiers: [] }).reason).toContain(
      'edits or navigates',
    );
    expect(validateDictationShortcut({ code: 'Alt', key: 'Alt', modifiers: [] })).toEqual({
      ok: true,
      warning: BARE_ALT_WARNING,
    });
  });

  it('preserves the browser key identity used for a readable saved shortcut', () => {
    expect(
      dictationShortcutFromEvent({
        key: 'Control',
        code: 'ControlLeft',
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toEqual({ code: 'ControlLeft', key: 'Control', modifiers: [] });
    expect(
      dictationShortcutFromEvent({ key: 'F2', code: '', ctrlKey: true, altKey: true, metaKey: true, shiftKey: true }),
    ).toEqual({ code: 'F2', key: 'F2', modifiers: ['Meta', 'Control', 'Alt', 'Shift'] });
    expect(dictationShortcutLabel({ code: 'AltLeft', key: 'Alt', modifiers: [] })).toBe('Left Alt');
    expect(dictationShortcutLabel({ code: 'Digit1', key: '1', modifiers: ['Control'] })).toBe('Ctrl + 1');
    expect(sameDictationShortcutTrigger(DEFAULT_DICTATION_SHORTCUT, { key: 'Alt', code: 'AltRight' })).toBe(true);
    expect(sameDictationShortcutTrigger({ code: 'KeyV', key: 'v', modifiers: [] }, { key: 'v', code: '' })).toBe(true);

    const release = beginDictationShortcutCapture();
    release();
    release();
  });
});
