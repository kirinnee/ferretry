import { describe, expect, it } from 'bun:test';
import {
  DOCK_LAYOUT_EXPLANATION,
  MARKDOWN_COMPOSER_EXPLANATION,
  MarkdownComposerSettings,
  VIM_COMPOSER_EXPLANATION,
} from '../../../../src/features/settings/markdown-composer-settings.tsx';
import { COMPOSER_DOCK_LAYOUT_KEY } from '../../../../src/lib/composer-dock-layout.ts';
import { MD_COMPOSE_KEY, writeMdComposePref } from '../../../../src/lib/md-compose.ts';
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

/** The Vim switch is the only switch; the editor style is a radio group. */
const switches = (renderer: ReturnType<typeof render>) => renderer.root.findAllByProps({ role: 'switch' });

describe('MarkdownComposerSettings', () => {
  it('offers the editor styles as radios and changes the live preference', () => {
    withBrowser(storage => {
      writeMdComposePref('on');
      const renderer = render(surface());
      const styles = () =>
        renderer.root.findAll(node => node.type === 'input' && node.props.name === 'composer-editor-style');

      expect(styles().map(style => [style.props.value, style.props.checked])).toEqual([
        ['on', true],
        ['rich', false],
        ['off', false],
      ]);
      expect(JSON.stringify(renderer.toJSON())).toContain('Markdown, Notion-style');
      expect(JSON.stringify(renderer.toJSON())).toContain('Plain text box');

      run(() => styles()[2]?.props.onChange());
      expect(storage.getItem(MD_COMPOSE_KEY)).toBe('off');
      expect(styles()[2]?.props.checked).toBe(true);
      run(() => styles()[1]?.props.onChange());
      expect(storage.getItem(MD_COMPOSE_KEY)).toBe('rich');
      run(() => styles()[0]?.props.onChange());
      expect(storage.getItem(MD_COMPOSE_KEY)).toBe('on');
      run(() => renderer.unmount());
    });
  });

  it('offers the phone button layouts as radios, Stacked by default, and changes the live preference', () => {
    withBrowser(storage => {
      const renderer = render(surface());
      const layouts = () =>
        renderer.root.findAll(node => node.type === 'input' && node.props.name === 'composer-dock-layout');
      const tree = () => JSON.stringify(renderer.toJSON());

      expect(tree()).toContain('Button layout');
      expect(layouts().map(layout => [layout.props.value, layout.props.checked])).toEqual([
        ['stacked', true],
        ['row', false],
        ['auto', false],
      ]);
      expect(DOCK_LAYOUT_EXPLANATION).toContain('never move');
      expect(tree()).toContain(DOCK_LAYOUT_EXPLANATION);

      run(() => layouts()[1]?.props.onChange());
      expect(storage.getItem(COMPOSER_DOCK_LAYOUT_KEY)).toBe('row');
      expect(layouts()[1]?.props.checked).toBe(true);
      run(() => layouts()[2]?.props.onChange());
      expect(storage.getItem(COMPOSER_DOCK_LAYOUT_KEY)).toBe('auto');
      run(() => layouts()[0]?.props.onChange());
      expect(storage.getItem(COMPOSER_DOCK_LAYOUT_KEY)).toBe('stacked');
      expect(layouts()[0]?.props.checked).toBe(true);
      run(() => renderer.unmount());
    });
  });

  it('says what is sent is the markdown typed, and holds no editor of its own', () => {
    withBrowser(() => {
      const renderer = render(surface());
      const tree = JSON.stringify(renderer.toJSON());

      expect(MARKDOWN_COMPOSER_EXPLANATION).toContain('what you send is markdown');
      expect(MARKDOWN_COMPOSER_EXPLANATION).toContain('markers kept faintly visible');
      expect(tree).toContain('Editor style');
      expect(renderer.root.findAllByType('textarea')).toHaveLength(0);
      expect(renderer.root.findAll(node => 'contentEditable' in node.props)).toHaveLength(0);
      run(() => renderer.unmount());
    });
  });

  it('offers Vim-style editing off by default and reports the reader’s choice', () => {
    withBrowser(() => {
      writeMdComposePref('off');
      const chosen: boolean[] = [];
      const renderer = render(surface(false, enabled => chosen.push(enabled)));
      const vim = switches(renderer)[0];

      expect(switches(renderer)).toHaveLength(1);
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

      expect(switches(renderer)[0]?.props['aria-checked']).toBe(true);
      // Escape has no on-screen key, so the limit is stated rather than implied.
      expect(VIM_COMPOSER_EXPLANATION).toContain('Off by default');
      expect(VIM_COMPOSER_EXPLANATION).toContain('normal and insert');
      expect(VIM_COMPOSER_EXPLANATION).not.toContain('visual');
      expect(VIM_COMPOSER_EXPLANATION).toContain('physical keyboard');
      expect(tree).toContain(VIM_COMPOSER_EXPLANATION);
      expect(tree).toContain('NORMAL and INSERT shown under the box');
      expect(renderer.root.findAllByType('textarea')).toHaveLength(0);

      run(() => switches(renderer)[0]?.props.onClick());
      expect(chosen).toEqual([false]);
      run(() => renderer.unmount());
    });
  });
});
