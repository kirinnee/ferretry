/**
 * Screenshots of SETTINGS › BEHAVIOUR › LIVE VOICE (F137 slice 6): the real card, inside the real settings
 * panel, in every state — the defaults (with the one-time screen-reader hint), the hint answered, "no countdown"
 * and its warning, Thinker with a long countdown, sounds and buzzes off, reading off, and a voice with a very
 * long name, and the older-computer note. Phone (390) and desktop (1280), light and dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/live-voice-settings-screenshot.tsx
 *   FY_LIVE_SETTINGS_SHOTS_DIR=/tmp/shots bun harness/live-voice-settings-screenshot.tsx
 *
 * It FAILS (exit 1) when, in any scene:
 *   - a control is under 48 px tall (phone) or 44 px (desktop) — every button, switch, slider and choice is MEASURED;
 *   - a switch is not a real `role="switch"` with `aria-checked`, or does not say On or Off in words;
 *   - text is clipped sideways (a voice or vendor name that does not fit), or the page scrolls sideways;
 *   - a page cut would land inside a row, leave a blank strip, or leave no margin below the last row.
 *
 * A page taller than the viewport is cut into parts ONLY at the gaps between rows. Everything on screen is
 * invented, and the fake voice makes no sound.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = process.env.FY_LIVE_SETTINGS_SHOTS_DIR ?? join(buildDir, 'live-voice-settings');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AutoReadSettings } from '../../src/features/settings/auto-read-settings.tsx';
import { LiveVoiceSettingsSection } from '../../src/features/settings/live-voice-settings.tsx';
import { settingDefinition } from '../../src/features/settings/settings-catalog.ts';
import { SettingsSection } from '../../src/features/settings/settings-page.tsx';
import { LiveVoiceSettingsProvider } from '../../src/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../src/hooks/use-read-aloud.ts';
import { LiveVoiceSettingsStore } from '../../src/lib/voice-chat/live-settings.ts';
import type { SpeakerPort, SpeakerVoice } from '../../src/lib/voice-chat/ports.ts';
import { createReadAloud } from '../../src/lib/voice-chat/read-aloud.ts';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'defaults';

const VOICES: readonly SpeakerVoice[] = [
  { id: 'a', name: 'Samantha', lang: 'en-US', local: true, isDefault: true },
  { id: 'b', name: 'Daniel', lang: 'en-GB', local: true, isDefault: false },
  // A long name from a vendor that gets the text: the picker, the "Chosen" line and the summary must all say so.
  { id: 'long', name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', local: false, isDefault: false },
];

// A speaker that makes no sound.
const quiet: SpeakerPort = {
  supported: true,
  voices: () => VOICES,
  unlock: () => undefined,
  speak: () => undefined,
  stop: () => undefined,
};

const controller = createReadAloud({ speaker: quiet, language: () => 'en-US' });
const memory = new Map<string, string>();
const store = new LiveVoiceSettingsStore({ getItem: key => memory.get(key) ?? null, setItem: (key, value) => void memory.set(key, value) });
if (scene === 'hint-answered') store.update({ screenReaderHintSeen: true });
if (scene === 'countdown-zero') store.update({ sendWithoutCountdown: true, screenReaderHintSeen: true });
if (scene === 'thinker') store.update({ pause: 'thinker', countdownMs: 4000, screenReaderHintSeen: true });
if (scene === 'sounds-off') store.update({ earcons: false, haptics: false, screenReaderHintSeen: true });
if (scene === 'reading-off') store.update({ liveRead: false, keepAwake: false, screenReaderHintSeen: true });
if (scene === 'long-voice') store.update({ voiceId: 'long', rate: 1.8, maxSeconds: null, screenReaderHintSeen: true });
if (scene === 'older-machine') store.update({ autoRead: true, screenReaderHintSeen: true });

function Driver() {
  useEffect(() => {
    document.body.dataset.ready = '1';
  }, []);
  return null;
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <LiveVoiceSettingsProvider store={store}>
    <ReadAloudProvider controller={controller}>
      <Driver />
      <main data-live-scene="" style={{ margin: '0 auto', maxWidth: 760, padding: '12px 12px 40px' }}>
        <SettingsSection definition={settingDefinition('live-voice')}>
          <LiveVoiceSettingsSection />
        </SettingsSection>
        {scene === 'long-voice' || scene === 'older-machine' ? (
          <div style={{ marginTop: 12 }} className="kt-panel p-panel">
            <AutoReadSettings olderMachine={scene === 'older-machine'} startOpen={scene === 'long-voice'} />
          </div>
        ) : null}
      </main>
    </ReadAloudProvider>
  </LiveVoiceSettingsProvider>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>*, *::before, *::after { transition: none !important; animation: none !important; } html, body { height: auto !important; overflow: visible !important; } /* the open voice list shows every row, so a review sees each vendor line */ .fy-ar-list { max-height: none !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/live-settings-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
await Bun.write(join(buildDir, 'live-settings-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'live-settings-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    const file = Bun.file(join(buildDir, url.pathname));
    // A font the page asks for by its unhashed name is not part of the build: answer 404, never a crash.
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true, minimum: 48 },
  { name: 'desktop', width: 1280, height: 800, mobile: false, minimum: 44 },
] as const;
const SCENES = [
  'defaults',
  'hint-answered',
  'countdown-zero',
  'thinker',
  'sounds-off',
  'reading-off',
  'long-voice',
  'older-machine',
] as const;

interface Measured {
  readonly name: string;
  readonly height: number;
}

/** Every control the person can press or drag, measured in the page: its box, not its CSS. */
const measureControls = (page: Page): Promise<Measured[]> =>
  page.evaluate(() => {
    // The Live card, and (in the scenes that show it) the Read replies aloud card beside it with its voice picker.
    const sections = [...document.querySelectorAll('[data-live-voice-settings], [data-auto-read-settings]')];
    if (sections.length === 0) return [];
    const controls = sections.flatMap(section => [
      ...section.querySelectorAll<HTMLElement>('button, select, input[type="range"], label:has(input[type="radio"])'),
    ]);
    return controls.map(control => ({
      name: ((control.getAttribute('aria-label') ?? control.textContent) || control.tagName).trim().slice(0, 48),
      height: Math.round(control.getBoundingClientRect().height * 10) / 10,
    }));
  });

/** Rules that are about meaning, not pixels: switches are real switches that say On or Off. */
const checkSwitches = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-live-voice-settings] [role="switch"]')].flatMap(toggle => {
      const problems: string[] = [];
      if (toggle.tagName !== 'BUTTON') problems.push(`${toggle.textContent}: not a button`);
      if (toggle.getAttribute('aria-checked') !== 'true' && toggle.getAttribute('aria-checked') !== 'false')
        problems.push(`${toggle.textContent}: no aria-checked`);
      if (!/(On|Off)$/.test((toggle.textContent ?? '').trim()))
        problems.push(`${toggle.textContent}: does not say On or Off`);
      const track = toggle.querySelector<HTMLElement>('.fy-ar-track')?.getBoundingClientRect();
      const thumb = toggle.querySelector<HTMLElement>('.fy-ar-thumb')?.getBoundingClientRect();
      if (track === undefined || thumb === undefined || track.width < 40 || thumb.width < 16)
        problems.push(`${toggle.textContent}: no visible track and thumb`);
      return problems;
    }),
  );

