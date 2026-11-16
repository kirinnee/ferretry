/**
 * A link in a live shell opens through the app's one link behaviour (`useLinkBehaviour` from `@ferretry/app/ui`)
 * — the same decision every chat link uses — and never anywhere a program merely asked for. The emulator is the spy
 * from `support/terminal-deck.ts`: it records the link provider and the OSC 8 handler the deck registered, so the
 * click path (provider → `useLinkBehaviour`) runs for real and no canvas is needed. The shell's behaviour today is
 * the reader's own browser, a new tab with no opener; where Settings › "Open links in" sends a link instead is the
 * Browsers half's to provide and to test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionTerminalDeck } from '../../../app/components/session-terminal-deck.tsx';
import { daemonConnection, daemonSessionScope } from '../../../app/shell.ts';
import type { LinkClick } from '../../../app/lib/terminal-links.ts';
import { interact, mount, must, ensureDom } from '@ferretry/app/testing';
import { fakeDeck, terminalListing, terminalView, xtermSpy } from '../../support/app/terminal-deck.ts';
import { terminalBuffer } from '../../support/app/terminal-buffer.ts';

// These suites read the document directly; register one before any hook or test runs.
ensureDom();

const connection = daemonConnection('alpha');
const scope = daemonSessionScope(connection, 'shared');
const SHELL = 'a1b2c3d4e5f6';
const URL_ON_SCREEN = 'https://docs.example.test/getting-started';

/** The new tabs the page asked for: the app's link behaviour opens one with `window.open`, never with an opener. */
const fakeOpener = () => {
  const tabs: string[] = [];
  const previous = globalThis.open;
  globalThis.open = ((href?: string | URL) => {
    tabs.push(String(href));
    return null;
  }) as typeof globalThis.open;
  const restore = (): void => {
    globalThis.open = previous;
  };
  return { tabs, restore };
};

/** A click as the browser makes it: a tap produces the same one, a modifier key aside. */
const click = (init: Partial<LinkClick> = {}): LinkClick => ({
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  preventDefault: () => {},
  ...init,
});

