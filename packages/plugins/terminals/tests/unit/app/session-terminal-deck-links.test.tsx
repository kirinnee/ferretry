/**
 * A link in a live shell goes to the link host (where Settings › "Open links in" says, once a Browsers facility binds
 * it; the shipped default is the reader's browser in a new tab) and never anywhere a program merely asked for. The
 * emulator is the spy from `support/terminal-deck.ts`: it records the link provider and the OSC 8 handler the deck
 * registered, so the click path (provider → link host) runs for real and no canvas is needed.
 */
import { describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import { SessionTerminalDeck } from '../../../app/components/session-terminal-deck.tsx';
import { browserLinkHost } from '../../../app/lib/link-host.ts';
import type { LinkClick } from '../../../app/lib/terminal-links.ts';
import { terminalBuffer } from '../../support/app/terminal-buffer.ts';
import { fakeDeck, terminalListing, terminalView, xtermSpy } from '../../support/app/terminal-deck.ts';

const scope = { sessionId: 'shared' };
const SHELL = 'a1b2c3d4e5f6';
const URL_ON_SCREEN = 'https://docs.example.test/getting-started';

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

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
};

type Screen = { activate(click: LinkClick, text: string): void; text: string };

const openDeck = async (rows: string[] = [`read ${URL_ON_SCREEN} now`]) => {
  const tabs: { href: string; features: string | undefined }[] = [];
  const spy = xtermSpy({ buffer: terminalBuffer(rows, 80) });
  const deck = fakeDeck(async () => terminalListing([terminalView(SHELL)]), {
    loadXterm: async () => spy.modules,
    links: browserLinkHost({
      open: ((href: string, _target?: string, features?: string) => {
        tabs.push({ href, features });
        return null;
      }) as Window['open'],
    }),
  });
  const page = await mount(<SessionTerminalDeck dependencies={deck.dependencies} scope={scope} />);
  await settle();
  const linkOnRow = (row: number): Screen => {
    const provider = must(spy.instances[0]?.links.providers[0], 'the registered link provider');
    let found: Screen | undefined;
    provider.provideLinks(row, links => {
      found = links?.[0];
    });
    return must(found, `a link on row ${row}`);
  };
  return { page, deck, spy, tabs, screenLink: () => linkOnRow(1), linkOnRow };
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
    it('opens a new tab with no opener handle, since there is no anchor to carry it', async () => {
      const { page, screenLink, tabs } = await openDeck();
      try {
        await interact(() => screenLink().activate(click(), URL_ON_SCREEN));
        expect(tabs).toEqual([{ href: URL_ON_SCREEN, features: 'noopener,noreferrer' }]);
      } finally {
        await page.unmount();
      }
    });

    it('goes to the link host the dependencies carry', async () => {
      const spy = xtermSpy({ buffer: terminalBuffer([`read ${URL_ON_SCREEN} now`], 80) });
      const deck = fakeDeck(async () => terminalListing([terminalView(SHELL)]), { loadXterm: async () => spy.modules });
      const page = await mount(<SessionTerminalDeck dependencies={deck.dependencies} scope={scope} />);
      await settle();
      try {
        const provider = must(spy.instances[0]?.links.providers[0], 'the registered link provider');
        provider.provideLinks(1, links => links?.[0]?.activate(click(), URL_ON_SCREEN));
        expect(deck.opened).toEqual([URL_ON_SCREEN]);
      } finally {
        await page.unmount();
      }
    });

    it('a click something else already took opens nothing', async () => {
      const { page, screenLink, tabs } = await openDeck();
      try {
        await interact(() => screenLink().activate(click({ defaultPrevented: true }), URL_ON_SCREEN));
        expect(tabs).toEqual([]);
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

    it('is one link whose click opens the whole address, from either row', async () => {
      const { page, linkOnRow, tabs } = await openDeck([HEAD, TAIL]);
      try {
        for (const row of [1, 2]) {
          const link = linkOnRow(row);
          expect(link.text).toBe(FULL);
          await interact(() => link.activate(click(), link.text));
        }
        expect(tabs.map(tab => tab.href)).toEqual([FULL, FULL]);
      } finally {
        await page.unmount();
      }
    });
  });

  describe('touch', () => {
    it('a tap is the single click the browser synthesises, and opens the link once', async () => {
      const { page, screenLink, tabs } = await openDeck();
      try {
        await interact(() => screenLink().activate(click(), URL_ON_SCREEN));
        expect(tabs).toHaveLength(1);
      } finally {
        await page.unmount();
      }
    });

    it('adds no touch handling of its own: touches on the pane open and focus nothing', async () => {
      const { page, spy, tabs } = await openDeck();
      try {
        const pane = must(document.body.querySelector('[data-terminal-canvas]'), 'the pane');
        await interact(() => {
          for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
            pane.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
        });
        expect(tabs).toEqual([]);
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
      const { page, spy, deck, tabs } = await openDeck([URL_ON_SCREEN]);
      try {
        const range = { start: { x: 1, y: 1 }, end: { x: URL_ON_SCREEN.length, y: 1 } };
        await interact(() => handlerOf(spy).activate(click(), URL_ON_SCREEN, range));
        expect(tabs.map(tab => tab.href)).toEqual([URL_ON_SCREEN]);
        expect(deck.linkQuestions).toEqual([]);
      } finally {
        await page.unmount();
      }
    });

    it('asks first when its text says something else, and opens it only on a yes', async () => {
      const { page, spy, deck, tabs } = await openDeck(['https://bank.example.test/']);
      try {
        const range = { start: { x: 1, y: 1 }, end: { x: 26, y: 1 } };
        deck.confirmLinks = false;
        await interact(() => handlerOf(spy).activate(click(), 'https://evil.example.test/', range));
        expect(deck.linkQuestions).toEqual([
          { visible: 'https://bank.example.test/', href: 'https://evil.example.test/' },
        ]);
        expect(tabs).toEqual([]);

        deck.confirmLinks = true;
        await interact(() => handlerOf(spy).activate(click(), 'https://evil.example.test/', range));
        expect(tabs.map(tab => tab.href)).toEqual(['https://evil.example.test/']);
      } finally {
        await page.unmount();
      }
    });

    it('never opens, or even asks about, a target that is not http(s)', async () => {
      const { page, spy, deck, tabs } = await openDeck(['click me']);
      try {
        const range = { start: { x: 1, y: 1 }, end: { x: 8, y: 1 } };
        await interact(() => {
          for (const target of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd'])
            handlerOf(spy).activate(click(), target, range);
        });
        expect(tabs).toEqual([]);
        expect(deck.linkQuestions).toEqual([]);
      } finally {
        await page.unmount();
      }
    });
  });
});
