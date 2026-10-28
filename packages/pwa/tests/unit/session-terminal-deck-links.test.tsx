/**
 * A link in a live shell opens where Settings › "Open links in" says — the same decision every chat
 * link uses — and never anywhere a program merely asked for. The emulator is the spy from
 * `support/terminal-deck.ts`: it records the link provider and the OSC 8 handler the deck registered, so
 * the click path (provider → `useLinkBehaviour` → `LinkOpener`) runs for real and no canvas is needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionTerminalDeck } from '../../src/components/session-terminal-deck.tsx';
import { LinkBehaviourProvider, type LinkOpener } from '../../src/features/browser/external-link.tsx';
import type { ComputerLinkPort } from '../../src/features/browser/local-computer.ts';
import type { OpenLinksIn } from '../../src/lib/controls.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { LinkClick } from '../../src/lib/terminal-links.ts';
import { interact, mount, must } from '../support/dom.ts';
import { fakeDeck, terminalListing, terminalView, xtermSpy } from '../support/terminal-deck.ts';
import { terminalBuffer } from '../support/terminal-buffer.ts';

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token' });
const scope = daemonSessionScope(connection, 'shared');
const SHELL = 'a1b2c3d4e5f6';
const URL_ON_SCREEN = 'https://docs.example.test/getting-started';

const fakeOpener = (iosStandalone = false) => {
  const tabs: string[] = [];
  const handedOff: string[] = [];
  const opener: LinkOpener = {
    iosStandalone: () => iosStandalone,
    handOff: href => void handedOff.push(href),
    openTab: href => void tabs.push(href),
    unlessLeft: () => () => {},
  };
  return { opener, tabs, handedOff };
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
beforeEach(() => {
  originalFetch = globalThis.fetch;
  // The preview's iframe is the browser integration's; this suite asserts where a click goes.
  globalThis.fetch = (async () => new Response('browser fixture', { status: 200 })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
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
  readonly opened: ReturnType<typeof fakeOpener>;
  /** The link the screen shows, as xterm hands it to a click. */
  readonly screenLink: () => { activate(click: LinkClick, text: string): void; text: string };
}