let originalFetch: typeof fetch;
let opened: ReturnType<typeof fakeOpener> | undefined;
beforeEach(() => {
  opened = fakeOpener();
  originalFetch = globalThis.fetch;
  // The preview's iframe is the browser integration's; this suite asserts where a click goes.
  globalThis.fetch = (async () => new Response('browser fixture', { status: 200 })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  opened?.restore();
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
};

interface Opened {
  readonly page: Awaited<ReturnType<typeof mount>>;
  readonly deck: ReturnType<typeof fakeDeck>;
  readonly spy: ReturnType<typeof xtermSpy>;
  readonly opened: { readonly tabs: string[] };
  /** The link the screen shows, as xterm hands it to a click. */
  readonly screenLink: () => { activate(click: LinkClick, text: string): void; text: string };
}

const openDeck = async (options: { readonly rows?: string[] } = {}): Promise<Opened> => {
  const spy = xtermSpy({ buffer: terminalBuffer(options.rows ?? [`read ${URL_ON_SCREEN} now`], 80) });
  const deck = fakeDeck(async () => terminalListing([terminalView(SHELL)]), { loadXterm: async () => spy.modules });
  const page = await mount(
    <SessionTerminalDeck connection={connection} dependencies={deck.dependencies} scope={scope} />,
  );
  await settle();
  const screenLink = () => {
    const provider = must(spy.instances[0]?.links.providers[0], 'the registered link provider');
    let found: ReturnType<Opened['screenLink']> | undefined;
    provider.provideLinks(1, links => {
      found = links?.[0];
    });
    return must(found, 'a link on the first row');
  };
  return { page, deck, spy, opened: must(opened, 'the new-tab spy'), screenLink };
};

describe('SessionTerminalDeck — links', () => {
  it('registers one link provider and the OSC 8 handler on the emulator', async () => {
    const { page, spy } = await openDeck();
    try {
      expect(spy.instances).toHaveLength(1);
      expect(spy.instances[0]?.links.providers).toHaveLength(1);
      expect(spy.instances[0]?.links.handler?.allowNonHttpProtocols).toBe(false);
    } finally {
      await page.unmount();
    }
  });

  it('offers the address on screen as a link', async () => {
    const { page, screenLink } = await openDeck();
    try {
      expect(screenLink().text).toBe(URL_ON_SCREEN);
    } finally {
      await page.unmount();
    }
  });

  describe('a click', () => {
    it('Your browser: a new tab, since there is no anchor to carry it', async () => {
      const { page, screenLink, opened } = await openDeck();
      try {
        await interact(() => screenLink().activate(click(), URL_ON_SCREEN));
        expect(opened.tabs).toEqual([URL_ON_SCREEN]);
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      } finally {
        await page.unmount();
      }
    });
  });

  describe('a link the program broke across two rows', () => {
    // The fake emulator is 80 columns wide, so the first row runs to exactly the last one.
    const HEAD = `see https://docs.example.test/${'a'.repeat(80 - 'see https://docs.example.test/'.length - 1)}/`;
    const TAIL = 'path/to/page?x=1';
    const FULL = `${HEAD.slice(4)}${TAIL}`;
    const rows = [HEAD, TAIL];

    it('is one link whose click opens the whole address, from either row', async () => {
      const { page, spy, opened } = await openDeck({ rows });
      try {
        const provider = must(spy.instances[0]?.links.providers[0], 'the registered link provider');
        for (const row of [1, 2]) {
          let found: { activate(click: LinkClick, text: string): void; text: string } | undefined;
          provider.provideLinks(row, links => {
            found = links?.[0];
          });
          const link = must(found, `a link on row ${row}`);
          expect(link.text).toBe(FULL);
          await interact(() => link.activate(click(), link.text));
        }
        expect(opened.tabs).toEqual([FULL, FULL]);
      } finally {
        await page.unmount();
      }
    });
  });

  describe('a modified click', () => {
    for (const modifier of ['metaKey', 'ctrlKey'] as const) {
      it(`${modifier}-click is a new tab`, async () => {
        const { page, screenLink, opened } = await openDeck();
        try {
          await interact(() => screenLink().activate(click({ [modifier]: true }), URL_ON_SCREEN));
          expect(opened.tabs).toEqual([URL_ON_SCREEN]);
          expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        } finally {
          await page.unmount();
        }
      });
    }

    it('a middle click is a new tab too', async () => {
      const { page, screenLink, opened } = await openDeck();
      try {
        await interact(() => screenLink().activate(click({ button: 1 }), URL_ON_SCREEN));
        expect(opened.tabs).toEqual([URL_ON_SCREEN]);
      } finally {
        await page.unmount();
      }
    });

    it('a click something else already took opens nothing', async () => {
      const { page, screenLink, opened } = await openDeck();
      try {
        await interact(() => screenLink().activate(click({ defaultPrevented: true }), URL_ON_SCREEN));
        expect(opened.tabs).toEqual([]);
      } finally {
        await page.unmount();
      }
    });
  });

  describe('touch', () => {
    it('a tap is the single click the browser synthesises, and opens the link once', async () => {
      const { page, screenLink, opened } = await openDeck();
      try {
        await interact(() => screenLink().activate(click(), URL_ON_SCREEN));
        expect(opened.tabs).toEqual([URL_ON_SCREEN]);
      } finally {
        await page.unmount();
      }
    });

    it('adds no touch handling of its own: touches on the pane open and focus nothing', async () => {
      const { page, spy, opened } = await openDeck();
      try {
        const pane = must(document.body.querySelector('[data-terminal-canvas]'), 'the pane');
        await interact(() => {
          for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
            pane.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
        });
        expect(opened.tabs).toEqual([]);
        // Tap-to-focus belongs to the emulator; the deck never calls focus on its behalf.
        expect(spy.instances[0]?.focused()).toBe(0);
      } finally {
        await page.unmount();
      }
    });
  });

  describe('OSC 8 hyperlinks', () => {
    const handlerOf = (spy: ReturnType<typeof xtermSpy>) => must(spy.instances[0]?.links.handler, 'the OSC 8 handler');

    it('opens one whose text names its target, without asking', async () => {
      const { page, spy, deck, opened } = await openDeck({ rows: [URL_ON_SCREEN] });
      try {
        const range = { start: { x: 1, y: 1 }, end: { x: URL_ON_SCREEN.length, y: 1 } };
        await interact(() => handlerOf(spy).activate(click(), URL_ON_SCREEN, range));
        expect(opened.tabs).toEqual([URL_ON_SCREEN]);
        expect(deck.linkQuestions).toEqual([]);
      } finally {
        await page.unmount();
      }
    });

    it('asks first when its text says something else, and opens it only on a yes', async () => {
      const { page, spy, deck, opened } = await openDeck({ rows: ['https://bank.example.test/'] });
      try {
        const range = { start: { x: 1, y: 1 }, end: { x: 26, y: 1 } };
        deck.confirmLinks = false;
        await interact(() => handlerOf(spy).activate(click(), 'https://evil.example.test/', range));
        expect(deck.linkQuestions).toEqual([
          { visible: 'https://bank.example.test/', href: 'https://evil.example.test/' },
        ]);
        expect(opened.tabs).toEqual([]);

        deck.confirmLinks = true;
        await interact(() => handlerOf(spy).activate(click(), 'https://evil.example.test/', range));
        expect(opened.tabs).toEqual(['https://evil.example.test/']);
      } finally {
        await page.unmount();
      }
    });

    it('never opens, or even asks about, a target that is not http(s)', async () => {
      const { page, spy, deck, opened } = await openDeck({ rows: ['click me'] });
      try {
        const range = { start: { x: 1, y: 1 }, end: { x: 8, y: 1 } };
        await interact(() => {
          for (const target of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd'])
            handlerOf(spy).activate(click(), target, range);
        });
        expect(opened.tabs).toEqual([]);
        expect(deck.linkQuestions).toEqual([]);
      } finally {
        await page.unmount();
      }
    });
  });
});