/** Text that does not fit sideways: anything whose content is wider than its box. */
const clippedText = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-live-scene] *')]
      .filter(element => element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0)
      .filter(element => getComputedStyle(element).display !== 'inline')
      .map(element => `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 50)}"`),
  );

/**
 * Everything a cut must not touch, as [top, bottom] in page px: EVERY line of text on the page (measured from the
 * text itself, so a group label or heading in a plain span or div is as protected as a paragraph), plus the box of
 * every control and every boxed block. A cut may only fall in a gap between these.
 */
const rowSpans = (page: Page): Promise<[number, number][]> =>
  page.evaluate(() => {
    const scroll = window.scrollY;
    const spans: [number, number][] = [];
    const scene = document.querySelector('[data-live-scene]');
    if (scene === null) return spans;
    const walker = document.createTreeWalker(scene, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? '').trim() === '') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects())
        if (rect.height > 0) spans.push([rect.top + scroll, rect.bottom + scroll]);
    }
    const boxed =
      'button, select, output, input, label, fieldset, [role="alert"], [role="note"], [data-live-reading-summary], [data-live-screen-reader-hint], [aria-hidden="true"]';
    for (const element of scene.querySelectorAll<HTMLElement>(boxed)) {
      const rect = element.getBoundingClientRect();
      if (rect.height > 0) spans.push([rect.top + scroll, rect.bottom + scroll]);
    }
    // A label and the control it names are one row: a cut between them would leave the label alone.
    for (const label of scene.querySelectorAll<HTMLLabelElement>('label[for]')) {
      const control = document.getElementById(label.htmlFor);
      if (control === null) continue;
      const a = label.getBoundingClientRect();
      const b = control.getBoundingClientRect();
      spans.push([Math.min(a.top, b.top) + scroll, Math.max(a.bottom, b.bottom) + scroll]);
    }
    return spans;
  });

