/**
 * A CAPTURE THAT LIES IS THE FAILURE UNDER TEST, so this file looks at pixels.
 *
 * The gallery harness renders one document tens of thousands of pixels tall.
 * `locator.screenshot()` on a card low in it returns a PNG of the right size holding
 * content that is not that card's — no error, no warning. Every visual review of a
 * card low in the gallery has been reading whatever those pixels happened to be.
 *
 * WHY THE SUBJECT IS A SYNTHETIC PAGE AND NOT THE REAL GALLERY. The property is
 * about geometry, not about any particular surface: a card past the paint horizon,
 * taller than the viewport. A page of flat-coloured blocks makes the verdict
 * decidable rather than eyeballed — the capture of card N is correct exactly when
 * every pixel in it is card N's own colour, and there is no antialiasing, font
 * hinting or animation to argue about. The real gallery's evidence is the pair of
 * before/after PNGs in the pull request; this file is what fails when somebody
 * reaches for `locator.screenshot()` again.
 *
 * THE ASSERTIONS ARE ABOUT IDENTITY, NEVER ABOUT PRODUCTION. `should(png).not.be
 * .empty()` is precisely the shape of proof that let this defect through: a
 * screenshot was produced every single time. So the capture is decoded — by
 * Chromium, in the page, which is the only PNG decoder this repository already
 * has — and its pixels are counted.
 *
 * CHROMIUM ONLY. This is a Chromium repaint behaviour and the harness drives system
 * Chrome; the numbers here were measured on Chrome 141 headless. Another engine may
 * not have the defect at all, which would make the first test's `naive` half pass
 * for the wrong reason — it is written to name what it measured for that reason.
 */

