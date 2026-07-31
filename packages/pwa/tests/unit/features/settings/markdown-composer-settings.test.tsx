import { describe, expect, it } from 'bun:test';
import { MD_COMPOSE_KEY, writeMdComposePref } from '../../../../src/lib/md-compose.ts';
import {
  MARKDOWN_COMPOSER_EXPLANATION,
  MarkdownComposerSettings,
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

describe('MarkdownComposerSettings', () => {
  it('renders an honest default-off, 44px switch and changes the live preference on click', () => {
    withBrowser(storage => {
      writeMdComposePref('off');
      const renderer = render(<MarkdownComposerSettings />);
      const control = renderer.root.findByProps({ role: 'switch' });

      expect(control.props['aria-checked']).toBe(false);
      expect(control.props.className).toContain('min-h-[44px]');
      expect(JSON.stringify(renderer.toJSON())).toContain('Highlight Markdown syntax');

      run(() => control.props.onClick());

      expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true);
      expect(storage.getItem(MD_COMPOSE_KEY)).toBe('on');
      run(() => renderer.unmount());
    });
  });

  it('keeps the native textarea as the only editor and explains the bounded preview truthfully', () => {
    withBrowser(() => {
      writeMdComposePref('off');
      const renderer = render(<MarkdownComposerSettings />);
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
});
