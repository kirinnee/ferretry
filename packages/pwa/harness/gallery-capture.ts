/**
 * CAPTURE A GALLERY ELEMENT, OR REFUSE OUT LOUD — never return the wrong pixels.
 *
 * WHAT WAS MEASURED. The harness gallery is one document about 76,000 px tall at
 * `desktop`. `locator.screenshot()` on a card low in it does not fail: it returns a
 * PNG of the right SIZE holding pixels of an entirely different card. Measured on
 * Chrome 141 headless, `#harness-fleet-preview` (a 1,420x1,095 card at y≈37,400)
 * came back as the device-pairing panel followed by the two picker cards that live
 * near y≈75,600 — 29.97% of its pixels differing from what the browser actually
 * paints for that element. `#harness-dictation-settings` differed by 51.57%,
 * `#harness-fleet-layer` by 46.68%. Nothing threw, nothing warned, and every one of
 * those PNGs was reviewed and approved as if it showed the card it is named after.
 *
 * WHY THAT IS WORSE THAN A CRASH. A capture is the whole of the visual review: the
 * gallery exists so a human can answer "does this still look right?" by opening two
 * PNGs. A capture that silently frames another card turns that review into a
 * ceremony — the reviewer looked at something, said yes, and learned nothing about
 * the card under review. It is the same family as a test that passes because its
 * assertion never runs.
 *
 * THE PROPERTY THIS MODULE HOLDS. A capture is only taken of an element the browser
 * has genuinely painted INSIDE the viewport. Every path that cannot reach that
 * state throws, naming the element, the geometry it had, and why the capture was
 * refused. There is no fallback, because a fallback is how the silent version
 * happened.
 *
 * HOW IT GETS THERE. The element is hoisted to the top of the document by hiding
 * every element that is not it or one of its ancestors, and rewinding every
 * scroller above it; the viewport is then grown, on either axis, until the element
 * fits inside it. Both steps are checked rather than trusted — the element's own width and
 * height must survive isolation unchanged, and it must end up wholly inside the
 * viewport — so a layout that isolation would distort is refused instead of
 * photographed. Everything is put back before the function returns.
 *
 * HOW EVERY NUMBER HERE WAS JUDGED, because a yardstick that shares a bias with the
 * thing it measures decides nothing: each strategy is compared against a plain
 * full-viewport `page.screenshot()` of ITS OWN page state — the one capture Chromium
 * takes of pixels it has really put on a screen — and never against another
 * strategy's layout.
 *
 * MEASURED ALTERNATIVES. Scrolling the card to the top and growing the viewport
 * WITHOUT isolating it — the least invasive repair — still disagreed with the screen
 * by 6.37% for `#harness-dictation-settings` at `desktop` and 8.97% at `mobile`.
 * Trusting `locator.screenshot()` to place the element for itself is the defect. Only
 * isolation agreed pixel for pixel, on every card measured, at both viewports.
 */

import type { Locator, Page } from 'playwright-core';

/**
 * The four names isolation writes into the document, and every one of them is
 * removed again by `release`.
 *
 * `hidden` is what the isolation sheet hides. `pinned` marks every element whose width
 * was held still — the card and each of its ancestors — and `restyle` carries the
 * inline style that element had before, absent on one that had none, which is how the
 * release tells "put this back" from "there was nothing here".
 */
const ISOLATION = {
  attribute: 'data-harness-capture-hidden',
  sheet: 'harness-capture-isolation',
  pinned: 'data-harness-capture-pinned',
  restyle: 'data-harness-capture-restyle',
} as const;

type IsolationNames = typeof ISOLATION;

/**
 * THE BIGGEST ELEMENT THIS WILL CAPTURE, on either axis, and it is a refusal rather
 * than a clamp.
 *
 * The mechanism grows the viewport to the element, so this number is really "how big a
 * viewport has this harness MEASURED Chromium painting in one frame".
 * Measured rather than guessed: a flat-coloured block isolated out of a 60,000px
 * document came back one uniform colour at 2,000, 4,000, 6,000, 8,000, 10,000 and
 * 11,900 px, and `tests/integration/gallery-capture.visual.test.ts` keeps the top of
 * that range honest. A ceiling nobody had run to would be the same kind of claim this
 * module exists to delete.
 *
 * A card past it is not silently cropped and not captured at a viewport that cannot
 * hold it — it is named and refused.
 */
const MAXIMUM_ELEMENT_EXTENT = 12_000;

/** A slack of half a pixel, because a rect is fractional and a viewport is not. */
const TOLERANCE = 0.5;

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

type Hoisted = { readonly refused: string } | { readonly before: Box; readonly after: Box };

