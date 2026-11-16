import { describe, expect, it } from 'bun:test';
import '../../support/dom.ts';
import { afterEach } from 'bun:test';
import {
  keepSettingsPageRevealed,
  revealSettingsPage,
  SETTINGS_REVEAL_MARGIN_PX,
} from '../../../src/shell/settings-reveal.ts';

/**
 * A SETTINGS PAGE THE PERSON PICKED IS SCROLLED INTO SIGHT (p2 settings-nav): the list of every tab sits above the page,
 * so on a phone or a short laptop the page started below the fold and picking a tab looked like nothing happened.
 */
describe('revealSettingsPage', () => {
  const rect = (top: number, height: number) => () => ({ top, bottom: top + height, height }) as DOMRect;
  const scene = (pageTop: number) => {
    const shell = document.createElement('div');
    const scroller = document.createElement('div');
    const page = document.createElement('div');
    scroller.append(page);
    shell.append(scroller);
    // The scroller shows y 100..800 (700px); the page starts at `pageTop` in the viewport.
    scroller.getBoundingClientRect = rect(100, 700);
    page.getBoundingClientRect = rect(pageTop, 300);
    const overflow = new Map<Element, string>([
      [shell, 'hidden'],
      [scroller, 'auto'],
    ]);
    return { shell, scroller, page, overflowY: (node: Element) => overflow.get(node) ?? 'visible' };
  };

  it('scrolls a page that starts below the fold up to the head of its scroller (390x844 and 1280x713)', () => {
    const { shell, scroller, page, overflowY } = scene(760);
    expect(revealSettingsPage(page, overflowY)).toBe(true);
    expect(scroller.scrollTop).toBe(760 - 100 - SETTINGS_REVEAL_MARGIN_PX);
    expect(shell.scrollTop).toBe(0);
  });

  it('leaves a page with 300px or more already in sight where it is (a tall desktop keeps its layout)', () => {
    const { scroller, page, overflowY } = scene(300);
    expect(revealSettingsPage(page, overflowY)).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });

  it('never scrolls a box that only clips, and does nothing with no scroller at all', () => {
    const { shell, page } = scene(760);
    expect(revealSettingsPage(page, node => (node === shell ? 'hidden' : 'visible'))).toBe(false);
    expect(shell.scrollTop).toBe(0);
    const loose = document.createElement('div');
    document.createElement('div').append(loose);
    expect(revealSettingsPage(loose)).toBe(false);
  });
});

describe('keepSettingsPageRevealed', () => {
  const original = globalThis.ResizeObserver;
  afterEach(() => {
    globalThis.ResizeObserver = original;
  });

  const harness = () => {
    let callback: () => void = () => undefined;
    let disconnected = false;
    globalThis.ResizeObserver = class {
      constructor(next: () => void) {
        callback = next;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        disconnected = true;
      }
    } as unknown as typeof ResizeObserver;
    const scroller = document.createElement('div');
    const page = document.createElement('div');
    scroller.append(page);
    // The scroller can only scroll as far as its content allows: `room` is how far it may go right now.
    let room = 30;
    let top = 760;
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 800, height: 700 }) as DOMRect;
    page.getBoundingClientRect = () => ({ top, bottom: top + 300, height: 300 }) as DOMRect;
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => 760 - top,
      set: (value: number) => {
        top = 760 - Math.min(value, room);
      },
    });
    const overflowY = (node: Element) => (node === scroller ? 'auto' : 'visible');
    return {
      page,
      overflowY,
      resize: (more: number) => {
        room = more;
        callback();
      },
      top: () => top,
      disconnected: () => disconnected,
    };
  };

  it('reveals again as the page grows, so a page whose body arrives late still ends up at the head', () => {
    const rig = harness();
    const stop = keepSettingsPageRevealed(rig.page, rig.overflowY);
    expect(rig.top()).toBe(730); // first reveal landed short: only 30px of content to scroll yet
    rig.resize(1_000);
    expect(rig.top()).toBe(100 + SETTINGS_REVEAL_MARGIN_PX);
    stop();
    expect(rig.disconnected()).toBe(true);
  });

  it('lets go the moment the reader scrolls', () => {
    const rig = harness();
    keepSettingsPageRevealed(rig.page, rig.overflowY);
    document.dispatchEvent(new Event('wheel'));
    expect(rig.disconnected()).toBe(true);
  });
});
