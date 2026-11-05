/**
 * Screenshots of the Live voice bar (`components/live-voice-bar.tsx`) in EVERY state it can show: Starting,
 * Listening, Hearing you (with live words), Sending in 2 s and 1 s, Getting your words…, Sending…, Working,
 * Reading reply, On hold for each reason, Paused, a take that failed, and each refusal notice. Phone (390) and
 * desktop (1280), light and dark, in normal AND reduced motion (every state). The countdown is shot from the
 * start of a 3 s pause (ring at zero), then half way and nearly done. Review evidence; nothing compares PNGs.
 *
 * It also MEASURES: every button on the bar must be at least 48 px tall on the phone and 44 px on the desktop,
 * or the run fails.
 *
 *   bun harness/live-voice-bar-screenshot.tsx [outDir]   # default /tmp/claude-1000/shots/F137/s4
 *
 * It renders the REAL `LiveVoiceBar` from views built by the REAL machine and `liveView` — the bar is drawn from
 * the same data it ships with. Fake words only; no microphone opens and no request leaves the loopback origin.
 * A tall page is split into parts that each fit one viewport, so every bar is fully visible in its part.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const shotsDir = process.argv[2] ?? '/tmp/claude-1000/shots/F137/s4';

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { LiveVoiceBar } from '../../src/components/live-voice-bar.tsx';
import { INITIAL_LIVE_STATE, liveReduce } from '../../src/lib/voice-chat/live-machine.ts';
import { LIVE_BLOCK_COPY, liveView } from '../../src/lib/voice-chat/live-view.ts';

const run = (events, from = INITIAL_LIVE_STATE) => events.reduce((state, event) => liveReduce(state, event).state, from);
const WORDS = 'fix the login redirect and run the tests';
const START = { type: 'start', atMs: 0, canSend: true, visible: true };
const START3 = { ...START, graceMs: 3000 };
const LOCKED = { type: 'locks', granted: true };
const LISTENING = [START, LOCKED, { type: 'listening' }];
const LISTENING3 = [START3, LOCKED, { type: 'listening' }];
const HEARING = [...LISTENING, { type: 'speech-start' }, { type: 'live-words', text: WORDS }];
const SENDING = [...HEARING, { type: 'turn-end', atMs: 5000, speechEndedAtMs: 3500, reason: 'pause' }];
const HEARING3 = [...LISTENING3, { type: 'speech-start' }, { type: 'live-words', text: WORDS }];
const SENDING3 = [...HEARING3, { type: 'turn-end', atMs: 5000, speechEndedAtMs: 3500, reason: 'pause' }];
const READY3 = [...SENDING3, { type: 'turn-words', attempt: 1, atMs: 5300, text: 'Fix the login redirect and run the tests.' }];
const READY = [...SENDING, { type: 'turn-words', attempt: 1, atMs: 5300, text: 'Fix the login redirect and run the tests.' }];
const SENT = [...READY, { type: 'countdown-done', atMs: 6500 }, { type: 'sent', atMs: 6600 }];
const refused = block => [START, LOCKED, { type: 'blocked', block }];
const reading = { ...run(SENT), canRead: true };

const at = (events, nowMs, from) => liveView(run(events, from), nowMs);
const STATES = [
  ['starting', 'Starting', at([START], 0)],
  ['listening', 'Listening', at(LISTENING, 0)],
  ['hearing', 'Hearing you (live words)', at(HEARING, 0)],
  ['sending-start', 'Sending in 3 s (a 3 s pause, just started: the ring is at zero)', at(READY3, 5000)],
  ['sending-2s', 'Sending in 2 s (half way)', at(READY3, 6500)],
  ['sending-1s', 'Sending in 1 s (nearly done)', at(READY3, 7500)],
  ['getting-words', 'Getting your words…', at(SENDING, 6600)],
  ['getting-words-held', 'Hold pressed while the words are still coming', at([...SENDING, { type: 'hold' }], 6600)],
  ['sending', 'Sending…', at([...READY, { type: 'countdown-done', atMs: 6500 }], 6500)],
  ['working', 'Working 0:12', at(SENT, 18700)],
  ['reading', 'Reading reply', liveView(run([{ type: 'reply', signal: 'done' }], reading), 0)],
  ['hold-user', 'On hold (user)', at([...READY, { type: 'hold' }], 0)],
  ['hold-typing', 'On hold (typing)', at([...READY, { type: 'typing' }], 0)],
  ['hold-send-failed', "On hold (couldn't send — also what a lost connection looks like: there is no separate offline state)", at([...READY, { type: 'countdown-done', atMs: 6500 }, { type: 'send-failed' }], 0)],
  ['hold-needs-input', 'On hold (ferret needs you)', at([...SENT, { type: 'reply', signal: 'needs-input' }], 0)],
  ['paused', 'Paused', at([...LISTENING, { type: 'visibility', visible: true }, { type: 'visibility', visible: false }, { type: 'visibility', visible: true }], 0)],
  ['take-failed', 'Take failed (notice under Listening)', at([...SENDING, { type: 'turn-failed', attempt: 1, block: 'engine-failed' }], 0)],
  ['take-failed-held', 'Take failed after Hold (stays on hold)', at([...SENDING, { type: 'hold' }, { type: 'turn-failed', attempt: 1, block: 'engine-failed' }], 0)],
  ['refused-mic-blocked', 'Refused: mic blocked', at(refused('mic-blocked'), 0)],
  ['refused-engine-not-chosen', 'Refused: engine not chosen', at(refused('engine-not-chosen'), 0)],
  ['refused-engine-missing', 'Refused: engine missing', at(refused('engine-missing'), 0)],
  ['refused-ios-browser-voice', 'Refused: iOS browser voice', at(refused('ios-browser-voice'), 0)],
  ['refused-other-tab', 'Refused: other tab', at([START, { type: 'locks', granted: false }], 0)],
];
for (const [id, , view] of STATES) {
  if (!view.visible) throw new Error(id + ' is not visible');
}
void LIVE_BLOCK_COPY;

const params = new URLSearchParams(location.search);
const layout = params.get('layout') === 'desktop' ? 'desktop' : 'phone';
const reduced = params.get('reduced') === '1';
const ids = (params.get('ids') ?? '').split(',').filter(Boolean);
const LEVELS = Array.from({ length: 32 }, (_, i) => Math.min(1, 0.12 + 0.85 * Math.abs(Math.sin(i * 0.55)) * (0.45 + (i % 5) / 8)));

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div style={{ margin: '0 auto', maxWidth: layout === 'phone' ? 390 : 1280, padding: 12, display: 'flex', flexDirection: 'column', gap: 18 }}>
    {STATES.filter(([id]) => ids.length === 0 || ids.includes(id)).map(([id, label, view]) => (
      <figure key={id} data-state={id} style={{ margin: 0 }}>
        <figcaption style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{label}</figcaption>
        <LiveVoiceBar
          view={view}
          layout={layout}
          levels={LEVELS}
          reducedMotion={reduced}
          onHold={() => undefined}
          onSendNow={() => undefined}
          onResume={() => undefined}
          onEnd={() => undefined}
          onSkip={() => undefined}
        />
        {layout === 'desktop' && view.phase !== 'off' ? (
          <div style={{ marginTop: 6, border: '1px solid var(--border-strong)', borderRadius: 10, padding: '10px 12px', color: 'var(--muted)', fontSize: 14, background: 'var(--surface)' }}>
            Message dev…
          </div>
        ) : null}
      </figure>
    ))}
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/live-bar-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
await Bun.write(join(buildDir, 'live-bar-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'live-bar-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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

const ALL = [
  'starting',
  'listening',
  'hearing',
  'sending-start',
  'sending-2s',
  'sending-1s',
  'getting-words',
  'getting-words-held',
  'sending',
  'working',
  'reading',
  'hold-user',
  'hold-typing',
  'hold-send-failed',
  'hold-needs-input',
  'paused',
  'take-failed',
  'take-failed-held',
  'refused-mic-blocked',
  'refused-engine-not-chosen',
  'refused-engine-missing',
  'refused-ios-browser-voice',
  'refused-other-tab',
] as const;

const chunk = <T,>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

/** What to shoot: each part is one viewport of states, the same parts in normal and in reduced motion. */
const PHONE_PARTS = [...chunk(ALL.slice(0, 19), 2), ...chunk(ALL.slice(19), 5)];
const DESKTOP_PARTS = [...chunk(ALL.slice(0, 19), 5), ALL.slice(19)];
const PLANS = [
  { name: 'phone', width: 390, height: 844, mobile: true, reduced: false, parts: PHONE_PARTS },
  { name: 'desktop', width: 1280, height: 900, mobile: false, reduced: false, parts: DESKTOP_PARTS },
  { name: 'phone-reduced', width: 390, height: 844, mobile: true, reduced: true, parts: PHONE_PARTS },
  { name: 'desktop-reduced', width: 1280, height: 900, mobile: false, reduced: true, parts: DESKTOP_PARTS },
] as const;

