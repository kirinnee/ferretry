/**
 * Screenshots of a ferret's agenda inside its chat, phone (390x844) and desktop (1440x900), light and dark:
 *
 *   chat-collapsed       the one line above the composer: "Agenda · 1 blocking · 5 need you · 2 with Ottilie"
 *   drawer-7             the drawer open with seven rows: 1 blocking, 4 need you, 2 with the ferret (dimmed)
 *   full-card            a decision: premise, context, decided so far, still open, terms, a diagram, a recommendation
 *   full-card-lower      the same card scrolled to its end: terms and the diagram
 *   full-card-diagram    "Show more" opened and scrolled to the end: the fy-render diagram drawn
 *   full-card-updated    the same after the ferret edited it: the new lines are marked
 *   full-card-revisions  …and its "Updated" list open
 *   composer-2-refs      two "re: <title> ✕" chips above the composer
 *   status-both / status-agenda-only / status-sending-only   the one-row line and "Sending…" on its right
 *   notification-tap     arriving by ?attention=A5: the chat with A5's full card
 *   inbox-sections / inbox-sections-lower / inbox-sections-open / inbox-warden-filter   the Inbox: three sections, With ferrets unfolded, "From Warden"
 *   desktop-docked-panel (desktop only) the "Agenda" header button docks the agenda beside the chat
 *
 *   bun harness/agenda-screenshot.ts      # writes harness/out/agenda/<scheme>/<phone|desktop>-<name>.png
 *
 * It bundles `agenda-page.tsx` (the real `useAttentionAgenda`, invented data), serves it on an ephemeral
 * loopback port, aborts anything that leaves it, drives it with real clicks, and FAILS (after writing every
 * picture) when: a page scrolls sideways; the composer's box moves between no agenda / the line / the drawer
 * / the full card / the chips / the status rows; the drawer is taller than 48% of the screen or touches the
 * composer; the full card spills over the header, the line or the composer, or scrolls in more than one place
 * (a diagram's own box excepted); a desktop button has an arrow; a phone answer button has none; a phone
 * touch target is under 44px; or the word "Attention" shows anywhere.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Locator, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out', 'agenda');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const html = (theme: string, entry: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/${entry}"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
run('bun', [
  'build',
  join(harnessDir, 'agenda-page.tsx'),
  join(harnessDir, 'inbox-page.tsx'),
  '--outdir',
  outDir,
  '--target',
  'browser',
]);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'app.css'),
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(
        html(
          url.searchParams.get('theme') ?? 'studio-dark',
          url.searchParams.get('page') === 'inbox' ? 'inbox-page.js' : 'agenda-page.js',
        ),
        {
          headers: { 'content-type': 'text/html' },
        },
      );
    const built = Bun.file(join(outDir, url.pathname));
    return new Response((await built.exists()) ? built : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
} as const;
const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;
/** The page's own clock, so "6 min ago" and "Needed by 17:00" read the same in every run. */
const NOW = new Date('2026-10-29T09:00:00.000Z');
const LOCALE = { timezoneId: 'UTC', locale: 'en-US' } as const;
type Form = 'phone' | 'desktop';

// ---- assertions: collected, so every picture is still written ----------------------------------------------

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const box = async (locator: Locator, label: string): Promise<Box | null> => {
  const found = await locator
    .first()
    .boundingBox()
    .catch(() => null);
  check(found !== null, `${label}: not on screen`);
  return found;
};

const open = async (context: BrowserContext, theme: string, label: string, query: string): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}?theme=${theme}&${query}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.waitForTimeout(150);
  await sound(page, label);
  return page;
};

