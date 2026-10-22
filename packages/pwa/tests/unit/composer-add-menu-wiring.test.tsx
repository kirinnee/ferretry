import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Composer } from '../../src/components/composer.tsx';
import { LocationShareContext } from '../../src/hooks/use-location-share.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import type { LocationFix, LocationShareHost } from '../../src/lib/location-share.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

// A failed assertion must not leave a mounted composer listening on the window for the next file.
const live = new Set<Mounted>();
beforeEach(() => writeMdComposePref('off'));
afterEach(async () => {
  writeMdComposePref('on');
  for (const view of live) await view.unmount();
  live.clear();
});

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

const mountComposer = async (compact: boolean, withHost = true, offerCamera?: boolean): Promise<Mounted> => {
  const view = await mount(
    <LocationShareContext.Provider value={withHost ? host : null}>
      <Composer
        api={{ send: async () => ({}) as never }}
        compact={compact}
        offerCamera={offerCamera}
        daemon={daemon}
        draftStore={new DaemonDraftStore(new MemoryStorage())}
        sessionId="s1"
      />
    </LocationShareContext.Provider>,
  );
  const tracked: Mounted = {
    ...view,
    unmount: async () => {
      live.delete(tracked);
      await view.unmount();
    },
  };
  live.add(tracked);
  return tracked;
};

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

  const fileInputs = (root: HTMLElement) => {
    const all = [...root.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    return {
      picker: must(
        all.find(input => !input.hasAttribute('capture')),
        'the file input',
      ),
      camera: all.find(input => input.hasAttribute('capture')),
    };
  };

  test('with neither a camera nor a host there is one thing to do, so plus goes straight to the picker', async () => {
    const view = await mountComposer(false, false, false);
    const button = plus(view.container);
    expect(button.hasAttribute('aria-haspopup')).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Attach an image, audio or a file');
    let picked = 0;
    fileInputs(view.container).picker.click = () => {
      picked += 1;
    };
    await interact(() => button.click());
    expect(picked).toBe(1);
    expect(menus()).toHaveLength(0);
    await view.unmount();
  });

  test('a camera without a host still makes a menu, and it offers no location', async () => {
    const view = await mountComposer(false, false, true);
    await interact(() => plus(view.container).click());
    expect(menus()).toHaveLength(1);
    expect(menus()[0]?.textContent).toContain('Take photo');
    expect(menus()[0]?.textContent).not.toContain('Share location');
    await view.unmount();
  });

  test('Take photo hands over to the camera input, and what it returns joins the tray', async () => {
    const created = URL.createObjectURL;
    URL.createObjectURL = (() => 'blob:camera/1') as typeof URL.createObjectURL;
    try {
      const view = await mountComposer(false, false, true);
      const camera = must(fileInputs(view.container).camera, 'the camera input');
      let opened = 0;
      camera.click = () => {
        opened += 1;
      };
      await interact(() => plus(view.container).click());
      const row = must(
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item =>
          item.textContent?.startsWith('Take photo'),
        ),
        'the camera row',
      );
      await interact(() => row.click());
      expect(opened).toBe(1);

      Object.defineProperty(camera, 'files', {
        configurable: true,
        value: [new File([new Uint8Array([1, 2])], 'snap.jpg', { type: 'image/jpeg' })],
      });
      await interact(() => {
        camera.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(view.container.querySelector('[aria-label="Remove snap.jpg"]')).not.toBeNull();
      await view.unmount();
    } finally {
      URL.createObjectURL = created;
    }
  });

  test('a chosen document opens from the local file in a new tab, not from anywhere on the network', async () => {
    const created = URL.createObjectURL;
    const revoked = URL.revokeObjectURL;
    const opener = window.open;
    const setTimer = window.setTimeout;
    const opened: unknown[][] = [];
    const revocations: string[] = [];
    const timers: Array<() => void> = [];
    URL.createObjectURL = (() => 'blob:local/doc') as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revocations.push(url);
    }) as typeof URL.revokeObjectURL;
    window.open = ((...args: unknown[]) => {
      opened.push(args);
      return null;
    }) as typeof window.open;
    window.setTimeout = ((fn: () => void, ms?: number) => {
      if (ms !== 60_000) return setTimer(fn, ms);
      timers.push(fn);
      return 0;
    }) as unknown as typeof window.setTimeout;
    try {
      const view = await mountComposer(false, false, false);
      const picker = fileInputs(view.container).picker;
      Object.defineProperty(picker, 'files', {
        configurable: true,
        value: [new File([new Uint8Array([1])], 'plan.pdf', { type: 'application/pdf' })],
      });
      await interact(() => {
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await interact(() =>
        must(view.container.querySelector<HTMLElement>('[aria-label="Open plan.pdf"]'), 'chip').click(),
      );
      expect(opened).toEqual([['blob:local/doc', '_blank', 'noopener,noreferrer']]);
      for (const run of timers) run();
      expect(revocations).toEqual(['blob:local/doc']);
      await view.unmount();
    } finally {
      URL.createObjectURL = created;
      URL.revokeObjectURL = revoked;
      window.open = opener;
      window.setTimeout = setTimer;
    }
  });
});