let count = 0;
try {
  for (const plan of PLANS) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: plan.width, height: plan.height },
        deviceScaleFactor: 2,
        isMobile: plan.mobile,
        hasTouch: plan.mobile,
        colorScheme: scheme,
        reducedMotion: plan.reduced ? 'reduce' : 'no-preference',
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        for (const [index, part] of plan.parts.entries()) {
          const layout = plan.name.startsWith('phone') ? 'phone' : 'desktop';
          await page.goto(
            `${server.url}?theme=studio-${scheme}&layout=${layout}&reduced=${plan.reduced ? 1 : 0}&ids=${part.join(',')}`,
          );
          await page.locator('figure').first().waitFor({ state: 'visible' });
          const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (sideways > 0) fail(`${plan.name} ${scheme} part ${index + 1} scrolls sideways by ${sideways}px`);
          const cut = await page.evaluate(
            () =>
              [...document.querySelectorAll('figure')].filter(
                f => f.getBoundingClientRect().bottom > window.innerHeight,
              ).length,
          );
          if (cut > 0) fail(`${plan.name} ${scheme} part ${index + 1}: ${cut} bar(s) run past the viewport`);
          // Every button on the bar: 48 px on a phone, 44 px on a computer. The big round button is 96 px.
          const minimum = layout === 'phone' ? 48 : 44;
          const small = await page.evaluate(
            (min: number) =>
              [...document.querySelectorAll('.fy-live button')]
                .map(button => ({ text: button.textContent ?? '', height: button.getBoundingClientRect().height }))
                .filter(button => button.height < min),
            minimum,
          );
          if (small.length > 0)
            fail(`${plan.name} ${scheme} part ${index + 1}: buttons under ${minimum}px: ${JSON.stringify(small)}`);
          const target = join(
            shotsDir,
            `live-bar-${plan.name}-${scheme}-part${String(index + 1).padStart(2, '0')}.png`,
          );
          await page.screenshot({ path: target });
          count += 1;
          process.stdout.write(`📸 ${target}\n`);
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
process.stdout.write(`${count} screenshots in ${shotsDir}\n`);
