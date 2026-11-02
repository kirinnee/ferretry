import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  isLongPress,
  isTouch,
  LOCK_PX,
  LONG_PRESS_MS,
  lockOf,
  ownsKeys,
  startsAtScrollTop,
  startsInHead,
  startsInSelection,
  startsInSidewaysScroller,
  startsOnInteractive,
  swipesWith,
} from '../../../src/features/agenda/agenda-swipe-gesture.ts';

const el = (html: string): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
};

describe('isTouch', () => {
  it('is true for a finger only', () => {
    expect(isTouch({ pointerType: 'touch' })).toBe(true);
    expect(isTouch({ pointerType: 'mouse' })).toBe(false);
    expect(isTouch({ pointerType: 'pen' })).toBe(false);
  });
});

describe('lockOf', () => {
  it('decides nothing under 10px of travel', () => {
    expect(LOCK_PX).toBe(10);
    expect(lockOf(0, 0)).toBeNull();
    expect(lockOf(6, 6)).toBeNull();
    expect(lockOf(-9, 0)).toBeNull();
  });

  it('reads the longer axis, sideways or vertical', () => {
    expect(lockOf(12, 3)).toBe('sideways');
    expect(lockOf(-30, 20)).toBe('sideways');
    expect(lockOf(3, -24)).toBe('vertical');
    expect(lockOf(10, 10)).toBe('sideways');
    expect(lockOf(10, 20)).toBe('vertical');
    expect(lockOf(16, 20)).toBe('sideways');
    expect(lockOf(4, 12)).toBeNull();
    expect(lockOf(4, 22)).toBe('vertical');
    expect(lockOf(-8, -30)).toBe('vertical');
  });
});

describe('startsOnInteractive', () => {
  it('is true on a link, button, field, summary or anything that opts out', () => {
    for (const html of [
      '<a href="#x"><span>go</span></a>',
      '<button><span>go</span></button>',
      '<input />',
      '<textarea></textarea>',
      '<select></select>',
      '<summary>more</summary>',
      '<div role="button">x</div>',
      '<div contenteditable="true">x</div>',
      '<div data-agenda-no-swipe>x</div>',
    ])
      expect(startsOnInteractive(el(html).lastElementChild ?? el(html))).toBe(true);
  });

  it('is false on plain text, an anchor with no href and a null target', () => {
    expect(startsOnInteractive(el('<p>text</p>'))).toBe(false);
    expect(startsOnInteractive(el('<a>name</a>'))).toBe(false);
    expect(startsOnInteractive(null)).toBe(false);
  });
});

describe('startsInSidewaysScroller', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  const scroller = (scrollWidth: number, overflowX: string): HTMLElement => {
    const box = document.createElement('div');
    box.style.overflowX = overflowX;
    for (const [key, value] of Object.entries({ scrollWidth, clientWidth: 200 }))
      Object.defineProperty(box, key, { configurable: true, value });
    box.innerHTML = '<table><tr><td>cell</td></tr></table>';
    return box;
  };

  it('is true inside an element that scrolls sideways, below the card', () => {
    const card = document.createElement('div');
    document.body.append(card);
    const box = scroller(900, 'auto');
    card.append(box);
    expect(startsInSidewaysScroller(box.querySelector('td'), card)).toBe(true);
    const scrolling = scroller(900, 'scroll');
    card.append(scrolling);
    expect(startsInSidewaysScroller(scrolling.querySelector('td'), card)).toBe(true);
  });

  it('is false when it fits, does not scroll, or is the card itself', () => {
    const card = document.createElement('div');
    document.body.append(card);
    for (const box of [scroller(200, 'auto'), scroller(900, 'visible'), scroller(900, 'hidden')]) {
      card.append(box);
      expect(startsInSidewaysScroller(box.querySelector('td'), card)).toBe(false);
    }
    const wideCard = scroller(900, 'auto');
    expect(startsInSidewaysScroller(wideCard.querySelector('td'), wideCard)).toBe(false);
    expect(startsInSidewaysScroller(null, card)).toBe(false);
  });
});

describe('startsInHead', () => {
  it('is true in the card’s header, title, sticky top, who line and quick replies', () => {
    for (const html of [
      '<div class="fy-attn-card__meta"><span>x</span></div>',
      '<h2 data-agenda-title><span>x</span></h2>',
      '<header data-agenda-top><span>x</span></header>',
      '<div data-inbox-who><span>x</span></div>',
      '<div data-agenda-quick-replies><span>x</span></div>',
    ])
      expect(startsInHead(el(html).lastElementChild)).toBe(true);
  });

  it('is false in the body and for a null target', () => {
    expect(startsInHead(el('<div data-agenda-scroll><p>x</p></div>').lastElementChild)).toBe(false);
    expect(startsInHead(null)).toBe(false);
  });
});