/** Nothing scrolls sideways and the word "Attention" is nowhere on screen. */
const sound = async (page: Page, label: string): Promise<void> => {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${label}: scrolls sideways by ${wide}px`);
  const text = await page.evaluate(() => document.body.innerText);
  check(!/attention/i.test(text), `${label}: the word "Attention" is visible`);
};

const shot = async (page: Page, scheme: string, form: Form, name: string): Promise<void> => {
  const dir = join(outDir, scheme);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${form}-${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

/** Let a layer land, with the pointer parked: a tap leaves hover on the control under it. */
const settle = async (page: Page): Promise<void> => {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(120);
};

const composerOf = async (page: Page): Promise<Box | null> =>
  box(page.locator('[data-agenda-harness-composer]'), 'composer');

/** Every state's composer box must equal the first one measured for this form. */
const sameComposer = (reference: { box: Box | null; from: string }, now: Box | null, state: string): void => {
  if (reference.box === null || now === null) return;
  const same = Math.abs(reference.box.y - now.y) < 0.5 && Math.abs(reference.box.height - now.height) < 0.5;
  check(
    same,
    `composer moved in ${state}: ${Math.round(now.y)}+${Math.round(now.height)} vs ${Math.round(reference.box.y)}+${Math.round(reference.box.height)} (${reference.from})`,
  );
};

const row = (page: Page, id: string): Locator => page.locator(`[data-attention-agenda-row="${id}"]`);

const openDrawer = async (page: Page): Promise<void> => {
  await page.locator('[data-agenda-line-toggle]').click();
  await page.locator('[data-agenda-drawer]').waitFor({ state: 'visible' });
  await settle(page);
};

const openCard = async (page: Page, id: string): Promise<void> => {
  await openDrawer(page);
  await row(page, id).locator('[data-attention-row-open]').click();
  await page.locator(`[data-attention-full-card="${id}"]`).waitFor({ state: 'visible' });
  await settle(page);
};

/** The agenda line reads on ONE row: its name and every segment share a baseline. */
const oneRow = async (page: Page, label: string): Promise<void> => {
  const tops = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-agenda-line] .fy-agenda-line__name, [data-agenda-line] .fy-agenda-line__segment',
      ),
    ].map(element => Math.round(element.getBoundingClientRect().top)),
  );
  check(
    new Set(tops).size <= 1,
    `${label}: the agenda line wraps onto ${new Set(tops).size} rows (tops ${tops.join(', ')})`,
  );
};

/** The drawer is ≤ 48% of the screen and ends above the composer. */
const drawerFits = async (page: Page, label: string): Promise<void> => {
  const drawer = await box(page.locator('[data-agenda-drawer]'), `${label} drawer`);
  const composer = await composerOf(page);
  const high = page.viewportSize()?.height ?? 0;
  if (drawer === null || composer === null) return;
  check(
    drawer.height <= high * 0.48 + 0.5,
    `${label}: the drawer is ${Math.round(drawer.height)}px, over 48% of ${high}px`,
  );
  check(drawer.y + drawer.height <= composer.y + 0.5, `${label}: the drawer overlaps the composer`);
  const rows = await page.locator('[data-attention-agenda-row]').count();
  check(rows === 7, `${label}: the drawer has ${rows} rows, not 7`);
};

/** The full card sits over the transcript only, and scrolls in ONE place. */
const cardFits = async (page: Page, label: string): Promise<void> => {
  const card = await box(page.locator('[data-agenda-card]'), `${label} card`);
  const header = await box(page.locator('[data-agenda-harness-header]'), `${label} header`);
  const line = await box(page.locator('[data-agenda-line]'), `${label} line`);
  const composer = await composerOf(page);
  if (card === null || header === null || line === null || composer === null) return;
  const log = await box(page.locator('.fy-chat-log'), `${label} transcript`);
  if (log !== null)
    check(
      Math.abs(card.y - log.y) < 1 && Math.abs(card.height - log.height) < 1 && Math.abs(card.width - log.width) < 1,
      `${label}: the card (${Math.round(card.width)}x${Math.round(card.height)}) is not the transcript area (${Math.round(log.width)}x${Math.round(log.height)})`,
    );
  check(card.y >= header.y + header.height - 0.5, `${label}: the card covers the header`);
  check(card.y + card.height <= line.y + 0.5, `${label}: the card covers the agenda line`);
  check(line.y + line.height <= composer.y + 0.5, `${label}: the line is not above the composer`);
  const scrollers = await page.evaluate(() => {
    const card = document.querySelector('[data-agenda-card]');
    if (card === null) return [] as string[];
    return [card, ...card.querySelectorAll('*')]
      .filter(element => {
        if (element.closest('[data-fy-render-type]') !== null) return false;
        const style = getComputedStyle(element);
        return (
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          element.scrollHeight > element.clientHeight + 1
        );
      })
      .map(element => element.getAttribute('data-attention-full-scroll') ?? element.className.toString());
  });
  check(
    scrollers.length <= 1 && scrollers.every(name => name === ''),
    `${label}: the card scrolls in ${scrollers.length} places (${scrollers.join(' | ')})`,
  );
  const declared = await page
    .locator('[data-agenda-card] [data-attention-full-scroll]')
    .evaluate(element => getComputedStyle(element).overflowY)
    .catch(() => 'missing');
  check(declared === 'auto' || declared === 'scroll', `${label}: the card body is not the scroller (${declared})`);
};

/** Desktop buttons carry no arrows; phone answer buttons do. */
const arrows = async (page: Page, form: Form, label: string, card = false): Promise<void> => {
  const inChat = await page
    .locator('.kt-chat-surface svg[class*="lucide-arrow-"], [data-agenda-panel] svg[class*="lucide-arrow-"]')
    .count();
  if (form === 'desktop') {
    check(inChat === 0, `${label}: ${inChat} arrow icons on desktop buttons`);
    return;
  }
  if (!card) return;
  const answers = await page.locator('[data-agenda-card] [data-attention-answer]').count();
  const withArrow = await page
    .locator('[data-agenda-card] [data-attention-answer] svg[class*="lucide-arrow-"]')
    .count();
  check(answers > 0, `${label}: no answer buttons on the phone card`);
  check(withArrow === answers, `${label}: ${withArrow} of ${answers} phone answer buttons have an arrow`);
};

const TOUCH = [
  '[data-agenda-line-toggle]',
  '[data-attention-row-open]',
  '[data-attention-chip]',
  '[data-attention-add-reply]',
  '[data-agenda-chip-clear]',
  '[data-agenda-card] button',
].join(', ');

/** Every visible row chip and button is at least 44px each way on a phone. */
const touchTargets = async (page: Page, label: string): Promise<void> => {
  const small = await page.evaluate(selector => {
    const found: string[] = [];
    for (const element of document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width < 43.5 || rect.height < 43.5)
        found.push(
          `${(element.textContent ?? element.getAttribute('aria-label') ?? '').trim().slice(0, 24) || element.tagName} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        );
    }
    return found;
  }, TOUCH);
  check(small.length === 0, `${label}: touch targets under 44px: ${[...new Set(small)].join('; ')}`);
};

