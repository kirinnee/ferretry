import { describe, expect, it } from 'bun:test';
import {
  isTouch,
  LOCK_PX,
  lockOf,
  startsInHead,
  startsInSidewaysScroller,
  startsOnInteractive,
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
    expect(lockOf(3, -12)).toBe('vertical');
    expect(lockOf(10, 10)).toBe('vertical');
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
