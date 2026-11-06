/**
 * Screenshots of AUTO-READ REPLIES (F137 slice 2): the Settings › Voice › "Read replies aloud" section and the
 * "Reading the reply" chip beside the REAL composer. Phone (390) and desktop (1280), light and dark. Review
 * evidence; nothing compares the PNGs — but the script MEASURES, and fails when:
 *
 *   - any interactive control is shorter than 48 px on the phone / 44 px on the desktop,
 *   - the speed thumb is under 28 px,
 *   - a voice name or the "sends text to <vendor>" line is cut at its edge (scrollWidth > clientWidth),
 *   - a page scrolls sideways.
 *
 *   bun harness/auto-read-screenshot.tsx             # writes <out>/<light|dark>/<scene>-<phone|desktop>[-partN].png
 *   FY_AUTO_READ_SHOTS_DIR=/tmp/shots bun harness/auto-read-screenshot.tsx
 *
 * It renders the REAL settings section, chip and Composer with a controller over a FAKE speaker that makes no sound.
 * Everything on screen is invented. A settings page taller than the viewport is cut ONLY between its blocks (the
 * header, the switch, the voice, the speed, ...), each part holding whole blocks with a margin round them and no
 * blank strip, so no row is ever sliced.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = process.env.FY_AUTO_READ_SHOTS_DIR ?? join(buildDir, 'auto-read');

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
import { AutoReadChip } from '../../src/components/auto-read-chip.tsx';
import { Composer } from '../../src/components/composer.tsx';
import { AutoReadSettings } from '../../src/features/settings/auto-read-settings.tsx';
import { ReadAloudProvider } from '../../src/hooks/use-read-aloud.ts';
import { LiveVoiceSettingsProvider } from '../../src/hooks/use-live-voice-settings.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import type { SpeakerEvent, SpeakerPort, SpeakerVoice } from '../../src/lib/voice-chat/ports.ts';
import { createReadAloud } from '../../src/lib/voice-chat/read-aloud.ts';
import { LiveVoiceSettingsStore, readOptionsOf } from '../../src/lib/voice-chat/live-settings.ts';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'off';
const older = params.get('older') === '1';

// The longest names a browser really lists: Chrome's "Google UK English Female", Edge's "Microsoft … Online (Natural)".
const LONG = 'Microsoft Aria Online (Natural) - English (United States)';
const VOICES: readonly SpeakerVoice[] = [
  { id: 'a', name: 'Samantha', lang: 'en-US', local: true, isDefault: true },
  { id: 'b', name: 'Daniel', lang: 'en-GB', local: true, isDefault: false },
  { id: 'c', name: 'Karen', lang: 'en-AU', local: true, isDefault: false },
  { id: 'g', name: 'Google US English', lang: 'en-US', local: false, isDefault: false },
  { id: 'h', name: 'Google UK English Female', lang: 'en-GB', local: false, isDefault: false },
  { id: 'm', name: LONG, lang: 'en-US', local: false, isDefault: false },
];

// A speaker that makes no sound: it only reports the first sentence as being said.
const quiet = (): SpeakerPort => {
  let hear: ((event: SpeakerEvent) => void) | null = null;
  return {
    supported: true,
    voices: () => VOICES,
    unlock: () => undefined,
    speak: (_request, onEvent) => {
      hear = onEvent;
      onEvent({ type: 'segment', index: 0 });
    },
    stop: () => hear?.({ type: 'stopped' }),
  };
};

const controller = createReadAloud({ speaker: quiet(), language: () => 'en-US' });
const memory = new Map<string, string>();
const store = new LiveVoiceSettingsStore({ getItem: key => memory.get(key) ?? null, setItem: (key, value) => void memory.set(key, value) });
const settingsScenes = ['off', 'on', 'voices', 'remote', 'remote-long', 'preview', 'preview-remote'];
if (scene !== 'off' && scene !== 'chip-off') store.update({ autoRead: true });
if (scene === 'remote' || scene === 'preview-remote' || scene === 'chip-remote') store.update({ voiceId: 'g', rate: 1.4 });
if (scene === 'remote-long') store.update({ voiceId: 'm', rate: 1.4 });
if (scene === 'voices' || scene === 'preview') store.update({ voiceId: 'b', rate: 1.3, maxSeconds: 120, whatToRead: 'every' });

function Driver() {
  useEffect(() => {
    if (scene === 'preview' || scene === 'preview-remote') document.querySelector<HTMLButtonElement>('[data-preview]')?.click();
    if (scene === 'chip' || scene === 'chip-remote') controller.read('a1', 'The fix is in. All tests pass.', readOptionsOf(store.get()));
    document.body.dataset.ready = '1';
  }, []);
  return null;
}

const draftMemory = new Map<string, string>();
const drafts = new DaemonDraftStore({ getItem: key => draftMemory.get(key) ?? null, setItem: (key, value) => void draftMemory.set(key, value) });
const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'harness' });
writeMdComposePref('off');

function ChatEdge() {
  const reading = scene === 'chip' || scene === 'chip-remote';
  const compact = window.matchMedia('(max-width: 600px)').matches;
  return (
    <div data-auto-read-scene="" style={{ background: 'var(--bg)', margin: '0 auto', maxWidth: 760, padding: '12px 0' }}>
      <p style={{ margin: '0 16px 12px', fontSize: 15, lineHeight: 1.45 }}>
        <strong>dotty</strong> · The fix is in. All tests pass, and the branch is ready for your review.
      </p>
      <div className="fy-chat-input" data-session-input="" style={{ position: 'static' }}>
        <div className="fy-chat-input__column" style={{ paddingInline: 12 }}>
          <AutoReadChip onStop={() => controller.stop()} reading={reading} />
          <Composer api={{ send: async () => ({}) as never }} compact={compact} daemon={daemon} draftStore={drafts} sessionId="harness-auto-read" />
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <LiveVoiceSettingsProvider store={store}>
    <ReadAloudProvider controller={controller}>
      <Driver />
      {settingsScenes.includes(scene) ? (
        <main data-auto-read-scene="" style={{ margin: '0 auto', maxWidth: 760, padding: '16px 16px 40px' }}>
          <AutoReadSettings olderMachine={older} startOpen={scene === 'voices'} />
        </main>
      ) : (
        <ChatEdge />
      )}
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
    <style>html, body { height: auto !important; overflow: visible !important; }
      /* The shot of the voice list shows EVERY row whole, so the scroll cap is lifted here only. */
      .fy-ar-list { max-height: none !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/auto-read-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
await Bun.write(join(buildDir, 'auto-read-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'auto-read-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
    // The stylesheet names Inter by a path the Tailwind CLI does not rewrite: serve the real file.
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1280, height: 800, mobile: false },
] as const;
// [scene, extra query]: the old-machine note is its own shot, so the others show a machine that dates turns.
const SCENES: readonly (readonly [string, string])[] = [
  ['off', ''],
  ['on', ''],
  ['on-older-machine', '&older=1'],
  ['voices', ''],
  ['remote', ''],
  ['remote-long', ''],
  ['preview', ''],
  ['preview-remote', ''],
  ['chip-off', ''],
  ['chip-idle-on', ''],
  ['chip', ''],
  ['chip-remote', ''],
];
const SETTINGS = new Set([
  'off',
  'on',
  'on-older-machine',
  'voices',
  'remote',
  'remote-long',
  'preview',
  'preview-remote',
]);

/** What a control must measure, in CSS px, on this viewport. */
const FLOOR = { phone: 48, desktop: 44 } as const;

try {
  for (const scheme of ['light', 'dark'] as const) {
    mkdirSync(join(outDir, scheme), { recursive: true });
    for (const viewport of VIEWPORTS) {
      for (const [scene, extra] of SCENES) {
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
          page.on('pageerror', error => fail(`page error in ${scene}: ${error.message}`));
          const sceneId = scene === 'on-older-machine' ? 'on' : scene === 'chip-idle-on' ? 'chip-idle' : scene;
          await page.goto(`${server.url}?theme=studio-${scheme}&scene=${sceneId}${extra}`);
          await page.locator('body[data-ready="1"]').waitFor({ state: 'attached' });
          await page.locator('[data-auto-read-scene]').waitFor({ state: 'visible' });
          await page.evaluate(() => document.fonts.ready);
          const tag = `${scheme} ${viewport.name} ${scene}`;
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${tag} scrolls sideways by ${overflow}px`);
          await page.waitForTimeout(200);

          // ---- MEASURE: tap targets, the slider thumb, and clipped words.
          const floor = FLOOR[viewport.name];
          const measured = await page.evaluate(() => {
            const rect = (el: Element) => el.getBoundingClientRect();
            const targets: { what: string; height: number }[] = [];
            const add = (what: string, el: Element | null) => {
              if (el) targets.push({ what, height: Math.round(rect(el).height * 10) / 10 });
            };
            const root = document.querySelector('[data-auto-read-scene]');
            add('switch row', root?.querySelector('[role="switch"]') ?? null);
            add('voice button', root?.querySelector('#auto-read-voice') ?? null);
            for (const [i, el] of [...(root?.querySelectorAll('.fy-ar-row') ?? [])].entries())
              add(`voice row ${i + 1}`, el);
            add('preview button', root?.querySelector('[data-preview]') ?? null);
            add('speed slider', root?.querySelector('#auto-read-rate') ?? null);
            add('longest-reading select', root?.querySelector('#auto-read-length') ?? null);
            for (const [i, el] of [
              ...(root?.querySelectorAll('[role="radiogroup"][aria-labelledby="auto-read-what"] label') ?? []),
            ].entries())
              add(`what-to-read row ${i + 1}`, el);
            add('chip stop button', root?.querySelector('[data-auto-read] button') ?? null);
            add('composer send/attach buttons (first)', root?.querySelector('[data-session-input] textarea') ?? null);
            const range = root?.querySelector('#auto-read-rate');
            // A pseudo-element's size is not readable from getComputedStyle for a slider thumb, so read the rule that sizes it.
            let thumb: number | null = null;
            if (range) {
              for (const sheet of [...document.styleSheets]) {
                for (const rule of [...sheet.cssRules]) {
                  if (
                    rule instanceof CSSStyleRule &&
                    rule.selectorText.includes('.fy-ar-range::-webkit-slider-thumb')
                  ) {
                    thumb = Number.parseFloat(rule.style.width);
                  }
                }
              }
            }
            const clipped: string[] = [];
            root
              ?.querySelectorAll(
                '.fy-ar-voice-name, .fy-ar-voice-where, .fy-auto-read-hint, .fy-auto-read-title, [role="status"]',
              )
              .forEach(el => {
                const h = el as HTMLElement;
                if (h.classList.contains('sr-only')) return;
                if (h.scrollWidth > h.clientWidth + 1) clipped.push((h.textContent ?? '').slice(0, 60));
                const box = rect(h);
                if (box.right > window.innerWidth + 0.5 || box.left < -0.5)
                  clipped.push(`off-screen: ${(h.textContent ?? '').slice(0, 60)}`);
              });
            return { targets, thumb, clipped };
          });
          for (const t of measured.targets) {
            if (t.what.startsWith('composer')) continue;
            if (t.height < floor) fail(`${tag}: ${t.what} is ${t.height}px tall, needs ${floor}`);
          }
          if (measured.thumb !== null && measured.thumb < 28)
            fail(`${tag}: slider thumb is ${measured.thumb}px, needs 28`);
          if (measured.clipped.length > 0) fail(`${tag}: words clipped: ${measured.clipped.join(' | ')}`);
          process.stdout.write(
            `📏 ${tag}: ${measured.targets
              .filter(t => !t.what.startsWith('composer'))
              .map(t => `${t.what} ${t.height}`)
              .join(', ')}${measured.thumb === null ? '' : `, thumb ${measured.thumb}`}\n`,
          );

          // ---- SHOOT. Settings: cut only between the section's blocks; chat: the chat edge, tightly.
          const shoot = async (suffix: string, top: number, bottom: number) => {
            const target = join(outDir, scheme, `${scene}-${viewport.name}${suffix}.png`);
            await page.screenshot({
              path: target,
              fullPage: true,
              clip: { x: 0, y: Math.max(0, top), width: viewport.width, height: bottom - Math.max(0, top) },
            });
            process.stdout.write(`📸 ${target}\n`);
          };
          if (!SETTINGS.has(scene)) {
            const box = (await page.locator('[data-auto-read-scene]').boundingBox()) ?? fail(`${tag}: no scene box`);
            await shoot('', box.y, box.y + box.height + 8);
          } else {
            const blocks = await page.evaluate(() =>
              [...document.querySelectorAll('[data-auto-read-settings] > *')].map(el => {
                const r = el.getBoundingClientRect();
                return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY };
              }),
            );
            const MARGIN = 16; // round the first top and last bottom edge; a cut between blocks keeps half of the gap
            const limit = viewport.mobile ? viewport.height : Number.POSITIVE_INFINITY;
            const span = (from: number, to: number): number =>
              (blocks[to]?.bottom ?? 0) - (blocks[from]?.top ?? 0) + 2 * MARGIN;
            const parts: { from: number; to: number }[] = [];
            let first = 0;
            while (first < blocks.length) {
              let last = first;
              while (last + 1 < blocks.length && span(first, last + 1) <= limit) last += 1;
              if (span(first, last) > limit) fail(`${tag}: block ${first} alone is taller than the screen`);
              parts.push({ from: first, to: last });
              first = last + 1;
            }
            for (const [i, p] of parts.entries()) {
              await shoot(
                parts.length === 1 ? '' : `-part${i + 1}`,
                (blocks[p.from]?.top ?? 0) - (p.from === 0 ? MARGIN : MARGIN / 2),
                (blocks[p.to]?.bottom ?? 0) + (p.to === blocks.length - 1 ? 2 * MARGIN : MARGIN / 2),
              );
            }
          }
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
