import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Composer } from '../../src/components/composer.tsx';
import { LocationShareContext } from '../../src/hooks/use-location-share.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import type { LocationFix, LocationShareHost } from '../../src/lib/location-share.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { interact, mount, must } from '../support/dom.ts';

beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

const daemon = daemonConnection({ daemonId: 'plus', baseUrl: 'https://plus.example.test', deviceId: 'device' });

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const host: LocationShareHost = { locate: () => new Promise<LocationFix>(() => undefined) };

const mountComposer = (compact: boolean, withHost = true) =>
  mount(
    <LocationShareContext.Provider value={withHost ? host : null}>
      <Composer
        api={{ send: async () => ({}) as never }}
        compact={compact}
        daemon={daemon}
        draftStore={new DaemonDraftStore(new MemoryStorage())}
        sessionId="s1"
      />
    </LocationShareContext.Provider>,
  );

const plus = (root: HTMLElement): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>('button[data-composer-attach]'), 'the plus button');
const menus = (): Element[] => [...document.querySelectorAll('[data-testid="composer-add-menu"]')];

/** Counts how many times a menu element is ADDED to the document, so a double mount cannot hide. */
const countMounts = (): { readonly count: () => number; readonly stop: () => void } => {
  let added = 0;
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches('[data-testid="composer-add-menu"]')) added += 1;
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return { count: () => added, stop: () => observer.disconnect() };
};

describe('the composer plus menu on a tap', () => {
  test('one tap opens exactly one menu, once, and it stays through resize, scroll and focus changes', async () => {
    const view = await mountComposer(true);
    const watch = countMounts();
    const button = plus(view.container);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(menus()).toHaveLength(0);

    await interact(() => button.click());
    const opened = menus();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.getAttribute('data-variant')).toBe('sheet');
    expect(button.getAttribute('aria-expanded')).toBe('true');

    // The Android keyboard going down fires a resize; scrolling the page fires scroll. The old menu
    // closed itself on both, which is the flicker.
    await interact(() => {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
    });
    await interact(async () => new Promise(resolve => setTimeout(resolve, 60)));
    expect(menus()).toHaveLength(1);
    expect(menus()[0]).toBe(opened[0] as Element);
    expect(watch.count()).toBe(1);

    watch.stop();
    await view.unmount();
  });

  test('a second tap on plus closes it, and a third opens one fresh menu', async () => {
    const view = await mountComposer(false);
    const watch = countMounts();
    const button = plus(view.container);
    await interact(() => button.click());
    expect(menus()[0]?.getAttribute('data-variant')).toBe('popover');
    await interact(() => button.click());
    expect(menus()).toHaveLength(0);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await interact(() => button.click());
    expect(menus()).toHaveLength(1);
    expect(watch.count()).toBe(2);
    watch.stop();
    await view.unmount();
  });

  test('on a phone the keyboard is dismissed first so it cannot cover the sheet', async () => {
    const view = await mountComposer(true);
    const field = must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'the field');
    field.focus();
    expect(document.activeElement).toBe(field);
    await interact(() => plus(view.container).click());
    expect(document.activeElement).not.toBe(field);
    await view.unmount();
  });

  test('choosing Attach files opens the picker and closes the menu', async () => {
    const view = await mountComposer(false);
    const picker = must(
      [...view.container.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(
        input => !input.hasAttribute('capture'),
      ),
      'the file input',
    );
    let picked = 0;
    picker.click = () => {
      picked += 1;
    };
    await interact(() => plus(view.container).click());
    const attach = must(
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(row =>
        row.textContent?.startsWith('Attach files'),
      ),
      'the attach row',
    );
    await interact(() => attach.click());
    expect(picked).toBe(1);
    expect(menus()).toHaveLength(0);
    await view.unmount();
  });

  test('with nothing else to offer, plus goes straight to the picker and no menu exists', async () => {
    const view = await mountComposer(false, false);
    const button = plus(view.container);
    expect(button.hasAttribute('aria-haspopup')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Attach an image, audio or a file');
    await interact(() => button.click());
    expect(menus()).toHaveLength(0);
    await view.unmount();
  });
});