/**
 * The gaps BETWEEN GROUPS (a heading stays with its controls): the middle of the space between one top-level
 * block of the card and the next, and between the panel's own heading text and the card.
 */
const groupGaps = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const scroll = window.scrollY;
    const blocks = [...document.querySelectorAll<HTMLElement>('[data-live-voice-settings], [data-auto-read-settings]')]
      .flatMap(card => [...card.children] as HTMLElement[])
      .map(block => block.getBoundingClientRect())
      .filter(rect => rect.height > 0)
      .sort((x, y) => x.top - y.top);
    const gaps: number[] = [];
    for (let index = 0; index + 1 < blocks.length; index += 1) {
      const above = blocks[index]?.bottom ?? 0;
      const below = blocks[index + 1]?.top ?? 0;
      if (below >= above) gaps.push(Math.round((above + below) / 2 + scroll));
    }
    return gaps;
  });

/**
 * Makes the free space at a cut at least `extra` px taller by pushing down the outermost block that starts in the
 * gap [from, to] (page px). Only content BELOW the cut moves, so cuts already made stay where they are.
 */
const widenGap = (page: Page, from: number, to: number, extra: number): Promise<boolean> =>
  page.evaluate(
    ([top, bottom, push]: readonly [number, number, number]) => {
      const scroll = window.scrollY;
      const scene = document.querySelector('[data-live-scene]');
      if (scene === null) return false;
      const starts = [...scene.querySelectorAll<HTMLElement>('*')]
        .map(element => ({ element, y: element.getBoundingClientRect().top + scroll }))
        .filter(({ element, y }) => {
          const display = getComputedStyle(element).display;
          return (
            y >= top - 0.5 && y <= bottom + 12 && display !== 'inline' && display !== 'contents' && display !== 'none'
          );
        });
      const first = starts.reduce<number>((least, { y }) => Math.min(least, y), Number.POSITIVE_INFINITY);
      const block = starts.find(({ y }) => y - first < 0.5)?.element;
      if (block === undefined) return false;
      block.style.marginTop = `${(Number.parseFloat(getComputedStyle(block).marginTop) || 0) + push}px`;
      return true;
    },
    [from, to, extra] as const,
  );

/** The free space kept on each side of a cut, in CSS px: a part never ends or starts closer than this to a row. */
const CUT_MARGIN = 24;

/**
 * The cut points for a page, found one at a time (a cut may push the rest of the page down to make room, so the
 * layout is measured again after each). A cut falls at a gap BETWEEN GROUPS when one fits in the viewport, else
 * at the gap between rows that ends lowest — never inside a row — and the gap is widened until a part has
 * CUT_MARGIN of free space under its last row and over the next part's first row.
 */