const openDeck = async (
  openLinksIn: OpenLinksIn,
  options: {
    readonly ios?: boolean;
    readonly computer?: ComputerLinkPort;
    readonly rows?: string[];
    readonly notify?: (message: string) => void;
  } = {},
): Promise<Opened> => {
  const opened = fakeOpener(options.ios ?? false);
  const spy = xtermSpy({ buffer: terminalBuffer(options.rows ?? [`read ${URL_ON_SCREEN} now`], 80) });
  const deck = fakeDeck(async () => terminalListing([terminalView(SHELL)]), { loadXterm: async () => spy.modules });
  const page = await mount(
    <LinkBehaviourProvider
      openLinksIn={openLinksIn}
      opener={opened.opener}
      {...(options.computer === undefined ? {} : { computer: options.computer })}
      {...(options.notify === undefined ? {} : { notify: options.notify })}
    >
      <SessionTerminalDeck connection={connection} dependencies={deck.dependencies} scope={scope} />
    </LinkBehaviourProvider>,
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
  return { page, deck, spy, opened, screenLink };
};

describe('SessionTerminalDeck — links', () => {
  it('registers one link provider and the OSC 8 handler on the emulator', async () => {
    const { page, spy } = await openDeck('browser');
    try {
      expect(spy.instances).toHaveLength(1);
      expect(spy.instances[0]?.links.providers).toHaveLength(1);
      expect(spy.instances[0]?.links.handler?.allowNonHttpProtocols).toBe(false);
    } finally {
      await page.unmount();
    }
  });

  it('offers the address on screen as a link', async () => {
    const { page, screenLink } = await openDeck('browser');
    try {
      expect(screenLink().text).toBe(URL_ON_SCREEN);
    } finally {
      await page.unmount();
    }
  });

  describe('a click, by the "Open links in" setting', () => {
    it('Your browser: a new tab, since there is no anchor to carry it', async () => {
      const { page, screenLink, opened } = await openDeck('browser');
      try {
        await interact(() => screenLink().activate(click(), URL_ON_SCREEN));
        expect(opened.tabs).toEqual([URL_ON_SCREEN]);
        expect(opened.handedOff).toEqual([]);
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      } finally {
        await page.unmount();
      }
    });

    it('Your browser, in the installed iOS app: hands the address to Safari instead of a tab', async () => {
      const { page, screenLink, opened } = await openDeck('browser', { ios: true });
      try {
        await interact(() => screenLink().activate(click(), URL_ON_SCREEN));
        expect(opened.handedOff).toEqual([`x-safari-${URL_ON_SCREEN}`]);
        expect(opened.tabs).toEqual([]);
      } finally {
        await page.unmount();
      }
    });

    it('Ferretry side panel: the in-app preview, not a tab', async () => {
      const { page, screenLink, opened } = await openDeck('panel');
      try {
        await interact(() => screenLink().activate(click(), URL_ON_SCREEN));
        expect(opened.tabs).toEqual([]);
        expect(must(document.body.querySelector('[role="dialog"]'), 'the preview sheet').textContent).toContain(
          URL_ON_SCREEN,
        );
      } finally {
        await page.unmount();
      }
    });

    it("Your computer's default browser: through the daemon on this computer", async () => {
      const handed: string[] = [];
      const computer: ComputerLinkPort = async href => {
        handed.push(href);
      };
      const { page, screenLink, opened } = await openDeck('computer', { computer });
      try {
        await interact(() => screenLink().activate(click(), URL_ON_SCREEN));
        expect(handed).toEqual([URL_ON_SCREEN]);
        expect(opened.tabs).toEqual([]);
      } finally {
        await page.unmount();
      }
    });

    it("Your computer's default browser: a hand-off that fails opens a tab instead", async () => {
      const computer: ComputerLinkPort = async () => {
        throw new Error('not local');
      };
      const { page, screenLink, opened } = await openDeck('computer', { computer });
      try {
        await interact(() => screenLink().activate(click(), URL_ON_SCREEN));
        expect(opened.tabs).toEqual([URL_ON_SCREEN]);
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
      const { page, spy, opened } = await openDeck('browser', { rows });
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

    it('goes where the setting says: through the daemon for the computer', async () => {
      const handed: string[] = [];
      const { page, spy, opened } = await openDeck('computer', {
        rows,
        computer: async href => void handed.push(href),
      });
      try {
        const provider = must(spy.instances[0]?.links.providers[0], 'the registered link provider');
        let found: { activate(click: LinkClick, text: string): void; text: string } | undefined;
        provider.provideLinks(2, links => {
          found = links?.[0];
        });
        await interact(() => must(found, 'a link on row 2').activate(click(), FULL));
        expect(handed).toEqual([FULL]);
        expect(opened.tabs).toEqual([]);
      } finally {
        await page.unmount();
      }
    });
  });

  describe('when the computer cannot be reached, the reader is told', () => {
    const noticesFor = async (
      path: 'provider' | 'osc8',
      options: { readonly computer?: ComputerLinkPort; readonly setting?: OpenLinksIn } = {},
    ) => {
      const notices: string[] = [];
      const { page, spy, screenLink, opened } = await openDeck(options.setting ?? 'computer', {
        rows: [URL_ON_SCREEN],
        notify: message => void notices.push(message),
        ...(options.computer === undefined ? {} : { computer: options.computer }),
      });
      try {
        if (path === 'provider') await interact(() => screenLink().activate(click(), URL_ON_SCREEN));
        else {
          const range = { start: { x: 1, y: 1 }, end: { x: URL_ON_SCREEN.length, y: 1 } };
          await interact(() =>
            must(spy.instances[0]?.links.handler, 'the OSC 8 handler').activate(click(), URL_ON_SCREEN, range),
          );
        }
        await settle();
        return { notices, tabs: opened.tabs };
      } finally {
        await page.unmount();
      }
    };

    for (const path of ['provider', 'osc8'] as const) {
      it(`no daemon on this computer: opens a tab and says why (${path})`, async () => {
        const { notices, tabs } = await noticesFor(path);
        expect(tabs).toEqual([URL_ON_SCREEN]);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain('default browser');
        expect(notices[0]).not.toContain(URL_ON_SCREEN);
      });

      it(`a hand-off that fails: opens a tab and says why, without the address (${path})`, async () => {
        const { notices, tabs } = await noticesFor(path, {
          computer: async () => {
            throw new Error('the daemon answered 503');
          },
        });
        expect(tabs).toEqual([URL_ON_SCREEN]);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain('the daemon answered 503');
        expect(notices[0]).not.toContain(URL_ON_SCREEN);
      });

      it(`a hand-off that works says nothing (${path})`, async () => {
        const { notices, tabs } = await noticesFor(path, { computer: async () => {} });
        expect(tabs).toEqual([]);
        expect(notices).toEqual([]);
      });

      it(`browser and panel never apologise (${path})`, async () => {
        for (const setting of ['browser', 'panel'] as const)
          expect((await noticesFor(path, { setting })).notices).toEqual([]);
      });
    }
  });

  describe('a modified click', () => {
    for (const setting of ['browser', 'panel', 'computer'] as const) {
      for (const modifier of ['metaKey', 'ctrlKey'] as const) {
        it(`${modifier}-click is a new tab whatever the setting (${setting})`, async () => {
          const { page, screenLink, opened } = await openDeck(setting, {
            computer: async () => {
              throw new Error('must not be asked');
            },
          });
          try {
            await interact(() => screenLink().activate(click({ [modifier]: true }), URL_ON_SCREEN));
            expect(opened.tabs).toEqual([URL_ON_SCREEN]);
            expect(document.body.querySelector('[role="dialog"]')).toBeNull();
          } finally {
            await page.unmount();
          }
        });
      }
    }

    it('a middle click is a new tab too', async () => {
      const { page, screenLink, opened } = await openDeck('panel');
      try {
        await interact(() => screenLink().activate(click({ button: 1 }), URL_ON_SCREEN));
        expect(opened.tabs).toEqual([URL_ON_SCREEN]);
      } finally {
        await page.unmount();
      }
    });

    it('a click something else already took opens nothing', async () => {
      const { page, screenLink, opened } = await openDeck('browser');
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
      const { page, screenLink, opened } = await openDeck('browser');
      try {
        await interact(() => screenLink().activate(click(), URL_ON_SCREEN));
        expect(opened.tabs).toEqual([URL_ON_SCREEN]);
      } finally {
        await page.unmount();
      }
    });

    it('adds no touch handling of its own: touches on the pane open and focus nothing', async () => {
      const { page, spy, opened } = await openDeck('browser');
      try {
        const pane = must(document.body.querySelector('[data-terminal-canvas]'), 'the pane');
        await interact(() => {
          for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
            pane.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
        });
        expect(opened.tabs).toEqual([]);
        expect(opened.handedOff).toEqual([]);
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
      const { page, spy, deck, opened } = await openDeck('browser', { rows: [URL_ON_SCREEN] });
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
      const { page, spy, deck, opened } = await openDeck('browser', { rows: ['https://bank.example.test/'] });
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
      const { page, spy, deck, opened } = await openDeck('browser', { rows: ['click me'] });
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
