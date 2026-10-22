/**
 * Settings › Appearance › "Open links in", through the one external link every surface draws. The
 * browser is a fake `LinkOpener`, so the iOS hand-off is proved without navigating anything; the
 * decision table itself is `link-behaviour-model.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { Markdown } from '../../../src/components/markdown.tsx';
import {
  browserLinkOpener,
  ExternalLink,
  LinkBehaviourProvider,
  type LinkOpener,
  SAFARI_HANDOFF_MS,
} from '../../../src/features/browser/external-link.tsx';
import { InAppBrowserWorkspace } from '../../../src/features/browser/in-app-browser.tsx';
import type { OpenLinksIn } from '../../../src/lib/controls.ts';
import { interact, mount, must } from '../../support/dom.ts';

const DOCS = 'https://docs.example.test/getting-started';

interface FakeOpener extends LinkOpener {
  readonly handedOff: string[];
  readonly tabs: string[];
  readonly waits: number[];
  /** Fires the pending fallback, as a hand-off that went nowhere would. */
  readonly expire: () => void;
}

const fakeOpener = (iosStandalone: boolean): FakeOpener => {
  const handedOff: string[] = [];
  const tabs: string[] = [];
  const waits: number[] = [];
  let pending: (() => void) | null = null;
  return {
    handedOff,
    tabs,
    waits,
    iosStandalone: () => iosStandalone,
    handOff: href => handedOff.push(href),
    openTab: href => tabs.push(href),
    unlessLeft: (ms, then) => {
      waits.push(ms);
      pending = then;
      return () => {
        pending = null;
      };
    },
    expire: () => pending?.(),
  };
};

/** Whether OUR handler took the click: read on the body, before the suite's own guard prevents it. */
let prevented: boolean[] = [];
const record = (event: Event): void => {
  if (event.type === 'click') prevented.push(event.defaultPrevented);
};
const preventBrowserNavigation = (event: MouseEvent): void => {
  if (event.target instanceof HTMLAnchorElement) event.preventDefault();
};
let originalFetch: typeof fetch;

beforeEach(() => {
  prevented = [];
  originalFetch = globalThis.fetch;
  // The preview's iframe is the browser integration's; this suite asserts where a click goes.
  globalThis.fetch = (async () => new Response('browser fixture', { status: 200 })) as unknown as typeof fetch;
  document.body.addEventListener('click', record);
  // A native click on a `_blank` anchor must not become a real navigation in happy-dom.
  document.addEventListener('click', preventBrowserNavigation);
});

afterEach(() => {
  document.body.removeEventListener('click', record);
  document.removeEventListener('click', preventBrowserNavigation);
  globalThis.fetch = originalFetch;
});

const withSetting = (openLinksIn: OpenLinksIn, opener: LinkOpener, children: ReactNode) => (
  <LinkBehaviourProvider openLinksIn={openLinksIn} opener={opener}>
    {children}
  </LinkBehaviourProvider>
);

const modifiedClick = (init: MouseEventInit) => new MouseEvent('click', { bubbles: true, cancelable: true, ...init });

