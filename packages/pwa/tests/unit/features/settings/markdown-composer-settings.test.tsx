import { describe, expect, it } from 'bun:test';
import { MD_COMPOSE_KEY, writeMdComposePref } from '../../../../src/lib/md-compose.ts';
import {
  MARKDOWN_COMPOSER_EXPLANATION,
  MarkdownComposerSettings,
  VIM_COMPOSER_EXPLANATION,
} from '../../../../src/features/settings/markdown-composer-settings.tsx';
import { render, run } from '../../../support/react.ts';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class BrowserWindow {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

const withBrowser = (body: (storage: MemoryStorage) => void): void => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new BrowserWindow() });
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    body(storage);
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
};

const surface = (vimEnabled = false, onChangeVim: (enabled: boolean) => void = () => {}) => (
  <MarkdownComposerSettings vimEnabled={vimEnabled} onChangeVim={onChangeVim} />
);

/** The highlight switch first, the Vim switch second, in rendered order. */
const switches = (renderer: ReturnType<typeof render>) => renderer.root.findAllByProps({ role: 'switch' });

describe('MarkdownComposerSettings', () => {
  it('renders an honest default-off, 44px switch and changes the live preference on click', () => {
    withBrowser(storage => {
      writeMdComposePref('off');
      const renderer = render(surface());
      const control = switches(renderer)[0];

      expect(control?.props['aria-checked']).toBe(false);
      expect(control?.props.className).toContain('min-h-[44px]');
      expect(JSON.stringify(renderer.toJSON())).toContain('Highlight Markdown syntax');

      run(() => control?.props.onClick());

      expect(switches(renderer)[0]?.props['aria-checked']).toBe(true);
      expect(storage.getItem(MD_COMPOSE_KEY)).toBe('on');

      // Turning it back off is the same control, not a second one.
      run(() => switches(renderer)[0]?.props.onClick());
      expect(storage.getItem(MD_COMPOSE_KEY)).toBe('off');
      run(() => renderer.unmount());
    });
  });

  it('keeps the native textarea as the only editor and explains the bounded preview truthfully', () => {
    withBrowser(() => {
      writeMdComposePref('off');
      const renderer = render(surface());
      const tree = JSON.stringify(renderer.toJSON());

      expect(MARKDOWN_COMPOSER_EXPLANATION).toContain('separate bounded preview');
      expect(MARKDOWN_COMPOSER_EXPLANATION).toContain('markers stay visible');
      expect(tree).toContain('real-device mobile Safari pass');
      expect(tree).toContain('original textarea still owns input, selection, dictation, autocomplete and drafts');
      expect(renderer.root.findAllByType('textarea')).toHaveLength(0);
      expect(renderer.root.findAll(node => 'contentEditable' in node.props)).toHaveLength(0);
      run(() => renderer.unmount());
    });
  });

  it('offers Vim-style editing off by default, reports the reader’s choice, and keeps the textarea', () => {
    withBrowser(() => {
      writeMdComposePref('off');
      const chosen: boolean[] = [];
      const renderer = render(surface(false, enabled => chosen.push(enabled)));
      const vim = switches(renderer)[1];

      expect(switches(renderer)).toHaveLength(2);
      expect(vim?.props['aria-checked']).toBe(false);
      expect(vim?.props.className).toContain('min-h-[44px]');
      expect(JSON.stringify(renderer.toJSON())).toContain('Vim-style editing');

      run(() => vim?.props.onClick());
      expect(chosen).toEqual([true]);
      run(() => renderer.unmount());
    });
  });

  it('shows an enabled Vim switch and states the physical-keyboard limit honestly', () => {
    withBrowser(() => {
      writeMdComposePref('off');
      const chosen: boolean[] = [];
      const renderer = render(surface(true, enabled => chosen.push(enabled)));
      const tree = JSON.stringify(renderer.toJSON());

      expect(switches(renderer)[1]?.props['aria-checked']).toBe(true);
      // Escape has no on-screen key, so the limit is stated rather than implied.
      expect(VIM_COMPOSER_EXPLANATION).toContain('Off by default');
      expect(VIM_COMPOSER_EXPLANATION).toContain('physical keyboard');
      expect(tree).toContain(VIM_COMPOSER_EXPLANATION);
      expect(tree).toContain('native textarea keeps input');
      expect(renderer.root.findAllByType('textarea')).toHaveLength(0);

      run(() => switches(renderer)[1]?.props.onClick());
      expect(chosen).toEqual([false]);
      run(() => renderer.unmount());
    });
  });
});