/**
 * Hide everything the element is not, rewind every scroller above it, and report
 * its box on both sides of that change.
 *
 * It runs with the element itself as its argument rather than a selector, so every
 * caller's existing locator — a label, a role, an `nth`, a `data-` attribute — keeps
 * working unchanged. A document that is not the top one is refused rather than
 * isolated: the release below runs on the main frame, so isolating inside an iframe
 * would leave that frame permanently disfigured.
 *
 * WIDTHS ARE PINNED FIRST, ALL THE WAY UP, and that is not a nicety. Hiding an
 * element's siblings takes back the space they were sharing with it, and it does so
 * at every level: the Settings theme cards sit in a track-based grid, and isolating
 * one turned a 1,070x100 card into a 186x135 one; a transcript tool group kept its
 * own box but watched the two-column shell ABOVE it fall from 676px to 386px. Both
 * are faithful captures of a layout no reader will ever see.
 *
 * The element itself is pinned EXACTLY — it must come out the size the gallery gave
 * it — while every ancestor gets only a `min-width` FLOOR. That asymmetry is what
 * lets the two repairs coexist: a floor stops hiding from collapsing the chain, and
 * still lets `captureElement` grow the viewport to reveal a card that is wider than
 * the review, which a maximum would have made impossible.
 *
 * The HEIGHT is deliberately left free on all of them: it is the check. A height that
 * does not come back is the signal that this element cannot be isolated honestly, and
 * the capture is refused.
 */
const hoist = (node: Element, names: IsolationNames): Hoisted => {
  const owner = node.ownerDocument;
  const view = owner.defaultView;
  if (view === null || view !== view.top) return { refused: 'it is not in the top-level document' };
  const read = (): Box => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const before = read();

  const pin = (target: Element, properties: readonly string[], px: number): void => {
    const styled = target.getAttribute('style');
    target.setAttribute(names.pinned, '');
    if (styled !== null) target.setAttribute(names.restyle, styled);
    const styleable = target as Element & { readonly style?: CSSStyleDeclaration };
    for (const property of properties) styleable.style?.setProperty(property, `${px}px`, 'important');
  };
  pin(node, ['width', 'min-width', 'max-width'], before.width);
  for (let step: Element | null = node.parentElement; step !== null && step !== owner.body; step = step.parentElement)
    pin(step, ['min-width'], step.getBoundingClientRect().width);

  const sheet = owner.createElement('style');
  sheet.id = names.sheet;
  sheet.textContent = `[${names.attribute}]{display:none !important}`;
  owner.head.append(sheet);
  for (let step: Element | null = node; step !== null && step !== owner.body; step = step.parentElement) {
    for (const sibling of step.parentElement?.children ?? []) {
      if (sibling !== step) sibling.setAttribute(names.attribute, '');
    }
  }
  // Vertical only. A horizontally scrolled ancestor is a state the card is
  // legitimately in — a terminal deck scrolled sideways — so rewinding it would
  // change what is under review. If that leaves the card off the side of the
  // viewport, the visibility check refuses the capture rather than framing it.
  for (let step: Element | null = node.parentElement; step !== null; step = step.parentElement) step.scrollTop = 0;
  owner.documentElement.scrollTop = 0;
  owner.body.scrollTop = 0;

  return { before, after: read() };
};

/**
 * The element's box now, and the first ancestor that is cutting a piece off it.
 *
 * FITTING INSIDE THE VIEWPORT IS NOT THE WHOLE OF BEING PAINTED. A card 1,400px wide
 * inside a 900px scrollport is entirely within a viewport grown to 1,408 and still
 * comes back with 500px of black, because the scrollport never painted that part. So
 * every clipping ancestor is measured too, and a card any of them cuts is refused —
 * that black band is precisely the sort of thing a reviewer reads past.
 */