describe('ExternalLink — Your browser (the default)', () => {
  it('is a real new-tab anchor that leaves an ordinary click to the browser', async () => {
    const opener = fakeOpener(false);
    const view = await mount(withSetting('browser', opener, <ExternalLink href={DOCS}>Docs</ExternalLink>));
    try {
      const link = must(view.container.querySelector('a'), 'the link');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('aria-haspopup')).toBeNull();
      expect(link.getAttribute('aria-controls')).toBeNull();
      await interact(() => link.click());
      expect(prevented).toEqual([false]);
      expect(opener.handedOff).toEqual([]);
      expect(opener.tabs).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  it('opens links in the browser with no provider at all', async () => {
    const view = await mount(<ExternalLink href={DOCS}>Docs</ExternalLink>);
    try {
      await interact(() => must(view.container.querySelector('a'), 'the link').click());
      expect(prevented).toEqual([false]);
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('hands an ordinary tap in the installed iOS app to the real Safari app', async () => {
    const opener = fakeOpener(true);
    const clicks: string[] = [];
    const view = await mount(
      withSetting(
        'browser',
        opener,
        <ExternalLink href={DOCS} onClick={() => clicks.push('own handler')}>
          Docs
        </ExternalLink>,
      ),
    );
    try {
      await interact(() => must(view.container.querySelector('a'), 'the link').click());
      expect(clicks).toEqual(['own handler']);
      expect(prevented).toEqual([true]);
      expect(opener.handedOff).toEqual([`x-safari-${DOCS}`]);
      expect(opener.waits).toEqual([SAFARI_HANDOFF_MS]);
      // Nothing opens a tab while the hand-off may still be working…
      expect(opener.tabs).toEqual([]);
      // …and a hand-off that went nowhere falls back to a plain new tab.
      opener.expire();
      expect(opener.tabs).toEqual([DOCS]);
    } finally {
      await view.unmount();
    }
  });

  it('keeps a Cmd-click native in the iOS app too', async () => {
    const opener = fakeOpener(true);
    const view = await mount(withSetting('browser', opener, <ExternalLink href={DOCS}>Docs</ExternalLink>));
    try {
      await interact(() =>
        must(view.container.querySelector('a'), 'the link').dispatchEvent(modifiedClick({ metaKey: true })),
      );
      expect(prevented).toEqual([false]);
      expect(opener.handedOff).toEqual([]);
    } finally {
      await view.unmount();
    }
  });
});

describe('ExternalLink — Ferretry side panel', () => {
  it('opens beside the conversation on a desktop, and says so before the tap', async () => {
    const opener = fakeOpener(true);
    const view = await mount(
      withSetting(
        'panel',
        opener,
        <InAppBrowserWorkspace compact={false}>
          <ExternalLink href={DOCS}>Docs</ExternalLink>
        </InAppBrowserWorkspace>,
      ),
    );
    try {
      const link = must(view.container.querySelector('a'), 'the link');
      expect(link.getAttribute('aria-controls')).toContain('in-app-browser-pane-');
      expect(link.getAttribute('aria-haspopup')).toBeNull();
      await interact(() => link.click());
      expect(prevented).toEqual([true]);
      expect(must(view.container.querySelector('aside'), 'the side pane').textContent).toContain(DOCS);
      // The panel is the choice even in the iOS app: Safari is never involved.
      expect(opener.handedOff).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  it('opens a sheet on a phone', async () => {
    const view = await mount(
      withSetting(
        'panel',
        fakeOpener(false),
        <InAppBrowserWorkspace compact>
          <ExternalLink href={DOCS}>Docs</ExternalLink>
        </InAppBrowserWorkspace>,
      ),
    );
    try {
      const link = must(view.container.querySelector('a'), 'the link');
      expect(link.getAttribute('aria-haspopup')).toBe('dialog');
      await interact(() => link.click());
      expect(view.container.querySelector('aside')).toBeNull();
      expect(must(view.container.querySelector('[aria-live="polite"]'), 'the live region').textContent).toBe(
        `Opened link preview: ${DOCS}`,
      );
    } finally {
      await view.unmount();
    }
  });

  it('portals its own sheet where no workspace hosts it, and closes it again', async () => {
    const view = await mount(
      withSetting('panel', fakeOpener(false), <ExternalLink href="https://docs.example.test/solo">Solo</ExternalLink>),
    );
    try {
      const link = must(view.container.querySelector('a'), 'the link');
      expect(link.getAttribute('aria-haspopup')).toBe('dialog');
      await interact(() => link.click());
      expect(document.body.textContent).toContain('https://docs.example.test/solo');
      const done = must(
        [...document.body.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Done'),
        'the Done button',
      );
      await interact(() => done.click());
      expect(prevented[0]).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it('keeps a modified click, a download and a non-web scheme native', async () => {
    const view = await mount(
      withSetting(
        'panel',
        fakeOpener(false),
        <InAppBrowserWorkspace compact={false}>
          <ExternalLink href={DOCS}>Docs</ExternalLink>
          <ExternalLink href="https://docs.example.test/report.pdf" download="report.pdf">
            Report
          </ExternalLink>
          <ExternalLink href="blob:https://app.example.test/1234">File</ExternalLink>
        </InAppBrowserWorkspace>,
      ),
    );
    try {
      const [docs, report, file] = [...view.container.querySelectorAll('a')];
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }])
        await interact(() => must(docs, 'the docs link').dispatchEvent(modifiedClick(modifier)));
      await interact(() => must(report, 'the download').click());
      await interact(() => must(file, 'the blob link').click());
      expect(prevented).toEqual([false, false, false, false, false, false]);
      expect(view.container.querySelector('aside')).toBeNull();
      expect(must(file, 'the blob link').getAttribute('aria-haspopup')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});

describe('chat Markdown links', () => {
  it('open in the browser by default', async () => {
    const opener = fakeOpener(false);
    const view = await mount(
      withSetting(
        'browser',
        opener,
        <InAppBrowserWorkspace compact={false}>
          <Markdown text={`Read [the guide](${DOCS}) first.`} />
        </InAppBrowserWorkspace>,
      ),
    );
    try {
      const link = must(view.container.querySelector('.md a'), 'the Markdown link');
      expect(link.getAttribute('href')).toBe(DOCS);
      expect(link.getAttribute('target')).toBe('_blank');
      await interact(() => (link as HTMLAnchorElement).click());
      expect(prevented).toEqual([false]);
      expect(view.container.querySelector('aside')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('open the side panel beside the chat when it is chosen', async () => {
    const view = await mount(
      withSetting(
        'panel',
        fakeOpener(false),
        <InAppBrowserWorkspace compact={false}>
          <Markdown text={`Read [the guide](${DOCS}) first.`} />
        </InAppBrowserWorkspace>,
      ),
    );
    try {
      await interact(() => must(view.container.querySelector<HTMLAnchorElement>('.md a'), 'the Markdown link').click());
      expect(prevented).toEqual([true]);
      expect(must(view.container.querySelector('aside'), 'the side pane').textContent).toContain(DOCS);
    } finally {
      await view.unmount();
    }
  });
});

describe('browserLinkOpener', () => {
  /** A window with just enough surface: events, timers, a location and `open`. */
  const fakeWindow = (overrides: {
    readonly userAgent?: string;
    readonly maxTouchPoints?: number;
    readonly standalone?: boolean;
    readonly standaloneDisplay?: boolean;
    readonly matchMedia?: null;
  }) => {
    const events = new EventTarget();
    const documentEvents = new EventTarget();
    const assigned: string[] = [];
    const opened: unknown[][] = [];
    const document = Object.assign(documentEvents, { visibilityState: 'visible' as DocumentVisibilityState });
    const win = Object.assign(events, {
      document,
      navigator: {
        userAgent: overrides.userAgent ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        maxTouchPoints: overrides.maxTouchPoints ?? 5,
        ...(overrides.standalone === undefined ? {} : { standalone: overrides.standalone }),
      },
      ...(overrides.matchMedia === null
        ? {}
        : { matchMedia: () => ({ matches: overrides.standaloneDisplay ?? false }) }),
      location: { assign: (href: string) => assigned.push(href) },
      open: (...args: unknown[]) => {
        opened.push(args);
        return null;
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    return { win: win as unknown as Window, document, assigned, opened };
  };

  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  it('reads the installed iOS app from navigator.standalone or the display mode', () => {
    expect(browserLinkOpener(fakeWindow({ standalone: true }).win).iosStandalone()).toBe(true);
    expect(browserLinkOpener(fakeWindow({ standaloneDisplay: true }).win).iosStandalone()).toBe(true);
    expect(browserLinkOpener(fakeWindow({ standalone: false }).win).iosStandalone()).toBe(false);
    expect(browserLinkOpener(fakeWindow({ matchMedia: null }).win).iosStandalone()).toBe(false);
    expect(
      browserLinkOpener(
        fakeWindow({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', standaloneDisplay: true }).win,
      ).iosStandalone(),
    ).toBe(false);
  });

  it('answers "not standalone" when the browser refuses to be read', () => {
    const hostile = {
      get navigator(): never {
        throw new Error('denied');
      },
    } as unknown as Window;
    expect(browserLinkOpener(hostile).iosStandalone()).toBe(false);
  });

  it('hands off by navigating and opens a tab without an opener', () => {
    const { win, assigned, opened } = fakeWindow({});
    const opener = browserLinkOpener(win);
    opener.handOff(`x-safari-${DOCS}`);
    opener.openTab(DOCS);
    expect(assigned).toEqual([`x-safari-${DOCS}`]);
    expect(opened).toEqual([[DOCS, '_blank', 'noopener,noreferrer']]);
  });

  it('falls back only when the page is still in front after the wait', async () => {
    const stayed = fakeWindow({});
    let fallbacks = 0;
    browserLinkOpener(stayed.win).unlessLeft(5, () => (fallbacks += 1));
    await wait(20);
    expect(fallbacks).toBe(1);

    for (const leave of [
      (target: ReturnType<typeof fakeWindow>) => target.win.dispatchEvent(new Event('blur')),
      (target: ReturnType<typeof fakeWindow>) => target.win.dispatchEvent(new Event('pagehide')),
      (target: ReturnType<typeof fakeWindow>) => {
        target.document.visibilityState = 'hidden';
        target.document.dispatchEvent(new Event('visibilitychange'));
      },
    ]) {
      const left = fakeWindow({});
      let fired = 0;
      browserLinkOpener(left.win).unlessLeft(5, () => (fired += 1));
      leave(left);
      await wait(20);
      expect(fired).toBe(0);
    }

    const cancelled = fakeWindow({});
    let late = 0;
    const cancel = browserLinkOpener(cancelled.win).unlessLeft(5, () => (late += 1));
    cancel();
    await wait(20);
    expect(late).toBe(0);
  });
});