const cutPoints = async (page: Page, viewport: number): Promise<number[]> => {
  const cuts: number[] = [0];
  let start = 0;
  for (;;) {
    const total = await pageEnd(page);
    if (total - start <= viewport) {
      cuts.push(total);
      return cuts;
    }
    // A row counts a little beyond its box: text ink and focus rings reach past it.
    const spans = (await rowSpans(page))
      .map(([top, bottom]): [number, number] => [top - 3, bottom + 3])
      .sort((x, y) => x[0] - y[0]);
    const rows: [number, number][] = [];
    for (const span of spans) {
      const last = rows.at(-1);
      if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else rows.push([span[0], span[1]]);
    }
    // Free gaps [above, below] between two rows, whose upper row ends where a part could still end.
    const free = rows
      .slice(0, -1)
      .map((row, index): [number, number] => [row[1], rows[index + 1]?.[0] ?? row[1]])
      .filter(([above]) => above > start + viewport / 2 && above + CUT_MARGIN <= start + viewport);
    const groups = new Set(await groupGaps(page));
    const grouped = free.filter(([above, below]) => [...groups].some(gap => gap > above && gap < below));
    const pool = grouped.length > 0 ? grouped : free;
    const chosen = pool.reduce<[number, number] | undefined>(
      (best, gap) => (best === undefined || gap[0] > best[0] ? gap : best),
      undefined,
    );
    if (chosen === undefined) fail(`no gap between rows within ${viewport}px of ${start}`);
    const [above, below] = chosen as [number, number];
    let bottom = below;
    if (bottom - above < 2 * CUT_MARGIN) {
      if (!(await widenGap(page, above - 3, below + 3, 2 * CUT_MARGIN - (bottom - above))))
        fail(`cannot make room for a cut at ${above}`);
      bottom = above + 2 * CUT_MARGIN;
    }
    const cut = Math.round(
      Math.min(Math.max((above + bottom) / 2, above + CUT_MARGIN), bottom - CUT_MARGIN, start + viewport),
    );
    if (cut <= start + 120) fail(`no gap between rows within ${viewport}px of ${start}`);
    cuts.push(cut);
    start = cut;
  }
};

/** Where the page ends: the last element's bottom plus the margin the last row keeps. */
const pageEnd = (page: Page): Promise<number> =>
  page.evaluate(
    margin =>
      Math.ceil(
        Math.max(
          ...[...document.querySelectorAll<HTMLElement>('[data-live-scene] *')].map(
            element => element.getBoundingClientRect().bottom + window.scrollY,
          ),
        ) + margin,
      ),
    CUT_MARGIN,
  );

