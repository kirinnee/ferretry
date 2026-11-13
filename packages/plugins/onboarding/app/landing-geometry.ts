/**
 * FIXED ELEMENTS ON THE STATIC PAGES, MEASURED IN A REAL BROWSER.
 *
 * The landing's floating "Get started" button sat on top of the closing "Open the app" button on a phone,
 * with every unit test green: a screenshot of a fixed element in a full-page capture shows it wherever the
 * capture happened to put it. So the page is scrolled top to bottom in steps and, at each stop, every
 * VISIBLE fixed element is checked against every visible control and against every other fixed element:
 *
 *   - a fixed element never intersects a control (a link, button, field or tab) it does not contain, with a
 *     4px margin that covers a hard offset shadow;
 *   - two fixed elements never overlap or stack;
 *   - a fixed element sits wholly inside the viewport, so a notch or a home bar cannot clip it.
 *
 * A fixed element that is hidden (`visibility`, `display`, zero opacity, or translated off screen) is not
 * measured: hiding it IS the fix for a stop where it would collide.
 */

import type { Page } from 'playwright-core';

/** The gap a fixed element keeps from every control; the floating button's shadow is 3px. */
const MARGIN = 4;

interface Violation {
  readonly scrollY: number;
  readonly fixed: string;
  readonly other: string;
  readonly kind: 'covers-control' | 'overlaps-fixed' | 'leaves-viewport';
}

/** How many fixed elements and scroll stops a run measured, so a check that stopped looking cannot read as a pass. */
export interface LandingGeometryReport {
  readonly stops: number;
  readonly fixedSeen: number;
}

/**
 * Scroll `page` top to bottom and assert no visible fixed element collides with a control or another fixed
 * element. Throws one line per violation. `label` names the page, width and scheme in the message.
 */
export async function assertFixedElementsClear(page: Page, label: string): Promise<LandingGeometryReport> {
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const viewportHeight = page.viewportSize()?.height ?? 0;
  const step = Math.max(1, Math.floor(viewportHeight / 3));
  const stops = [...new Set([...Array.from({ length: Math.ceil(total / step) }, (_, index) => index * step), total])];
  const violations: Violation[] = [];
  let fixedSeen = 0;
  for (const target of stops) {
    await page.evaluate(y => window.scrollTo(0, y), target);
    // Two frames: scroll handlers and IntersectionObserver callbacks both land after the scroll itself.
    await page.evaluate(
      () =>
        new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    const found = await page.evaluate(margin => {
      const describe = (element: Element): string => {
        const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
        return `<${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(' ')[0]}` : ''}> "${text}"`;
      };
      const onScreen = (element: Element): boolean => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 &&
          box.width > 0 &&
          box.height > 0 &&
          box.bottom > 0 &&
          box.right > 0 &&
          box.top < window.innerHeight &&
          box.left < window.innerWidth
        );
      };
      const meets = (a: DOMRect, b: DOMRect): boolean =>
        a.left < b.right + margin &&
        a.right + margin > b.left &&
        a.top < b.bottom + margin &&
        a.bottom + margin > b.top;
      const everything = [...document.querySelectorAll('body *')];
      const fixed = everything.filter(element => getComputedStyle(element).position === 'fixed' && onScreen(element));
      const controls = [...document.querySelectorAll('a[href], button, input, select, textarea, summary, [role="tab"]')]
        .filter(onScreen)
        .filter(element => getComputedStyle(element).position !== 'fixed');
      const out: { fixed: string; other: string; kind: string }[] = [];
      for (const [index, element] of fixed.entries()) {
        const box = element.getBoundingClientRect();
        if (box.left < 0 || box.top < 0 || box.right > window.innerWidth || box.bottom > window.innerHeight) {
          out.push({ fixed: describe(element), other: 'the viewport edge', kind: 'leaves-viewport' });
        }
        for (const control of controls) {
          if (element.contains(control) || control.contains(element)) continue;
          if (meets(box, control.getBoundingClientRect())) {
            out.push({ fixed: describe(element), other: describe(control), kind: 'covers-control' });
          }
        }
        for (const peer of fixed.slice(index + 1)) {
          if (element.contains(peer) || peer.contains(element)) continue;
          if (meets(box, peer.getBoundingClientRect())) {
            out.push({ fixed: describe(element), other: describe(peer), kind: 'overlaps-fixed' });
          }
        }
      }
      return { out, fixedCount: fixed.length };
    }, MARGIN);
    fixedSeen += found.fixedCount;
    for (const entry of found.out) {
      violations.push({
        scrollY: target,
        fixed: entry.fixed,
        other: entry.other,
        kind: entry.kind as Violation['kind'],
      });
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  if (violations.length > 0) {
    const lines = violations.map(v => `  at scrollY ${v.scrollY}: ${v.fixed} ${v.kind} ${v.other}`);
    throw new Error(`fixed elements collide on ${label}:\n${lines.join('\n')}`);
  }
  return { stops: stops.length, fixedSeen };
}