import { afterAll, beforeAll, describe, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import should from 'should';
import { captureElement } from '../../harness/gallery-capture.ts';
import { sharedChromium } from './support/chromium.ts';

/** The viewport every case runs in — small enough that a 1,500px card cannot fit it. */
const VIEWPORT = { width: 900, height: 700 } as const;

const CARDS = 100;
const CARD_HEIGHT = 640;

/** The card the cases below reach for: deep in the document AND taller than the viewport. */
const DEEP_CARD = 57;
const DEEP_CARD_HEIGHT = 1_500;

/** A colour no two cards share, so a pixel names the card it came from. */
const cardColour = (index: number): readonly [number, number, number] => [
  (index * 2 + 7) % 256,
  (index * 5 + 31) % 256,
  (index * 11 + 3) % 256,
];

const cardCss = (index: number): string => `rgb(${cardColour(index).join(', ')})`;

/**
 * A gallery in miniature: one tall column of flat blocks under a locked `html`/`body`,
 * which is how the real harness page scrolls — `body` is the scroller and the document
 * element never moves.
 */
const galleryDocument = (): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>capture subject</title><style>
    html,body{height:100%;overflow:hidden;margin:0;background:#000}
    .card{width:300px;margin:0 auto 40px auto}
  </style></head><body>${Array.from({ length: CARDS }, (_, index) => {
    const height = index === DEEP_CARD ? DEEP_CARD_HEIGHT : CARD_HEIGHT;
    return `<section id="card-${index}" class="card" style="height:${height}px;background:${cardCss(index)}"></section>`;
  }).join('')}</body></html>`;

type Census = {
  readonly width: number;
  readonly height: number;
  readonly colours: readonly (readonly [string, number])[];
};

/**
 * Decode a PNG in the page and tally its colours, commonest first.
 *
 * Chromium is the decoder because it is already here and because it is the same
 * engine that wrote the file. Nothing about the tally depends on the module under
 * test.
 */
const census = async (page: Page, png: Buffer): Promise<Census> =>
  await page.evaluate(async (encoded: string) => {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.addEventListener('load', () => resolve(element));
      element.addEventListener('error', () => reject(new Error('the capture could not be decoded')));
      element.src = `data:image/png;base64,${encoded}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('this browser gave no 2d context to count pixels with');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    const tally = new Map<string, number>();
    for (let index = 0; index < data.length; index += 4) {
      const key = `${data[index]},${data[index + 1]},${data[index + 2]}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return {
      width: image.width,
      height: image.height,
      colours: [...tally.entries()].sort((left, right) => right[1] - left[1]),
    };
  }, png.toString('base64'));

/** What the page looks like when nothing has touched it: no isolation left behind. */
const residue = async (page: Page) =>
  await page.evaluate(() => ({
    hidden: document.querySelectorAll('[data-harness-capture-hidden]').length,
    pinned: document.querySelectorAll('[data-harness-capture-pinned]').length,
    restyled: document.querySelectorAll('[data-harness-capture-restyle]').length,
    sheets: document.querySelectorAll('#harness-capture-isolation').length,
    scrollHeight: document.body.scrollHeight,
  }));

const refusalOf = async (attempt: Promise<void>): Promise<string> =>
  await attempt.then(
    () => '(the capture was taken instead of refused)',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe('capturing one element of a very tall gallery', () => {
  let context: BrowserContext;
  let directory: string;

  beforeAll(async () => {
    context = await (await sharedChromium()).newContext({ viewport: { ...VIEWPORT } });
    directory = await mkdtemp(join(tmpdir(), 'fy-gallery-capture-'));
  });

  afterAll(async () => {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  });

  const subject = async (body?: string): Promise<Page> => {
    const page = await context.newPage();
    await page.setContent(body ?? galleryDocument());
    return page;
  };

  test('takes the deep card itself, where a plain locator screenshot does not', async () => {
    const page = await subject();
    try {
      const card = page.locator(`#card-${DEEP_CARD}`);
      await card.scrollIntoViewIfNeeded();
      const depth = await page.evaluate(() => document.body.scrollTop);
      const height = await page.evaluate(() => document.body.scrollHeight);
      should(height).be.above(60_000);
      should(depth).be.above(30_000);

      // WHAT THE GALLERY DID UNTIL NOW. The size is right, which is the whole
      // problem: nothing about this PNG announces that most of it is not the card.
      const naive = await census(page, await card.screenshot());
      should([naive.width, naive.height]).eql([300, DEEP_CARD_HEIGHT]);
      const own = cardColour(DEEP_CARD).join(',');
      const naiveOwn = naive.colours.find(([colour]) => colour === own)?.[1] ?? 0;
      should(naiveOwn).be.below(naive.width * naive.height);

      const target = join(directory, 'deep-card.png');
      await captureElement(page, card, target);
      const taken = await census(page, Buffer.from(await Bun.file(target).arrayBuffer()));
      should([taken.width, taken.height]).eql([300, DEEP_CARD_HEIGHT]);
      should(taken.colours.map(([colour]) => colour)).eql([own]);
    } finally {
      await page.close();
    }
  });

  test('takes a card that is NOT the one below it', async () => {
    const page = await subject();
    try {
      for (const index of [0, 20, DEEP_CARD, 80, 99]) {
        const target = join(directory, `card-${index}.png`);
        await captureElement(page, page.locator(`#card-${index}`), target);
        const taken = await census(page, Buffer.from(await Bun.file(target).arrayBuffer()));
        should(taken.colours.map(([colour]) => colour)).eql([cardColour(index).join(',')]);
      }
    } finally {
      await page.close();
    }
  });

  test('keeps the width a hidden sibling was sharing, rather than photographing the collapse', async () => {
    // The Settings theme cards are this shape: track-based siblings that hold each
    // other's width open. Isolating one without pinning turned a 1,070x100 card into
    // a 186x135 one on the real gallery — a faithful capture of a layout nobody sees.
    const page = await subject(
      `<!doctype html><html lang="en"><head><title>grid row</title></head><body style="margin:0">
        <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));width:600px">
          <div id="share" style="height:120px;background:#4488ff"></div>
          <div style="height:120px;background:#ff8844"></div>
          <div style="height:120px;background:#44ff88"></div>
        </div>
      </body></html>`,
    );
    try {
      const target = join(directory, 'share.png');
      await captureElement(page, page.locator('#share'), target);
      const taken = await census(page, Buffer.from(await Bun.file(target).arrayBuffer()));
      should([taken.width, taken.height]).eql([200, 120]);
      should(taken.colours.map(([colour]) => colour)).eql(['68,136,255']);
      should(await residue(page)).containDeep({ hidden: 0, pinned: 0, restyled: 0, sheets: 0 });
      // The pin is undone, style attribute and all, so the card is back in its track.
      should(await page.locator('#share').evaluate(node => node.getAttribute('style'))).equal(
        'height:120px;background:#4488ff',
      );
    } finally {
      await page.close();
    }
  });

  test('refuses an element that isolating would resize anyway', async () => {
    // A stretched flex item takes its HEIGHT from the sibling beside it, which is the
    // one dimension pinning deliberately leaves free — so this is the case the width
    // repair cannot rescue, and it is refused rather than captured at 300x0.
    const page = await subject(
      `<!doctype html><html lang="en"><head><title>stretched row</title></head><body style="margin:0">
        <div style="display:flex;align-items:stretch;width:600px">
          <div id="stretched" style="width:300px;background:#4488ff"></div>
          <div style="width:300px;height:400px;background:#ff8844"></div>
        </div>
      </body></html>`,
    );
    try {
      const refusal = await refusalOf(
        captureElement(page, page.locator('#stretched'), join(directory, 'stretched.png')),
      );
      should(refusal).match(
        /refusing to capture stretched\.png: isolating it changed its size from 300x400 at 0,0 to 300x0 at 0,0 even with its width held still/u,
      );
      should(await residue(page)).containDeep({ hidden: 0, pinned: 0, restyled: 0, sheets: 0 });
      should(page.viewportSize()).eql({ ...VIEWPORT });
    } finally {
      await page.close();
    }
  });

  test('paints a card right up to the ceiling it claims', async () => {
    // The ceiling is a number this harness ASSERTS Chromium can paint in one frame,
    // so a card just under it has to come back whole. Without this the refusal above
    // could be hiding a range that was never painted correctly in the first place.
    const page = await subject(
      `<!doctype html><html lang="en"><head><title>almost too tall</title><style>
        html,body{height:100%;overflow:hidden;margin:0;background:#000}
      </style></head><body>
        <div style="height:40000px;background:#111"></div>
        <div id="ceiling" style="width:300px;height:11900px;background:rgb(10, 200, 90)"></div>
        <div style="height:20000px;background:#222"></div>
      </body></html>`,
    );
    try {
      const target = join(directory, 'ceiling.png');
      await captureElement(page, page.locator('#ceiling'), target);
      const taken = await census(page, Buffer.from(await Bun.file(target).arrayBuffer()));
      should([taken.width, taken.height]).eql([300, 11_900]);
      should(taken.colours.map(([colour]) => colour)).eql(['10,200,90']);
    } finally {
      await page.close();
    }
  });

  test('refuses an element taller than one painted frame', async () => {
    const page = await subject(
      `<!doctype html><html lang="en"><head><title>too tall</title></head><body style="margin:0">
        <div id="endless" style="width:300px;height:13000px;background:#22cc55"></div>
      </body></html>`,
    );
    try {
      const refusal = await refusalOf(captureElement(page, page.locator('#endless'), join(directory, 'endless.png')));
      should(refusal).match(/refusing to capture endless\.png: it is 13000px tall, past the 12000px/u);
      should(await residue(page)).containDeep({ hidden: 0, sheets: 0 });
    } finally {
      await page.close();
    }
  });

  test('refuses an element that lives in another document', async () => {
    const page = await subject(
      `<!doctype html><html lang="en"><head><title>framed</title></head><body style="margin:0">
        <iframe title="framed card" style="width:400px;height:300px;border:0"
          srcdoc="&lt;body style='margin:0'&gt;&lt;div id='framed' style='width:200px;height:100px;background:#cc2255'&gt;&lt;/div&gt;&lt;/body&gt;"></iframe>
      </body></html>`,
    );
    try {
      const framed = page.frameLocator('iframe').locator('#framed');
      const refusal = await refusalOf(captureElement(page, framed, join(directory, 'framed.png')));
      should(refusal).match(/refusing to capture framed\.png: it is not in the top-level document/u);
      should(await residue(page)).containDeep({ hidden: 0, sheets: 0 });
    } finally {
      await page.close();
    }
  });

  test('gives the page back exactly as it was found', async () => {
    const page = await subject();
    try {
      const before = await residue(page);
      await captureElement(page, page.locator(`#card-${DEEP_CARD}`), join(directory, 'restored.png'));
      should(await residue(page)).eql(before);
      should(page.viewportSize()).eql({ ...VIEWPORT });
      // The next capture proves the restoration is REAL rather than merely tidy:
      // a document still holding the isolation sheet would hand back card 12 as an
      // empty rect or as the card that replaced it.
      const target = join(directory, 'after-restore.png');
      await captureElement(page, page.locator('#card-12'), target);
      const taken = await census(page, Buffer.from(await Bun.file(target).arrayBuffer()));
      should(taken.colours.map(([colour]) => colour)).eql([cardColour(12).join(',')]);
    } finally {
      await page.close();
    }
  });
});