try {
  const report: Record<string, unknown> = {};
  for (const scheme of ['light', 'dark'] as const) {
    mkdirSync(join(outDir, scheme), { recursive: true });
    for (const viewport of VIEWPORTS) {
      for (const scene of SCENES) {
        const label = `${scheme} ${viewport.name} ${scene}`;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 2,
          isMobile: viewport.mobile,
          hasTouch: viewport.mobile,
          timezoneId: 'Asia/Tokyo',
          colorScheme: scheme,
          reducedMotion: 'reduce',
        });
        try {
          await context.route('**/*', async route => {
            if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
            return await route.continue();
          });
          const page = await context.newPage();
          page.on('pageerror', error => fail(`page error in ${label}: ${error.message}`));
          await page.goto(`${server.url}?theme=studio-${scheme}&scene=${scene}`);
          await page.locator('body[data-ready="1"]').waitFor({ state: 'attached' });
          await page.locator('[data-live-voice-settings]').waitFor({ state: 'visible' });
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(400);

          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${label} scrolls sideways by ${overflow}px`);
          const controls = await measureControls(page);
          const small = controls.filter(control => control.height < viewport.minimum);
          if (small.length > 0)
            fail(
              `${label}: controls under ${viewport.minimum}px: ${small.map(c => `${c.name} ${c.height}`).join('; ')}`,
            );
          const jargon = await page.evaluate(() =>
            /daemon/i.test(document.querySelector('[data-live-scene]')?.textContent ?? ''),
          );
          if (jargon) fail(`${label}: the word "daemon" is on screen`);
          const thisDevice = await page.evaluate(
            () =>
              [...document.querySelectorAll<HTMLElement>('[data-live-voice-settings] *')].filter(
                element => element.children.length === 0 && element.textContent === 'This device',
              ).length,
          );
          if (thisDevice !== 1) fail(`${label}: the Live voice card shows the "This device" badge ${thisDevice} times`);
          const switches = await checkSwitches(page);
          if (switches.length > 0) fail(`${label}: ${switches.join('; ')}`);
          const clipped = await clippedText(page);
          if (clipped.length > 0) fail(`${label}: clipped text: ${clipped.join('; ')}`);
          const layout = await page.evaluate(() => {
            const size = (element: Element | null): number =>
              element === null ? 0 : Number.parseFloat(getComputedStyle(element).fontSize);
            const helper = size(document.querySelector('[data-live-voice-settings] p.text-meta'));
            const trigger = document.querySelector('.fy-ar-picker-trigger');
            const chevron = trigger?.querySelector('svg.fy-ar-chevron')?.getBoundingClientRect();
            const edge = trigger?.getBoundingClientRect();
            return {
              helper,
              where: [...document.querySelectorAll('.fy-ar-voice-where')].map(size),
              // The lines a tag such as "· en-US" sits on: one, never "en-" over "US".
              langLines: [...document.querySelectorAll('.fy-ar-list .whitespace-nowrap')].map(
                element => new Set([...element.getClientRects()].map(rect => Math.round(rect.top))).size,
              ),
              chevron: chevron === undefined ? null : { width: chevron.width, height: chevron.height },
              chevronGap: chevron === undefined || edge === undefined ? 0 : edge.right - chevron.right,
            };
          });
          if (layout.where.some(value => Math.abs(value - layout.helper) > 0.1))
            fail(`${label}: a voice's "where" line is ${layout.where.join('/')}px, helper text is ${layout.helper}px`);
          if (layout.langLines.some(lines => lines !== 1))
            fail(`${label}: a language tag such as en-US breaks across lines`);
          if (
            layout.chevron !== null &&
            (layout.chevron.width !== 20 || layout.chevron.height !== 20 || layout.chevronGap > 24)
          )
            fail(
              `${label}: the picker chevron is ${layout.chevron.width}x${layout.chevron.height} ${layout.chevronGap}px from the edge`,
            );
          report[label] = {
            controls: controls.length,
            smallest: Math.min(...controls.map(control => control.height)),
            tallest: Math.max(...controls.map(control => control.height)),
          };

          const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
          if (documentHeight < (await pageEnd(page))) fail(`${label}: no margin below the last row`);
          const cuts = await cutPoints(page, viewport.height);
          const total = cuts.at(-1) ?? 0;
          const finalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
          if (finalHeight < total) fail(`${label}: the page ends before the last part (${finalHeight} < ${total})`);
          const finalRows = await rowSpans(page);
          for (const cut of cuts.slice(1, -1)) {
            const above = Math.max(0, ...finalRows.map(([, bottom]) => bottom).filter(bottom => bottom <= cut));
            const below = Math.min(
              Number.POSITIVE_INFINITY,
              ...finalRows.map(([top]) => top).filter(top => top >= cut),
            );
            if (finalRows.some(([top, bottom]) => top < cut && cut < bottom))
              fail(`${label}: a cut at ${cut} is inside a row`);
            if (cut - above < CUT_MARGIN - 1 || below - cut < CUT_MARGIN - 1)
              fail(
                `${label}: a cut at ${cut} leaves ${Math.round(cut - above)}px under and ${Math.round(below - cut)}px over its rows`,
              );
          }
          const parts = cuts.length - 1;
          for (let part = 0; part < parts; part += 1) {
            const from = cuts[part] ?? 0;
            const to = cuts[part + 1] ?? total;
            const suffix = parts === 1 ? '' : `-part${part + 1}`;
            const target = join(outDir, scheme, `${scene}-${viewport.name}${suffix}.png`);
            await page.screenshot({
              path: target,
              fullPage: true,
              clip: { x: 0, y: from, width: viewport.width, height: to - from },
            });
            process.stdout.write(`📸 ${target}\n`);
          }
        } finally {
          await context.close();
        }
      }
    }
  }
  writeFileSync(join(outDir, 'measured-controls.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`📏 ${join(outDir, 'measured-controls.json')}\n`);
} finally {
  await browser.close();
  server.stop();
}
