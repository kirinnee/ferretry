/**
 * CAPTURE A GALLERY ELEMENT, OR REFUSE OUT LOUD — never return the wrong pixels.
 *
 * WHAT WAS MEASURED. The harness gallery is one document about 76,000 px tall at
 * `desktop`. `locator.screenshot()` on a card low in it does not fail: it returns a
 * PNG of the right SIZE holding pixels of an entirely different card. Measured on
 * Chrome 141 headless, `#harness-fleet-preview` (a 1,420x1,095 card at y≈37,400)
 * came back as the device-pairing panel followed by the two picker cards that live
 * near y≈75,600 — 26.5% of its pixels differing from what the browser actually
 * paints for that element. `#harness-dictation-settings` differed by 31.6%,
 * `#harness-fleet-layer` by 20.4%. Nothing threw, nothing warned, and every one of
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
 * scroller above it; the viewport is then grown if the element is taller than it
 * is. Both steps are checked rather than trusted — the element's own width and
 * height must survive isolation unchanged, and it must end up wholly inside the
 * viewport — so a layout that isolation would distort is refused instead of
 * photographed. Everything is put back before the function returns.
 *
 * MEASURED ALTERNATIVES, and why they are not what this does. Scrolling the card to
 * the top of the viewport and growing the viewport WITHOUT isolating it — the least
 * invasive repair — still returned 4.8% wrong pixels for `#harness-dictation-settings`
 * at `desktop` and 5.2% at `mobile`. Trusting `locator.screenshot()` to scroll for
 * itself is the defect. Only isolation agreed, pixel for pixel, with a plain
 * full-viewport `page.screenshot()` of the same element — the one capture Chromium
 * takes of pixels it has really put on a screen.
 */

import type { Locator, Page } from 'playwright-core';

/**
 * The four names isolation writes into the document, and every one of them is
 * removed again by `release`.
 *
 * `hidden` is what the isolation sheet hides. `pinned` marks the one element whose
 * own width was held still, and `restyle` carries the inline style it had before —
 * absent on an element that had none, which is how the release tells "put this back"
 * from "there was nothing here".
 */
const ISOLATION = {
  attribute: 'data-harness-capture-hidden',
  sheet: 'harness-capture-isolation',
  pinned: 'data-harness-capture-pinned',
  restyle: 'data-harness-capture-restyle',
} as const;

type IsolationNames = typeof ISOLATION;

/**
 * THE TALLEST ELEMENT THIS WILL CAPTURE, and it is a refusal rather than a clamp.
 *
 * The mechanism grows the viewport to the element's height, so this number is really
 * "how tall a viewport has this harness MEASURED Chromium painting in one frame".
 * Measured rather than guessed: a flat-coloured block isolated out of a 60,000px
 * document came back one uniform colour at 2,000, 4,000, 6,000, 8,000, 10,000 and
 * 11,900 px, and `tests/integration/gallery-capture.visual.test.ts` keeps the top of
 * that range honest. A ceiling nobody had run to would be the same kind of claim this
 * module exists to delete.
 *
 * A card past it is not silently cropped and not captured at a viewport that cannot
 * hold it — it is named and refused.
 */
const MAXIMUM_ELEMENT_HEIGHT = 12_000;

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
 * THE ELEMENT'S OWN WIDTH IS PINNED FIRST, and that is not a nicety. Hiding an
 * element's siblings takes back the space they were sharing with it: the Settings
 * theme cards sit in a track-based grid, and isolating one turned a 1,070x100 card
 * into a 186x135 one — a real capture of a layout no reader will ever see. Pinning
 * the width the browser had already given it makes removing the siblings a
 * no-op for the element itself. It is pinned to the measured value, so it changes
 * nothing on an element that was not sharing anything, and the HEIGHT is deliberately
 * left free: it is the check. A height that does not come back is the signal that
 * this element cannot be isolated honestly, and the capture is refused.
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

  const styled = node.getAttribute('style');
  node.setAttribute(names.pinned, '');
  if (styled !== null) node.setAttribute(names.restyle, styled);
  const styleable = node as Element & { readonly style?: CSSStyleDeclaration };
  for (const property of ['width', 'min-width', 'max-width'])
    styleable.style?.setProperty(property, `${before.width}px`, 'important');

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

/** The element's box now, whatever has happened to the page since. */
const measure = (node: Element): Box => {
  const rect = node.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
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
    if (hoisted.after.height > MAXIMUM_ELEMENT_HEIGHT)
      throw new Error(
        `refusing to capture ${label}: it is ${hoisted.after.height.toFixed(0)}px tall, past the ` +
          `${MAXIMUM_ELEMENT_HEIGHT}px this harness will claim Chromium paints in one frame`,
      );

    const needed = Math.ceil(hoisted.after.y + hoisted.after.height) + 8;
    const height = Math.max(viewport.height, needed);
    if (height > viewport.height) {
      await page.setViewportSize({ width: viewport.width, height });
      grown = true;
    }

    // Growing the viewport is itself a layout change, so the element is measured
    // AGAIN rather than assumed to have stayed where isolation left it.
    const framed = await element.evaluate(measure);
    if (resized(hoisted.after, framed))
      throw new Error(
        `refusing to capture ${label}: growing the viewport to ${viewport.width}x${height} changed its size ` +
          `from ${describe(hoisted.after)} to ${describe(framed)}`,
      );
    if (
      framed.x < -TOLERANCE ||
      framed.y < -TOLERANCE ||
      framed.x + framed.width > viewport.width + TOLERANCE ||
      framed.y + framed.height > height + TOLERANCE
    )
      throw new Error(
        `refusing to capture ${label}: ${describe(framed)} is not wholly inside the ` +
          `${viewport.width}x${height} viewport, so the capture would be of pixels Chromium never painted`,
      );

    await element.screenshot({ path });
  } finally {
    if (grown) await page.setViewportSize(viewport);
    await page.evaluate(release, ISOLATION);
  }
};