const measure = (node: Element): { readonly box: Box; readonly clippedBy: string | null } => {
  const rect = node.getBoundingClientRect();
  const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const view = node.ownerDocument.defaultView;
  for (let step: Element | null = node.parentElement; step !== null && view !== null; step = step.parentElement) {
    const style = view.getComputedStyle(step);
    const clipsX = /^(auto|scroll|hidden|clip)$/u.test(style.overflowX);
    const clipsY = /^(auto|scroll|hidden|clip)$/u.test(style.overflowY);
    if (!clipsX && !clipsY) continue;
    const bounds = step.getBoundingClientRect();
    if (
      (clipsX && (rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5)) ||
      (clipsY && (rect.top < bounds.top - 0.5 || rect.bottom > bounds.bottom + 0.5))
    )
      return { box, clippedBy: `${step.tagName.toLocaleLowerCase()}${step.id === '' ? '' : `#${step.id}`}` };
  }
  return { box, clippedBy: null };
};

/**
 * Put the document back exactly as it was found.
 *
 * The pinned element's inline style is restored from what it HAD rather than by
 * deleting the three properties that were added: an element that already declared
 * its own `width` would otherwise lose it, which is a change nothing later in the
 * run would announce.
 */
const release = (names: IsolationNames): void => {
  document.getElementById(names.sheet)?.remove();
  for (const node of document.querySelectorAll(`[${names.attribute}]`)) node.removeAttribute(names.attribute);
  for (const node of document.querySelectorAll(`[${names.pinned}]`)) {
    const styled = node.getAttribute(names.restyle);
    if (styled === null) node.removeAttribute('style');
    else node.setAttribute('style', styled);
    node.removeAttribute(names.restyle);
    node.removeAttribute(names.pinned);
  }
};

const describe = (box: Box): string =>
  `${box.width.toFixed(0)}x${box.height.toFixed(0)} at ${box.x.toFixed(0)},${box.y.toFixed(0)}`;

const resized = (before: Box, after: Box): boolean =>
  Math.abs(after.width - before.width) > TOLERANCE || Math.abs(after.height - before.height) > TOLERANCE;

/**
 * Screenshot one element of the harness page to `path`, or throw saying why it could
 * not be done honestly.
 *
 * A refusal names the capture by its FILE NAME rather than by its locator. A
 * locator's own `toString()` is a Playwright selector, and the person reading a
 * failed run is looking for which of four hundred PNGs did not get taken.
 */
export const captureElement = async (page: Page, element: Locator, path: string): Promise<void> => {
  const label = path.split('/').at(-1) ?? path;
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error(`refusing to capture ${label}: this page has no viewport to paint it in`);

  // Bring it into view first, exactly as the gallery always has: images below the
  // fold are `loading="lazy"` and content that has never been near the viewport has
  // never been decoded. Isolation moves the element, it does not load it.
  await element.scrollIntoViewIfNeeded();

  const hoisted = await element.evaluate(hoist, ISOLATION);
  let grown = false;
  try {
    if ('refused' in hoisted) throw new Error(`refusing to capture ${label}: ${hoisted.refused}`);
    if (resized(hoisted.before, hoisted.after))
      throw new Error(
        `refusing to capture ${label}: isolating it changed its size from ${describe(hoisted.before)} to ` +
          `${describe(hoisted.after)} even with its width held still, so the capture would not be the ` +
          'element the gallery lays out',
      );
    if (hoisted.after.height > MAXIMUM_ELEMENT_EXTENT)
      throw new Error(
        `refusing to capture ${label}: it is ${hoisted.after.height.toFixed(0)}px tall, past the ` +
          `${MAXIMUM_ELEMENT_EXTENT}px this harness will claim Chromium paints in one frame`,
      );
    if (hoisted.after.width > MAXIMUM_ELEMENT_EXTENT)
      throw new Error(
        `refusing to capture ${label}: it is ${hoisted.after.width.toFixed(0)}px wide, past the ` +
          `${MAXIMUM_ELEMENT_EXTENT}px this harness will claim Chromium paints in one frame`,
      );

    // BOTH AXES, because a card can outgrow the viewport sideways too: the session
    // task board is 1,596px wide inside a 1,440px review, sitting in a container that
    // scrolls horizontally. Widening is the same bargain as heightening — it reveals
    // more of the card without moving it — and the size check below is what holds
    // the browser to that: a card whose own layout answers to the wider viewport
    // changes size, and is refused rather than captured in a shape nobody reviews.
    const width = Math.max(viewport.width, Math.ceil(hoisted.after.x + hoisted.after.width) + 8);
    const height = Math.max(viewport.height, Math.ceil(hoisted.after.y + hoisted.after.height) + 8);
    if (width > viewport.width || height > viewport.height) {
      await page.setViewportSize({ width, height });
      grown = true;
    }

    // Growing the viewport is itself a layout change, so the element is measured
    // AGAIN rather than assumed to have stayed where isolation left it.
    const framed = await element.evaluate(measure);
    if (resized(hoisted.after, framed.box))
      throw new Error(
        `refusing to capture ${label}: growing the viewport to ${width}x${height} changed its size ` +
          `from ${describe(hoisted.after)} to ${describe(framed.box)}`,
      );
    if (
      framed.box.x < -TOLERANCE ||
      framed.box.y < -TOLERANCE ||
      framed.box.x + framed.box.width > width + TOLERANCE ||
      framed.box.y + framed.box.height > height + TOLERANCE
    )
      throw new Error(
        `refusing to capture ${label}: ${describe(framed.box)} is not wholly inside the ` +
          `${width}x${height} viewport, so the capture would be of pixels Chromium never painted`,
      );
    if (framed.clippedBy !== null)
      throw new Error(
        `refusing to capture ${label}: ${describe(framed.box)} is cut off by ${framed.clippedBy}, ` +
          'so the capture would carry a band Chromium never painted',
      );

    await element.screenshot({ path });
  } finally {
    if (grown) await page.setViewportSize(viewport);
    await page.evaluate(release, ISOLATION);
  }
};
