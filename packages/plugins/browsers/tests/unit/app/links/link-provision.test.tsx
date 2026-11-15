/**
 * "OPEN LINKS IN" (S-0519, shell contract S7): Browsers provides where a tap on an external link opens. The decision
 * (`decideLinkAction`) is pure; the provision carries it out over ports, so a test proves the iOS hand-off, the computer
 * hand-off and its refusal without touching `window`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { deviceControls, type OpenLinksIn } from '@ferretry/app';
import { ensureDom, interact, type Mounted, mount, must } from '@ferretry/app/testing';
import { createElement } from 'react';
import { decideLinkAction, isIosStandalone } from '../../../../app/lib/link-behaviour-model.ts';
import {
  browserLinkOpener,
  COMPUTER_REFUSED_WORDS,
  createLinkProvision,
  type LinkOpener,
  linkProvisionFor,
  SAFARI_HANDOFF_MS,
} from '../../../../app/lib/link-provision.ts';
import { LinkSheetHost, LinkSheetStore } from '../../../../app/lib/link-sheet-host.tsx';
import { recordingClient, refusal } from '../../../support/app/client.ts';

ensureDom();

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const PLAIN = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
const HREF = 'https://docs.example.test/a?b=1';

const click = (over: Partial<typeof PLAIN> = {}) => {
  const event = {
    ...PLAIN,
    ...over,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  return event;
};
const target = (href: string | undefined = HREF, download?: string | boolean) => ({
  href,
  ...(download === undefined ? {} : { download }),
  element: document.createElement('a'),
});

interface Calls {
  readonly tabs: string[];
  readonly handOffs: string[];
  readonly computer: string[];
  readonly waits: number[];
}
const build = (
  setting: OpenLinksIn,
  options: { ios?: boolean; computerRefuses?: boolean } = {},
): { calls: Calls; store: LinkSheetStore; provision: ReturnType<typeof createLinkProvision> } => {
  const calls: Calls = { tabs: [], handOffs: [], computer: [], waits: [] };
  const opener: LinkOpener = {
    iosStandalone: () => options.ios === true,
    handOff: href => calls.handOffs.push(href),
    openTab: href => calls.tabs.push(href),
    unlessLeft: (ms, then) => {
      calls.waits.push(ms);
      then();
      return () => undefined;
    },
  };
  const store = new LinkSheetStore();
  const provision = createLinkProvision(
    {
      setting: () => setting,
      opener,
      openOnComputer: async href => {
        calls.computer.push(href);
        if (options.computerRefuses === true) throw new Error('403');
      },
    },
    store,
  );
  return { calls, store, provision };
};
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('the decision', () => {
  const input = { activation: PLAIN, href: HREF, iosStandalone: false } as const;

  it('S-0519 browser leaves a plain tap to the anchor; panel opens the preview; computer asks this computer', () => {
    expect(decideLinkAction({ ...input, setting: 'browser' }).kind).toBe('native');
    expect(decideLinkAction({ ...input, setting: 'panel' }).kind).toBe('panel');
    expect(decideLinkAction({ ...input, setting: 'computer' })).toEqual({ kind: 'computer', href: HREF });
  });

  it('S-0519 keeps a modified click, a middle click, a download and a non-web address the browser’s own', () => {
    for (const setting of ['browser', 'panel', 'computer'] as const) {
      expect(decideLinkAction({ ...input, setting, activation: { ...PLAIN, metaKey: true } }).kind).toBe('native');
      expect(decideLinkAction({ ...input, setting, activation: { ...PLAIN, button: 1 } }).kind).toBe('native');
      expect(decideLinkAction({ ...input, setting, download: 'a.zip' }).kind).toBe('native');
      expect(decideLinkAction({ ...input, setting, href: 'mailto:a@b.test' }).kind).toBe('native');
    }
  });

  it('S-0519 hands an address to the real Safari from the installed iOS app, and only under "Your browser"', () => {
    expect(decideLinkAction({ ...input, setting: 'browser', iosStandalone: true })).toEqual({
      kind: 'safari',
      href: `x-safari-${HREF}`,
      fallback: HREF,
    });
    expect(decideLinkAction({ ...input, setting: 'panel', iosStandalone: true }).kind).toBe('panel');
  });

  it('knows an installed iPhone, an installed iPad that says it is a Mac, and a desktop', () => {
    const base = { userAgent: '', maxTouchPoints: 0, standaloneDisplay: true };
    expect(isIosStandalone({ ...base, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })).toBe(true);
    expect(isIosStandalone({ ...base, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', maxTouchPoints: 5 })).toBe(
      true,
    );
    expect(isIosStandalone({ ...base, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' })).toBe(false);
  });
});

describe('what Browsers provides for one machine', () => {
  it('S-0519 "Your browser" handles nothing: the anchor opens its own tab', () => {
    const { provision, calls } = build('browser');
    const tap = click();
    expect(provision.activate(tap, target())).toBe(false);
    expect(tap.defaultPrevented).toBe(false);
    expect(calls.tabs).toEqual([]);
  });

  it('S-0519 the side panel takes the tap, opens the preview and says so before it happens', () => {
    const { provision, store } = build('panel');
    const tap = click();
    expect(provision.activate(tap, target())).toBe(true);
    expect(tap.defaultPrevented).toBe(true);
    expect(store.snapshot()).toMatchObject({ open: true, destination: { href: HREF } });
    expect(provision.destination(HREF)).toBe('in-app');
    expect(provision.anchor?.(HREF)).toEqual({ popup: 'dialog' });
  });

  it('S-0519 the computer setting asks this machine’s daemon and opens nothing here when it does', async () => {
    const { provision, calls, store } = build('computer');
    expect(provision.destination(HREF)).toBe('computer');
    expect(provision.activate(click(), target())).toBe(true);
    await settle();
    expect(calls.computer).toEqual([HREF]);
    expect(calls.tabs).toEqual([]);
    expect(store.snapshot().notice).toBe('');
  });

  it('S-0519 a daemon that is not on this computer refuses: the link opens here and the page says why', async () => {
    const { provision, calls, store } = build('computer', { computerRefuses: true });
    expect(provision.activate(click(), target())).toBe(true);
    await settle();
    expect(calls.tabs).toEqual([HREF]);
    expect(store.snapshot().notice).toBe(COMPUTER_REFUSED_WORDS);
  });

  it('S-0519 a failed hand-off shows a visible, dismissible notice and keeps the polite announcement; a success shows none', async () => {
    const { LinkSheetHost } = await import('../../../../app/lib/link-sheet-host.tsx');
    const refused = build('computer', { computerRefuses: true });
    mounted = await mount(<LinkSheetHost Sheet={() => null} store={refused.store} />);
    const region = must(mounted.container.querySelector('[data-link-notice]'), 'the announcement');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(mounted.container.querySelector('[data-link-notice-visible]')).toBeNull();
    await interact(() => {
      refused.provision.activate(click(), target());
    });
    await settle();
    await interact(() => undefined);
    const visible = must(region.querySelector('[data-link-notice-visible]'), 'the visible notice');
    expect(visible.textContent).toContain(COMPUTER_REFUSED_WORDS);
    expect(visible.textContent).not.toContain(HREF);
    expect(region.className).not.toContain('sr-only');
    await interact(() => must(region.querySelector<HTMLElement>('[data-link-notice-dismiss]'), 'dismiss').click());
    expect(mounted.container.querySelector('[data-link-notice-visible]')).toBeNull();
    expect(region.textContent).toBe('');
    await mounted.unmount();

    const accepted = build('computer');
    mounted = await mount(<LinkSheetHost Sheet={() => null} store={accepted.store} />);
    await interact(() => {
      accepted.provision.activate(click(), target());
    });
    await settle();
    await interact(() => undefined);
    expect(mounted.container.querySelector('[data-link-notice-visible]')).toBeNull();
    expect(mounted.container.querySelector('[data-link-notice]')?.textContent).toBe('');
  });

  it('S-0519 the installed iOS app hands "Your browser" links to Safari, with a tab as the fallback', () => {
    const { provision, calls } = build('browser', { ios: true });
    expect(provision.activate(click(), target())).toBe(true);
    expect(calls.handOffs).toEqual([`x-safari-${HREF}`]);
    expect(calls.waits).toEqual([SAFARI_HANDOFF_MS]);
    expect(calls.tabs).toEqual([HREF]);
  });

  it('S-0519 `open` (an address with no anchor, such as a terminal link) falls back to a new tab', () => {
    const { provision, calls } = build('browser');
    const event = click();
    provision.open(event, { href: HREF, element: document.createElement('a') });
    expect(calls.tabs).toEqual([HREF]);
  });

  it('S-0519 changing the setting changes the very next tap: nothing is held', () => {
    let setting: OpenLinksIn = 'browser';
    const store = new LinkSheetStore();
    const provision = createLinkProvision(
      {
        setting: () => setting,
        opener: {
          iosStandalone: () => false,
          handOff: () => undefined,
          openTab: () => undefined,
          unlessLeft: () => () => undefined,
        },
        openOnComputer: async () => undefined,
      },
      store,
    );
    expect(provision.activate(click(), target())).toBe(false);
    setting = 'panel';
    expect(provision.activate(click(), target())).toBe(true);
  });

  it('draws one sheet element per machine', () => {
    const { provision } = build('panel');
    expect(provision.sheet).toBeTruthy();
    expect(createElement('div')).toBeTruthy();
  });
});

/** A window as `browserLinkOpener` reads it: only what it touches, with every effect recorded. */
const fakeWindow = (
  over: {
    readonly navigator?: Partial<Navigator> & { readonly standalone?: boolean };
    readonly matchMedia?: ((query: string) => { readonly matches: boolean }) | undefined;
    readonly visibility?: DocumentVisibilityState;
  } = {},
) => {
  const log = { assigned: [] as string[], opened: [] as unknown[][], listeners: new Map<string, Set<() => void>>() };
  const add = (type: string, fn: () => void): void => {
    log.listeners.set(type, (log.listeners.get(type) ?? new Set()).add(fn));
  };
  const remove = (type: string, fn: () => void): void => {
    log.listeners.get(type)?.delete(fn);
  };
  const doc = { visibilityState: over.visibility ?? 'visible', addEventListener: add, removeEventListener: remove };
  const win = {
    navigator: over.navigator ?? { userAgent: 'Mozilla/5.0 (X11; Linux)', maxTouchPoints: 0 },
    ...('matchMedia' in over ? { matchMedia: over.matchMedia } : { matchMedia: () => ({ matches: false }) }),
    location: { assign: (href: string) => log.assigned.push(href) },
    open: (...args: unknown[]) => log.opened.push(args),
    document: doc,
    addEventListener: add,
    removeEventListener: remove,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
  return { win: win as unknown as Window, doc, log };
};
const listening = (log: ReturnType<typeof fakeWindow>['log']): number =>
  [...log.listeners.values()].reduce((sum, set) => sum + set.size, 0);

describe('the real browser as a link opener', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';

  it('reads "installed iOS app" from the navigator flag, the display mode, and says no for a desktop', () => {
    const flagged = fakeWindow({ navigator: { userAgent: IPHONE, maxTouchPoints: 5, standalone: true } });
    expect(browserLinkOpener(flagged.win).iosStandalone()).toBe(true);
    const displayMode = fakeWindow({
      navigator: { userAgent: IPHONE, maxTouchPoints: 5 },
      matchMedia: query => ({ matches: query === '(display-mode: standalone)' }),
    });
    expect(browserLinkOpener(displayMode.win).iosStandalone()).toBe(true);
    const tab = fakeWindow({ navigator: { userAgent: IPHONE, maxTouchPoints: 5, standalone: false } });
    expect(browserLinkOpener(tab.win).iosStandalone()).toBe(false);
    expect(browserLinkOpener(fakeWindow().win).iosStandalone()).toBe(false);
  });

  it('treats a browser with no matchMedia and no touch points as not installed, never as an error', () => {
    const bare = fakeWindow({ navigator: { userAgent: IPHONE }, matchMedia: undefined });
    expect(browserLinkOpener(bare.win).iosStandalone()).toBe(false);
  });

  it('answers "not installed" when the navigator cannot be read', () => {
    const broken = {
      get navigator(): never {
        throw new Error('no navigator');
      },
    } as unknown as Window;
    expect(browserLinkOpener(broken).iosStandalone()).toBe(false);
  });

  it('hands off by navigating, and opens a tab with no opener and no referrer', () => {
    const { win, log } = fakeWindow();
    const opener = browserLinkOpener(win);
    opener.handOff('x-safari-https://docs.example.test/');
    opener.openTab(HREF);
    expect(log.assigned).toEqual(['x-safari-https://docs.example.test/']);
    expect(log.opened).toEqual([[HREF, '_blank', 'noopener,noreferrer']]);
  });

  it('runs the fallback when the page stayed put, and lets go of every listener afterwards', async () => {
    const { win, log } = fakeWindow();
    let ran = 0;
    browserLinkOpener(win).unlessLeft(5, () => {
      ran += 1;
    });
    expect(listening(log)).toBe(3);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ran).toBe(1);
    expect(listening(log)).toBe(0);
  });

  it('skips the fallback when the page lost focus or was put away: the hand-off worked', async () => {
    for (const event of ['blur', 'pagehide'] as const) {
      const { win, log } = fakeWindow();
      let ran = 0;
      browserLinkOpener(win).unlessLeft(5, () => {
        ran += 1;
      });
      for (const fn of log.listeners.get(event) ?? []) fn();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(ran).toBe(0);
    }
    const hidden = fakeWindow();
    let ran = 0;
    browserLinkOpener(hidden.win).unlessLeft(5, () => {
      ran += 1;
    });
    hidden.doc.visibilityState = 'hidden';
    for (const fn of hidden.log.listeners.get('visibilitychange') ?? []) fn();
    hidden.doc.visibilityState = 'visible';
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ran).toBe(0);
  });

  it('ignores a visibility change that leaves the page visible, but a page that is hidden at the deadline falls through', async () => {
    const visible = fakeWindow();
    let ran = 0;
    browserLinkOpener(visible.win).unlessLeft(5, () => {
      ran += 1;
    });
    for (const fn of visible.log.listeners.get('visibilitychange') ?? []) fn();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ran).toBe(1);
    const late = fakeWindow();
    browserLinkOpener(late.win).unlessLeft(5, () => {
      ran += 1;
    });
    late.doc.visibilityState = 'hidden';
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ran).toBe(1);
  });

  it('cancelling stops the timer and removes every listener', async () => {
    const { win, log } = fakeWindow();
    let ran = 0;
    const cancel = browserLinkOpener(win).unlessLeft(5, () => {
      ran += 1;
    });
    cancel();
    expect(listening(log)).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ran).toBe(0);
  });

  it('defaults to the page’s own window', () => {
    expect(browserLinkOpener().iosStandalone()).toBe(false);
  });
});