// ---- the shots ---------------------------------------------------------------------------------------------

const capture = async (context: BrowserContext, scheme: 'light' | 'dark', form: Form): Promise<void> => {
  const theme = `studio-${scheme}`;
  const at = (state: string): string => `${scheme} ${form} ${state}`;
  const reference: { box: Box | null; from: string } = { box: null, from: 'no agenda' };
  const phone = form === 'phone';

  // No agenda mode: the board is full and the chat shows nothing of it.
  let page = await open(context, theme, at('no-agenda'), 'view=none');
  check((await page.locator('[data-agenda-line]').count()) === 0, `${at('no-agenda')}: an agenda line shows`);
  reference.box = await composerOf(page);
  await page.close();

  // The line, the drawer, the chips.
  page = await open(context, theme, at('line'), 'view=board');
  const line = await page.locator('[data-agenda-line]').textContent();
  check(
    /1 blocking/.test(line ?? '') && /5 need you/.test(line ?? '') && /2 with Ottilie/.test(line ?? ''),
    `${at('line')}: the line reads "${line}"`,
  );
  await oneRow(page, at('line'));
  sameComposer(reference, await composerOf(page), at('the line'));
  await shot(page, scheme, form, 'chat-collapsed');
  await shot(page, scheme, form, 'status-agenda-only');
  await openDrawer(page);
  await sound(page, at('drawer'));
  sameComposer(reference, await composerOf(page), at('the drawer'));
  await drawerFits(page, at('drawer'));
  if (phone) await touchTargets(page, at('drawer'));
  await arrows(page, form, at('drawer'));
  await shot(page, scheme, form, 'drawer-7');
  for (const id of ['A3', 'A2']) {
    await row(page, id).locator('[data-attention-add-reply]').click();
    await settle(page);
  }
  await page.locator('[data-agenda-line-toggle]').click();
  await page.locator('[data-agenda-drawer]').waitFor({ state: 'hidden' });
  await settle(page);
  check((await page.locator('[data-agenda-chip]').count()) === 2, `${at('chips')}: expected two "re:" chips`);
  sameComposer(reference, await composerOf(page), at('two chips'));
  if (phone) await touchTargets(page, at('chips'));
  await shot(page, scheme, form, 'composer-2-refs');
  await page.close();

  // The full card.
  page = await open(context, theme, at('card'), 'view=board');
  await openCard(page, 'A5');
  await sound(page, at('full card'));
  sameComposer(reference, await composerOf(page), at('the full card'));
  await cardFits(page, at('full card'));
  await arrows(page, form, at('full card'), true);
  if (phone) await touchTargets(page, at('full card'));
  await shot(page, scheme, form, 'full-card');
  // The card is one scroller: its lower half (terms, the diagram) is reached by scrolling it, nothing else moves.
  await page
    .locator('[data-agenda-card] [data-attention-full-scroll]')
    .evaluate(element => element.scrollTo({ top: element.scrollHeight }));
  await settle(page);
  sameComposer(reference, await composerOf(page), at('the scrolled card'));
  await shot(page, scheme, form, 'full-card-lower');
  // "More detail" is folded; unfold it and the diagram (an fy-render image) must draw, still inside the one scroller.
  await page.locator('[data-agenda-card] [data-attention-body-toggle]').first().click();
  await page
    .locator('[data-agenda-card] [data-attention-full-scroll]')
    .evaluate(element => element.scrollTo({ top: element.scrollHeight }));
  await settle(page);
  check(
    await page
      .locator('[data-agenda-card] [data-attention-full-scroll] img')
      .first()
      .evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)
      .catch(() => false),
    `${at('full card')}: the diagram did not draw once "Show more" was opened`,
  );
  sameComposer(reference, await composerOf(page), at('the unfolded card'));
  await shot(page, scheme, form, 'full-card-diagram');
  await page.close();

  // …after the ferret edited it, and its "Updated" list.
  page = await open(context, theme, at('updated'), 'view=updated');
  await openCard(page, 'A5');
  check(
    (await page.locator('[data-agenda-card] [data-attention-changed]').count()) > 0,
    `${at('updated')}: no changed line is marked`,
  );
  await cardFits(page, at('updated card'));
  await page.locator('[data-agenda-card] [data-attention-changed]').first().scrollIntoViewIfNeeded();
  await settle(page);
  await shot(page, scheme, form, 'full-card-updated');
  await page.locator('[data-agenda-card] [data-attention-updated]').first().scrollIntoViewIfNeeded();
  await page.locator('[data-agenda-card] [data-attention-updated]').first().click();
  await page.locator('[data-attention-revisions]').waitFor({ state: 'visible' });
  // Scroll the card's own scroller (scrollIntoView would also nudge the hidden-overflow ancestors).
  await page.evaluate(() => {
    const body = document.querySelector('[data-agenda-card] [data-attention-full-scroll]');
    const updated = document.querySelector('[data-agenda-card] .fy-attn-updated');
    if (body !== null && updated !== null)
      body.scrollTop += updated.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
  });
  await settle(page);
  await cardFits(page, at('revisions card'));
  sameComposer(reference, await composerOf(page), at('the revisions list'));
  await shot(page, scheme, form, 'full-card-revisions');
  await page.close();

  // The status row: the line with "Sending…", and "Sending…" alone.
  page = await open(context, theme, at('status-both'), 'view=status-both');
  check(
    (await page.locator('[data-attention-sending-line]').count()) === 1 &&
      (await page.locator('[data-agenda-line]').count()) === 1,
    `${at('status-both')}: expected the line and "Sending…"`,
  );
  const lineBox = await box(page.locator('[data-agenda-line]'), at('status-both line'));
  check(
    (lineBox?.height ?? 0) <= 60,
    `${at('status-both')}: the status row is ${lineBox?.height}px tall — more than one row`,
  );
  await oneRow(page, at('status-both'));
  sameComposer(reference, await composerOf(page), at('status-both'));
  await shot(page, scheme, form, 'status-both');
  await page.close();

  page = await open(context, theme, at('status-sending'), 'view=status-sending');
  check(
    (await page.locator('[data-attention-sending-line]').count()) === 1 &&
      (await page.locator('[data-agenda-line]').count()) === 0,
    `${at('status-sending')}: expected "Sending…" alone`,
  );
  sameComposer(reference, await composerOf(page), at('status-sending'));
  await shot(page, scheme, form, 'status-sending-only');
  await page.close();

  // A notification tap.
  page = await open(context, theme, at('notification-tap'), 'view=board&attention=A5');
  await page.locator('[data-attention-full-card="A5"]').waitFor({ state: 'visible' });
  await settle(page);
  await cardFits(page, at('notification-tap'));
  sameComposer(reference, await composerOf(page), at('the notification tap'));
  await shot(page, scheme, form, 'notification-tap');
  await page.close();
};

