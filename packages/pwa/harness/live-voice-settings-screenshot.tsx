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
      <main data-live-scene="" style={{ margin: '0 auto', maxWidth: 760, padding: '12px 12px 24px' }}>
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
    <style>html, body { height: auto !important; overflow: visible !important; } /* the open voice list shows every row, so a review sees each vendor line */ .fy-ar-list { max-height: none !important; overflow: visible !important; }</style>
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
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(Bun.file(join(buildDir, url.pathname)));
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
/** Space left under the last row, in CSS px. */
const BOTTOM_MARGIN = 20;

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

/** The page's rows as [top, bottom] in page px: a cut may only fall in a gap between them. */
const rowSpans = (page: Page): Promise<[number, number][]> =>
  page.evaluate(() => {
    const atomic =
      'h3, h4, p, label, button, select, output, input, [role="alert"], [role="note"], [data-live-reading-summary], [data-live-screen-reader-hint]';
    const scroll = window.scrollY;
    return [...document.querySelectorAll<HTMLElement>(`[data-live-scene] :is(${atomic})`)]
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.height > 0)
      .map(rect => [rect.top + scroll, rect.bottom + scroll] as [number, number]);
  });

/**
 * The gaps BETWEEN GROUPS (a heading stays with its controls): the middle of the space between one top-level
 * block of the card and the next, and between the panel's own heading text and the card.
 */
const groupGaps = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const scroll = window.scrollY;
    const card = document.querySelector('[data-live-voice-settings]');
    if (card === null) return [];
    const blocks = [...card.children] as HTMLElement[];
    const gaps: number[] = [];
    for (let index = 0; index + 1 < blocks.length; index += 1) {
      const above = blocks[index]?.getBoundingClientRect().bottom ?? 0;
      const below = blocks[index + 1]?.getBoundingClientRect().top ?? 0;
      gaps.push(Math.round((above + below) / 2 + scroll));
    }
    return gaps;
  });

/**
 * The cut points for a page: at the largest gap BETWEEN GROUPS that still fills at least half a viewport, else
 * (a group taller than that) at the largest gap between rows. Never inside a row.
 */
const cutPoints = (
  spans: readonly [number, number][],
  gaps: readonly number[],
  total: number,
  viewport: number,
): number[] => {
  // A row counts a little beyond its box: text ink and focus rings reach past it.
  const insideARow = (y: number): boolean => spans.some(([top, bottom]) => top - 3 < y && y < bottom + 3);
  const cuts: number[] = [0];
  let start = 0;
  while (total - start > viewport) {
    const between = gaps.filter(gap => gap > start + viewport / 2 && gap <= start + viewport && !insideARow(gap));
    let cut = between.length > 0 ? Math.max(...between) : start + viewport;
    if (between.length === 0) {
      while (cut > start + 120 && insideARow(cut)) cut -= 1;
      // The middle of the free gap, so the ink of the rows either side is a few pixels away from the cut.
      const above = Math.max(start, ...spans.map(([, bottom]) => bottom).filter(bottom => bottom <= cut));
      const below = Math.min(total, ...spans.map(([top]) => top).filter(top => top >= cut));
      cut = Math.round((above + below) / 2);
    }
    if (cut <= start + 120) fail(`no gap between rows within ${viewport}px of ${start}`);
    cuts.push(cut);
    start = cut;
  }
  cuts.push(total);
  return cuts;
};

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
          await page.waitForTimeout(200);

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
          report[label] = {
            controls: controls.length,
            smallest: Math.min(...controls.map(control => control.height)),
            tallest: Math.max(...controls.map(control => control.height)),
          };

          const contentBottom = await page.evaluate(() => {
            const rects = [...document.querySelectorAll<HTMLElement>('[data-live-scene] *')].map(
              element => element.getBoundingClientRect().bottom + window.scrollY,
            );
            return Math.max(...rects);
          });
          const total = Math.ceil(contentBottom + BOTTOM_MARGIN);
          const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
          if (documentHeight < total) fail(`${label}: no margin below the last row (${documentHeight} < ${total})`);
          const cuts = cutPoints(await rowSpans(page), await groupGaps(page), total, viewport.height);
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