describe('the live provision for one machine', () => {
  const previous = deviceControls().snapshot().device.openLinksIn;
  afterEach(() => {
    deviceControls().setDeviceControls({ openLinksIn: previous });
  });

  it('S-0519 reads this device’s choice at the tap and asks THIS machine’s daemon to open the address', async () => {
    const { client, calls } = recordingClient(() => undefined);
    const provision = linkProvisionFor({ client } as unknown as Parameters<typeof linkProvisionFor>[0]);
    deviceControls().setDeviceControls({ openLinksIn: 'computer' });
    expect(provision.destination(HREF)).toBe('computer');
    expect(provision.activate(click(), target())).toBe(true);
    await settle();
    expect(calls).toEqual([{ route: 'POST /v1/system/open-url', init: { body: { url: HREF } } }]);
    deviceControls().setDeviceControls({ openLinksIn: 'browser' });
    expect(provision.activate(click(), target())).toBe(false);
  });

  it('S-0519 a refusal from the daemon opens the link in a tab of this browser', async () => {
    const { client } = recordingClient(() => refusal(403, 'not on the host'));
    const opened: unknown[][] = [];
    const real = window.open;
    window.open = ((...args: unknown[]) => opened.push(args)) as unknown as typeof window.open;
    try {
      const provision = linkProvisionFor({ client } as unknown as Parameters<typeof linkProvisionFor>[0]);
      deviceControls().setDeviceControls({ openLinksIn: 'computer' });
      expect(provision.activate(click(), target())).toBe(true);
      await settle();
      expect(opened).toEqual([[HREF, '_blank', 'noopener,noreferrer']]);
    } finally {
      window.open = real;
    }
  });
});

describe('closing the preview', () => {
  it('S-0519 the sheet’s own close puts the preview away and keeps what it showed', async () => {
    const { provision, store } = build('panel');
    let close: () => void = () => undefined;
    mounted = await mount(
      <LinkSheetHost
        Sheet={props => {
          close = props.onClose;
          return <span data-sheet-open={String(props.open)} />;
        }}
        store={store}
      />,
    );
    await interact(() => {
      provision.activate(click(), target());
    });
    expect(mounted.container.querySelector('[data-sheet-open="true"]')).not.toBeNull();
    await interact(() => close());
    expect(store.snapshot()).toMatchObject({ open: false, destination: { href: HREF } });
    expect(mounted.container.querySelector('[data-sheet-open="false"]')).not.toBeNull();
  });
});
