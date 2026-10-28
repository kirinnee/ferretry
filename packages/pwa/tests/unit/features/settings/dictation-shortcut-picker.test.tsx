import { describe, expect, it } from 'bun:test';

import {
  BARE_ALT_WARNING,
  beginDictationShortcutCapture,
  DEFAULT_DICTATION_SHORTCUT,
  dictationShortcutCaptureActive,
  dictationShortcutFromEvent,
  dictationShortcutLabel,
  matchesDictationShortcut,
  type DictationShortcutBinding,
  sameDictationShortcutTrigger,
  validateDictationShortcut,
} from '../../../../src/features/settings/dictation-shortcut.ts';
import { DictationShortcutPicker } from '../../../../src/features/settings/dictation-shortcut-picker.tsx';
import { interact, mount, must } from '../../../support/dom.ts';
import { render, run } from '../../../support/react.ts';

describe('DictationShortcutPicker', () => {
  it('renders the original hybrid gesture, phone fallback, 44px target, and bare-Alt warning', () => {
    const page = render(<DictationShortcutPicker binding={DEFAULT_DICTATION_SHORTCUT} onChange={() => undefined} />);
    const tree = JSON.stringify(page.toJSON());

    expect(tree).toContain('Alt (either side)');
    expect(tree).toContain('Hold to record and release to finish');
    expect(tree).toContain('tap once to latch');
    expect(tree).toContain('On a phone, use the mic button');
    expect(tree).toContain('On an iPad keyboard, Option is Alt');
    expect(tree).toContain('never sends the message');
    expect(tree).toContain('min-h-[44px]');
    expect(tree).toContain(BARE_ALT_WARNING);
    expect(page.root.findAllByType('input')).toHaveLength(0);
    expect(page.root.findAllByType('textarea')).toHaveLength(0);
    run(() => page.unmount());
  });

  describe('on a WebKit page where tapping the button never focuses it', () => {
    const key = (type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent =>
      new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    // The event is aimed at the body: nothing in the picker is focused, which is the WebKit situation.
    const press = (type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent => {
      const event = key(type, init);
      document.body.dispatchEvent(event);
      return event;
    };
    const mountPicker = async (onChange: (binding: DictationShortcutBinding) => void = () => undefined) => {
      const mounted = await mount(<DictationShortcutPicker binding={DEFAULT_DICTATION_SHORTCUT} onChange={onChange} />);
      const button = must(mounted.container.querySelector<HTMLButtonElement>('[aria-pressed]'), 'the Change button');
      await interact(() => button.click());
      button.blur();
      return { mounted, button, status: () => mounted.container.querySelector('[role="status"]')?.textContent ?? '' };
    };

    it('captures a chord from document key events and saves it only after keyup', async () => {
      const changes: DictationShortcutBinding[] = [];
      const { mounted, button, status } = await mountPicker(binding => changes.push(binding));

      expect(document.activeElement).not.toBe(button);
      await interact(() => press('keydown', { key: 'v', code: 'KeyV', altKey: true, shiftKey: true }));
      expect(changes).toEqual([]);
      expect(status()).toContain('Release Alt + Shift + V');
      await interact(() => press('keyup', { key: 'v', code: 'KeyV' }));

      expect(changes).toEqual([{ code: 'KeyV', key: 'v', modifiers: ['Alt', 'Shift'] }]);
      expect(status()).toContain('Alt + Shift + V saved.');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      await mounted.unmount();
    });

    it('saves bare Alt when the iPadOS event reports no code', async () => {
      const changes: DictationShortcutBinding[] = [];
      const { mounted } = await mountPicker(binding => changes.push(binding));

      await interact(() => press('keydown', { key: 'Alt', code: '', altKey: true }));
      await interact(() => press('keyup', { key: 'Alt', code: '' }));

      expect(changes).toEqual([{ code: 'Alt', key: 'Alt', modifiers: [] }]);
      await mounted.unmount();
    });

    it('keeps an Option chord whose key is a special character and whose code is empty matchable', async () => {
      const changes: DictationShortcutBinding[] = [];
      const { mounted } = await mountPicker(binding => changes.push(binding));

      await interact(() => press('keydown', { key: 'å', code: '', altKey: true }));
      await interact(() => press('keyup', { key: 'å', code: '' }));

      expect(changes).toHaveLength(1);
      const saved = must(changes[0], 'the saved binding');
      expect(dictationShortcutLabel(saved)).toBe('Alt + å');
      expect(
        matchesDictationShortcut(saved, {
          key: 'å',
          code: '',
          altKey: true,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
        }),
      ).toBe(true);
      await mounted.unmount();
    });

    it('claims every key while listening so the composer never sees them, and stops claiming afterwards', async () => {
      const { mounted } = await mountPicker();
      let claimed: KeyboardEvent | undefined;
      await interact(() => {
        claimed = press('keydown', { key: 'v', code: 'KeyV', altKey: true });
      });
      expect(claimed?.defaultPrevented).toBe(true);
      await interact(() => press('keyup', { key: 'v', code: 'KeyV' }));

      await interact(() => press('keydown', { key: 'Escape', code: 'Escape' }));
      expect(press('keydown', { key: 'a', code: 'KeyA' }).defaultPrevented).toBe(false);
      await mounted.unmount();
    });

    it('cancels on Escape', async () => {
      const changes: DictationShortcutBinding[] = [];
      const { mounted, button, status } = await mountPicker(binding => changes.push(binding));

      await interact(() => press('keydown', { key: 'Escape', code: 'Escape' }));

      expect(status()).toBe('Shortcut capture cancelled.');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      await interact(() => press('keyup', { key: 'Escape', code: 'Escape' }));
      expect(changes).toEqual([]);
      await mounted.unmount();
    });

    it('rejects an unusable chord on release without saving it', async () => {
      const changes: DictationShortcutBinding[] = [];
      const { mounted, status } = await mountPicker(binding => changes.push(binding));

      await interact(() => press('keydown', { key: 'F1', code: 'F1' }));
      await interact(() => press('keyup', { key: 'F1', code: 'F1' }));

      expect(changes).toEqual([]);
      expect(status()).toContain('function key is reserved');
      await mounted.unmount();
    });

    it('cancels when the window loses focus, saying so if a chord was held', async () => {
      const held = await mountPicker();
      await interact(() => press('keydown', { key: 'v', code: 'KeyV', altKey: true }));
      await interact(() => window.dispatchEvent(new Event('blur')));
      expect(held.status()).toContain('operating system took focus before keyup');
      await held.mounted.unmount();

      const idle = await mountPicker();
      await interact(() => window.dispatchEvent(new Event('blur')));
      expect(idle.status()).toBe('Shortcut capture cancelled.');
      await idle.mounted.unmount();
    });

    it('cancels when the tab goes to the background', async () => {
      const { mounted, button } = await mountPicker();
      const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      try {
        await interact(() => document.dispatchEvent(new Event('visibilitychange')));
        expect(button.getAttribute('aria-pressed')).toBe('false');
      } finally {
        delete (document as unknown as Record<string, unknown>).visibilityState;
        if (original) Object.defineProperty(Document.prototype, 'visibilityState', original);
      }
      await mounted.unmount();
    });

    it('cancels on a tap elsewhere, because WebKit never blurs a button it never focused', async () => {
      const { mounted, button } = await mountPicker();

      await interact(() => button.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(button.getAttribute('aria-pressed')).toBe('true');
      await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));

      expect(button.getAttribute('aria-pressed')).toBe('false');
      expect(press('keydown', { key: 'a', code: 'KeyA' }).defaultPrevented).toBe(false);
      await mounted.unmount();
    });

    it('lets go of the keyboard and the capture flag when it unmounts mid-capture', async () => {
      const { mounted } = await mountPicker();
      expect(dictationShortcutCaptureActive()).toBe(true);

      await mounted.unmount();

      expect(dictationShortcutCaptureActive()).toBe(false);
      expect(press('keydown', { key: 'a', code: 'KeyA' }).defaultPrevented).toBe(false);
    });
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
