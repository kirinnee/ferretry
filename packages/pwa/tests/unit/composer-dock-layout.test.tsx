import { afterEach, describe, expect, test } from 'bun:test';
import { Composer } from '../../src/components/composer.tsx';
import {
  COMPOSER_DOCK_LAYOUT_DEFAULT,
  COMPOSER_DOCK_LAYOUT_KEY,
  parseComposerDockLayout,
  readComposerDockLayout,
  writeComposerDockLayout,
} from '../../src/lib/composer-dock-layout.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import '../support/dom.ts';
import { render, run } from '../support/react.ts';

const daemon = daemonConnection({ daemonId: 'dock', baseUrl: 'https://dock.example.test', deviceId: 'device' });

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

afterEach(() => writeComposerDockLayout(COMPOSER_DOCK_LAYOUT_DEFAULT));

describe('the phone composer’s button layout (Settings › Composer › Button layout)', () => {
  test('is Stacked unless this device chose One row or Auto, and nothing else is read as a choice', () => {
    expect(COMPOSER_DOCK_LAYOUT_DEFAULT).toBe('stacked');
    expect(parseComposerDockLayout('row')).toBe('row');
    expect(parseComposerDockLayout('auto')).toBe('auto');
    expect(parseComposerDockLayout('stacked')).toBe('stacked');
    expect(parseComposerDockLayout('column')).toBe('stacked');
    expect(parseComposerDockLayout(null)).toBe('stacked');
  });

  test('is kept on this device under its own key', () => {
    writeComposerDockLayout('auto');
    expect(readComposerDockLayout()).toBe('auto');
    expect(localStorage.getItem(COMPOSER_DOCK_LAYOUT_KEY)).toBe('auto');
  });

  test('is stamped on a phone composer, live, and never on a desktop one', () => {
    const composer = (compact: boolean) => (
      <Composer
        api={{ send: async () => ({}) } as never}
        compact={compact}
        daemon={daemon}
        draftStore={new DaemonDraftStore(new MemoryStorage())}
        sessionId="dock"
      />
    );
    const layoutOf = (view: ReturnType<typeof render>) =>
      view.root.findByType('form').props['data-composer-dock-layout'] as string | undefined;
    const phone = render(composer(true));
    const desktop = render(composer(false));
    expect(layoutOf(phone)).toBe('stacked');
    expect(layoutOf(desktop)).toBeUndefined();
    run(() => writeComposerDockLayout('row'));
    expect(layoutOf(phone)).toBe('row');
    expect(layoutOf(desktop)).toBeUndefined();
    run(() => phone.unmount());
    run(() => desktop.unmount());
  });
});