/** The Inbox: three sections (With ferrets folded), then unfolded, then `/inbox?from=warden`. */
const captureInbox = async (context: BrowserContext, scheme: 'light' | 'dark', form: Form): Promise<void> => {
  const theme = `studio-${scheme}`;
  const at = (state: string): string => `${scheme} ${form} ${state}`;
  const rows = (page: Page) => page.locator('[data-attention-row]');
  const titles = async (page: Page): Promise<string> =>
    (await page.locator('[data-attention-section] h2').allInnerTexts()).join(' | ');

  let page = await open(context, theme, at('inbox-sections'), 'page=inbox&view=sections');
  const heads = await titles(page);
  check(
    /Stopped on you/.test(heads) && /Needs you/.test(heads) && /With ferrets/.test(heads),
    `${at('inbox-sections')}: expected the three sections, got "${heads}"`,
  );
  check(!/\bAttention\b/.test(heads), `${at('inbox-sections')}: a section says "Attention"`);
  const folded = await rows(page).count();
  check(
    (await page.locator('[data-attention-section="with-ferrets"] [data-attention-row]').count()) === 0,
    `${at('inbox-sections')}: With ferrets is not folded (${folded} rows)`,
  );
  if (form === 'phone') {
    const small = await page.evaluate(() => {
      const found: string[] = [];
      for (const element of document.querySelectorAll(
        '[data-attention-row], [data-attention-section-toggle], [data-attention-clear], [data-attention-filter-option], [data-attention-quick] button',
      )) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && (rect.height < 43.5 || rect.width < 43.5))
          found.push(`${element.tagName.toLowerCase()} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      }
      return found;
    });
    check(small.length === 0, `${at('inbox-sections')}: touch targets under 44px: ${[...new Set(small)].join('; ')}`);
  }
  await shot(page, scheme, form, 'inbox-sections');
  // …and the foot of the page: With ferrets, folded.
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && element.scrollHeight > element.clientHeight)
        element.scrollTop = element.scrollHeight;
    }
  });
  await settle(page);
  check(
    await page.locator('[data-attention-section-toggle="with-ferrets"]').isVisible(),
    `${at('inbox-sections')}: the folded With ferrets toggle is not reachable at the foot of the page`,
  );
  await shot(page, scheme, form, 'inbox-sections-lower');
  await page.close();

  page = await open(context, theme, at('inbox-sections-open'), 'page=inbox&view=sections-open');
  check(
    (await page.locator('[data-attention-section="with-ferrets"] [data-attention-row]').count()) > 0,
    `${at('inbox-sections-open')}: With ferrets shows no rows once open`,
  );
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && element.scrollHeight > element.clientHeight)
        element.scrollTop = element.scrollHeight;
    }
  });
  await settle(page);
  await shot(page, scheme, form, 'inbox-sections-open');
  await page.close();

  page = await open(context, theme, at('inbox-warden-filter'), 'page=inbox&view=warden');
  check(
    (await page.locator('[data-attention-from-chip="warden"]').count()) === 1,
    `${at('inbox-warden-filter')}: no "From Warden" chip`,
  );
  const kept = await rows(page).count();
  check(kept === 2, `${at('inbox-warden-filter')}: expected the Warden's 2 rows, got ${kept}`);
  check(
    (await page.locator('[data-attention-section="with-ferrets"]').count()) === 0,
    `${at('inbox-warden-filter')}: a ferret's section shows under the Warden filter`,
  );
  await shot(page, scheme, form, 'inbox-warden-filter');
  await page.locator('[data-attention-from-chip="warden"] button, [data-attention-from-chip="warden"]').last().click();
  await settle(page);
  check(
    (await page.locator('[data-attention-from-chip="warden"]').count()) === 0 && (await rows(page).count()) > kept,
    `${at('inbox-warden-filter')}: the chip did not lift the filter`,
  );
  await page.close();
};

/** The wide screen: the header's "Agenda" button docks the agenda beside the chat. */
const captureDocked = async (context: BrowserContext, scheme: 'light' | 'dark'): Promise<void> => {
  const theme = `studio-${scheme}`;
  const label = `${scheme} desktop docked`;
  const page = await open(context, theme, label, 'view=board');
  const before = await composerOf(page);
  await page.locator('[data-agenda-dock]').click();
  await page.locator('[data-agenda-panel]').waitFor({ state: 'visible' });
  await settle(page);
  await sound(page, label);
  const after = await composerOf(page);
  check(
    before !== null &&
      after !== null &&
      Math.abs(before.y - after.y) < 0.5 &&
      Math.abs(before.height - after.height) < 0.5,
    `${label}: docking moved the composer`,
  );
  check(
    (await page.locator('[data-agenda-panel] [data-attention-agenda-row]').count()) === 7,
    `${label}: the panel is not 7 rows`,
  );
  await arrows(page, 'desktop', label);
  await shot(page, scheme, 'desktop', 'docked-panel');
  await page.close();
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    const phone = await browser.newContext({ ...PHONE, colorScheme: scheme, reducedMotion: 'reduce', ...LOCALE });
    try {
      await capture(phone, scheme, 'phone');
      await captureInbox(phone, scheme, 'phone');
    } finally {
      await phone.close();
    }
    const desktop = await browser.newContext({ ...DESKTOP, colorScheme: scheme, reducedMotion: 'reduce', ...LOCALE });
    try {
      await capture(desktop, scheme, 'desktop');
      await captureInbox(desktop, scheme, 'desktop');
    } finally {
      await desktop.close();
    }
    const docked = await browser.newContext({ ...DESKTOP, colorScheme: scheme, reducedMotion: 'reduce', ...LOCALE });
    try {
      await captureDocked(docked, scheme);
    } finally {
      await docked.close();
    }
  }
} finally {
  await browser.close();
  server.stop();
}

writeFileSync(join(outDir, 'violations.txt'), violations.length === 0 ? 'none\n' : `${violations.join('\n')}\n`);
if (violations.length > 0) {
  process.stderr.write(
    `\n${violations.length} of ${checks} checks failed (listed in ${join(outDir, 'violations.txt')})\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `✅ the agenda captured; ${checks} checks held: the composer never moved, the card fits, one scroller\n`,
);