describe('startsAtScrollTop', () => {
  const scroller = (scrollTop: number, tall: boolean) => {
    const box = el('<div style="overflow-y:auto"><p>x</p></div>');
    document.body.appendChild(box);
    for (const [key, value] of Object.entries({ scrollTop, scrollHeight: tall ? 400 : 100, clientHeight: 100 }))
      Object.defineProperty(box, key, { configurable: true, value });
    return box;
  };

  it('is true in a body that does not scroll, or sits at its top', () => {
    expect(startsAtScrollTop(scroller(0, false).firstElementChild, document.body)).toBe(true);
    expect(startsAtScrollTop(scroller(0, true).firstElementChild, document.body)).toBe(true);
    expect(startsAtScrollTop(null, document.body)).toBe(true);
  });

  it('is false once a scroller between the touch and the boundary has been scrolled down', () => {
    expect(startsAtScrollTop(scroller(40, true).firstElementChild, document.body)).toBe(false);
  });

  it('does not count a scroller above the boundary, or one that only looks scrolled but cannot scroll', () => {
    const box = scroller(40, true);
    expect(startsAtScrollTop(box.firstElementChild, box)).toBe(true);
    expect(startsAtScrollTop(scroller(40, false).firstElementChild, document.body)).toBe(true);
  });
});

describe('a long press is the reader selecting, never a swipe', () => {
  it('is a press held for LONG_PRESS_MS or more', () => {
    expect(isLongPress(LONG_PRESS_MS - 1)).toBe(false);
    expect(isLongPress(LONG_PRESS_MS)).toBe(true);
  });
});

describe('startsInSelection', () => {
  const selecting = (isCollapsed: boolean, contains: boolean) => ({
    isCollapsed,
    containsNode: () => contains,
  });

  it('is true only on text inside a selection that holds something', () => {
    const text = el('<p>words</p>');
    expect(startsInSelection(text, selecting(false, true))).toBe(true);
    expect(startsInSelection(text, selecting(false, false))).toBe(false);
    expect(startsInSelection(text, selecting(true, true))).toBe(false);
    expect(startsInSelection(text, null)).toBe(false);
    expect(startsInSelection(null, selecting(false, true))).toBe(false);
  });

  it('reads the live window selection when none is handed in', () => {
    const text = el('<p>words</p>');
    document.body.append(text);
    window.getSelection()?.removeAllRanges();
    expect(startsInSelection(text)).toBe(false);
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()?.addRange(range);
    expect(startsInSelection(text.firstChild)).toBe(true);
    window.getSelection()?.removeAllRanges();
    text.remove();
  });
});

describe('the Inbox card’s text', () => {
  const css = readFileSync(new URL('../../../src/features/agenda/agenda-inbox.css', import.meta.url), 'utf8');
  const rule = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('}', start));
  };

  it('can be selected on the swipe deck’s card and the to-test card', () => {
    expect(rule('.fy-attn-deck__top')).toContain('user-select: text');
    expect(rule('.fy-totest__surface')).toContain('user-select: text');
  });

  it('keeps what is pressed from highlighting', () => {
    expect(css).toMatch(/\.fy-attn-deck__top :is\(button[^)]*\) \{\s*user-select: none/);
    expect(css).toMatch(/\.fy-totest__surface :is\(button[^)]*\) \{\s*user-select: none/);
  });
});

describe('swipesWith', () => {
  it('is true for a finger, and for a mouse only where the host opts in', () => {
    expect(swipesWith({ pointerType: 'touch' }, false)).toBe(true);
    expect(swipesWith({ pointerType: 'mouse' }, false)).toBe(false);
    expect(swipesWith({ pointerType: 'mouse' }, true)).toBe(true);
    expect(swipesWith({ pointerType: 'pen' }, true)).toBe(false);
  });
});

describe('ownsKeys', () => {
  it('is false for no element and for a plain button', () => {
    expect(ownsKeys(null)).toBe(false);
    expect(ownsKeys(document)).toBe(false);
    expect(ownsKeys(el('<button>Go</button>'))).toBe(false);
  });

  it('is true inside a field, a menu, a listbox or an editable region', () => {
    expect(ownsKeys(el('<input />'))).toBe(true);
    expect(ownsKeys(el('<textarea></textarea>'))).toBe(true);
    expect(ownsKeys(el('<div role="menu"><button>Pick</button></div>').querySelector('button'))).toBe(true);
    expect(ownsKeys(el('<ul role="listbox"><li>One</li></ul>').querySelector('li'))).toBe(true);
    const editable = el('<div></div>');
    Object.defineProperty(editable, 'isContentEditable', { configurable: true, value: true });
    expect(ownsKeys(editable)).toBe(true);
  });

  it('is true inside a dialog of its own, but not on the card, which is a dialog too', () => {
    expect(ownsKeys(el('<div role="dialog"><button>Pick</button></div>').querySelector('button'))).toBe(true);
    const card = el('<section role="dialog" data-agenda-view="A1"><button>Open chat</button></section>');
    expect(ownsKeys(card)).toBe(false);
    expect(ownsKeys(card.querySelector('button'))).toBe(false);
    const nested = el('<section role="dialog" data-agenda-view="A1"><div role="dialog"><input /></div></section>');
    expect(ownsKeys(nested.querySelector('input'))).toBe(true);
  });
});
