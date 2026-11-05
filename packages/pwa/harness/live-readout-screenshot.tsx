/**
 * Screenshots of LIVE READING THE REPLY (F137 slice 5): the Live bar below a real conversation while the reply
 * is read (the sentence being said highlighted in the chat), the Stop / Repeat / End controls, the ferret's
 * question being read and then waiting on its normal prompt, the iPhone "Listen" fallback, the "couldn't speak
 * this reply" notice, and Settings › Live sounds on and off. Phone (390) and desktop (1280), light and dark,
 * normal and reduced motion. Review evidence; nothing compares PNGs, but the script FAILS if any Live button is
 * under 48 px (phone) / 44 px (desktop), the Live sounds switch is under 44 px, a page scrolls sideways or past
 * one screen, or the live region carries the reply.
 *
 *   bun harness/live-readout-screenshot.tsx [outDir]   # default /tmp/claude-1000/shots/F137/s5
 *
 * It renders the REAL `TranscriptRow`, `LiveVoiceBar`, `QuestionForm` and `AutoReadSettings`; the bar's view is
 * built by the REAL machine and `liveView`. The voice is a FAKE speaker that makes no sound; the scene decides
 * which sentence is "being said". Everything on screen is invented text. No microphone opens and no request
 * leaves the loopback origin.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const shotsDir = process.argv[2] ?? '/tmp/claude-1000/shots/F137/s5';

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
import { LiveVoiceBar } from '../../src/components/live-voice-bar.tsx';
import { QuestionForm } from '../../src/components/question-form.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { AutoReadSettings } from '../../src/features/settings/auto-read-settings.tsx';
import { LiveVoiceSettingsProvider } from '../../src/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../src/hooks/use-read-aloud.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { INITIAL_LIVE_STATE, liveReduce } from '../../src/lib/voice-chat/live-machine.ts';
import { LiveVoiceSettingsStore } from '../../src/lib/voice-chat/live-settings.ts';
import { liveView } from '../../src/lib/voice-chat/live-view.ts';
import { createReadAloud } from '../../src/lib/voice-chat/read-aloud.ts';

const run = (events, from = INITIAL_LIVE_STATE) => events.reduce((state, event) => liveReduce(state, event).state, from);
const START = { type: 'start', atMs: 0, canSend: true, visible: true, canRead: true };
const PHONE_START = { ...START, tapToListen: true };
const LOCKED = { type: 'locks', granted: true };
const heard = (start) => [start, LOCKED, { type: 'listening' }, { type: 'speech-start' }, { type: 'live-words', text: 'fix the login redirect' },
  { type: 'turn-end', atMs: 5000, speechEndedAtMs: 3500, reason: 'pause' },
  { type: 'turn-words', attempt: 1, atMs: 5300, text: 'Fix the login redirect and run the tests.' },
  { type: 'countdown-done', atMs: 6500 }, { type: 'sent', atMs: 6600 }];
const WORKING = run(heard(START));
const WORKING_PHONE = run(heard(PHONE_START));
const READING = run([{ type: 'reply', signal: 'done' }], WORKING);
const ASKING = run([{ type: 'reply', signal: 'needs-input' }], WORKING);
const HELD_ON_QUESTION = run([{ type: 'speak-done', id: 1, end: 'finished' }], ASKING);
const LISTEN = run([{ type: 'speak-done', id: 1, end: 'finished' }], run([{ type: 'reply', signal: 'done' }], WORKING_PHONE));
const READ_FAILED = run([{ type: 'speak-done', id: 1, end: 'failed' }, LOCKED, { type: 'listening' }], READING);
const NO_VOICE = run([{ type: 'speak-done', id: 1, end: 'unavailable' }, LOCKED, { type: 'listening' }], READING);

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'reading';
const layout = params.get('layout') === 'desktop' ? 'desktop' : 'phone';
const reduced = params.get('reduced') === '1';

const REPLY = [
  'I found the bug. The login form read the token before the page had finished loading, so the first tap did nothing.',
  '',
  'I made it wait for the page and queue the first tap, see \`login-form.tsx\`.',
  '',
  '\`\`\`ts',
  'await ready();',
  'submit(form);',
  '\`\`\`',
  '',
  'All 48 tests pass. The redirect now keeps the query string.',
].join('\\n');
const QUESTION_REPLY = 'The fix is ready. Before I push it I need one decision.';

const AT = Date.UTC(2026, 10, 5, 3, 0, 0);
const asking = scene.startsWith('question');
const entries = [
  { id: 'u1', kind: 'user', text: 'Fix the login redirect and run the tests.', at: AT - 120000 },
  { id: 'a1', kind: 'assistant', text: asking ? QUESTION_REPLY : REPLY, label: 'Janella', at: AT },
];

const CURRENT_SENTENCE = { reading: 2, 'reading-start': 0 };
const quiet = (current) => {
  let hear = null;
  return {
    supported: true,
    voices: () => [{ id: 'local', name: 'Samantha', lang: 'en-US', local: true, isDefault: true }],
    unlock: () => undefined,
    speak: (_request, onEvent) => { hear = onEvent; onEvent({ type: 'segment', index: current }); },
    stop: () => hear?.({ type: 'stopped' }),
  };
};
const controller = createReadAloud({ speaker: quiet(CURRENT_SENTENCE[scene] ?? 0), language: () => 'en-US' });

const memory = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }; };
const store = new LiveVoiceSettingsStore(memory());
if (scene === 'settings-off') store.update({ earcons: false });

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'http://127.0.0.1', deviceId: 'harness' });
const LEVELS = Array.from({ length: 32 }, (_, i) => Math.min(1, 0.12 + 0.85 * Math.abs(Math.sin(i * 0.55)) * (0.45 + (i % 5) / 8)));

const VIEWS = {
  reading: liveView(READING, 0),
  'reading-start': liveView(READING, 0),
  'question-reading': liveView(ASKING, 0),
  'question-prompt': liveView(HELD_ON_QUESTION, 0),
  listen: liveView(LISTEN, 0),
  'read-failed': liveView(READ_FAILED, 0),
  'no-voice': liveView(NO_VOICE, 0),
};
const view = VIEWS[scene];

function Driver() {
  useEffect(() => {
    if (scene === 'reading' || scene === 'reading-start') controller.read('a1', REPLY);
    else if (scene === 'question-reading') controller.read('auto-read:question', 'The ferret asks. Push the fix to main?');
    document.body.dataset.ready = '1';
  }, []);
  return null;
}

const bar = view === undefined ? null : (
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
    onRepeat={() => undefined}
  />
);
const questionApi = { answer: async () => ({}) };
const prompt = asking && scene !== 'question-reading' ? (
  <QuestionForm
    api={questionApi}
    daemon={daemon}
    onOpenConsole={() => undefined}
    question={{ toolUseId: 'toolu_01', questions: [{ question: 'Push the fix to main?', options: [{ label: 'Push it' }, { label: 'Open a pull request' }, { label: 'Hold' }] }] }}
    sessionId="harness-session"
  />
) : null;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <LiveVoiceSettingsProvider store={store}>
    <ReadAloudProvider controller={controller}>
      <Driver />
      <main style={{ margin: '0 auto', maxWidth: layout === 'phone' ? 390 : 880, padding: '10px 12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {scene.startsWith('settings') ? (
          <AutoReadSettings />
        ) : (
          <>
            <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
              <div className="fy-transcript-content" data-live-readout-scene="">
                {entries.map((entry, index) => (
                  <TranscriptRow answered entry={entry} key={entry.id} previous={entries[index - 1]} />
                ))}
              </div>
            </div>
            {prompt}
            {bar}
            {layout === 'desktop' ? (
              <div style={{ border: '1px solid var(--border-strong)', borderRadius: 10, padding: '10px 12px', color: 'var(--muted)', fontSize: 14, background: 'var(--surface)' }}>
                Message dev…
              </div>
            ) : null}
          </>
        )}
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
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/live-readout-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
await Bun.write(join(buildDir, 'live-readout-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'live-readout-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const SCENES = [
  'reading',
  'question-reading',
  'question-prompt',
  'listen',
  'read-failed',
  'no-voice',
  'settings-on',
  'settings-off',
] as const;
const PLANS = [
  { name: 'phone', width: 390, height: 844, mobile: true, reduced: false },
  { name: 'desktop', width: 1280, height: 900, mobile: false, reduced: false },
  { name: 'phone-reduced', width: 390, height: 844, mobile: true, reduced: true },
  { name: 'desktop-reduced', width: 1280, height: 900, mobile: false, reduced: true },
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
        const layout = plan.name.startsWith('phone') ? 'phone' : 'desktop';
        for (const scene of SCENES) {
          // Settings is not about the Live bar's layout or reduced motion twice: shoot it in the plain runs.
          if (scene.startsWith('settings') && plan.reduced) continue;
          await page.goto(
            `${server.url}?theme=studio-${scheme}&layout=${layout}&reduced=${plan.reduced ? 1 : 0}&scene=${scene}`,
          );
          await page.waitForSelector('body[data-ready="1"]');
          await page.locator('main').waitFor({ state: 'visible' });
          const label = `${plan.name} ${scheme} ${scene}`;
          const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (sideways > 0) fail(`${label} scrolls sideways by ${sideways}px`);
          const settingsScene = scene.startsWith('settings');
          // The page is as tall as it is. It is cut into viewport-high parts below, so every part is read at full size.
          // The settings page is long: only the part holding the Live sounds switch is kept.
          const total = await page.evaluate(() => document.documentElement.scrollHeight);
          const soundsTop = settingsScene
            ? await page.evaluate(() => {
                const sounds = document.querySelector('[data-live-sounds]');
                return sounds === null
                  ? 0
                  : Math.max(0, Math.round(sounds.getBoundingClientRect().top + window.scrollY - 24));
              })
            : 0;
          const minimum = layout === 'phone' ? 48 : 44;
          const small = await page.evaluate(
            (min: number) =>
              [...document.querySelectorAll('.fy-live button, [data-live-sounds]')]
                .map(button => ({
                  text: (button.textContent ?? '').trim(),
                  height: Math.round(button.getBoundingClientRect().height),
                }))
                .filter(button => button.height < min),
            settingsScene ? 44 : minimum,
          );
          if (small.length > 0) fail(`${label}: buttons under the minimum: ${JSON.stringify(small)}`);
          // The live region says the state in words and never a word of the reply.
          const said = await page.evaluate(() => document.querySelector('[data-live-region]')?.textContent ?? '');
          if (/login form|token|tests pass/iu.test(said)) fail(`${label}: the live region carries the reply: ${said}`);
          if (scene === 'reading') {
            const captions = await page.locator('[data-current]').count();
            if (captions === 0) fail(`${label}: no highlighted sentence in the chat`);
          }
          // Settings: the clip is the Live sounds switch and its explanation (their shared box) with a margin: never a half line.
          if (settingsScene) {
            const box = await page.evaluate(() => {
              const rect = document.querySelector('[data-live-sounds]')?.parentElement?.getBoundingClientRect();
              return rect === undefined
                ? null
                : { y: Math.max(0, Math.round(rect.top + window.scrollY - 16)), height: Math.round(rect.height + 32) };
            });
            if (box === null) fail(`${label}: no Live sounds switch`);
            const target = join(shotsDir, `readout-${plan.name}-${scheme}-${scene}.png`);
            await page.screenshot({
              path: target,
              fullPage: true,
              clip: {
                x: 0,
                y: box?.y ?? 0,
                width: plan.width,
                height: Math.min(box?.height ?? 1, total - (box?.y ?? 0)),
              },
            });
            count += 1;
            process.stdout.write(`📸 ${target}\n`);
            continue;
          }
          const height = plan.height;
          const from = settingsScene ? soundsTop : 0;
          const until = settingsScene ? Math.min(total, soundsTop + height) : total;
          const parts = Math.max(1, Math.ceil((until - from) / height));
          // Every Live button must lie wholly inside the part that shows it, not straddle a cut.
          const rects = await page.evaluate(() =>
            [...document.querySelectorAll('.fy-live, [data-live-sounds]')].map(el => {
              const r = el.getBoundingClientRect();
              return { top: Math.round(r.top + window.scrollY), bottom: Math.round(r.bottom + window.scrollY) };
            }),
          );
          // The last part is aligned to the bottom of the page (parts may overlap), so the bar below the conversation is whole.
          const starts = Array.from({ length: parts }, (_, k) =>
            Math.max(0, Math.min(from + k * height, until - height)),
          );
          for (const rect of rects) {
            const whole = starts.some(y => rect.top >= y && rect.bottom <= y + height);
            if (!whole && rect.top >= from && rect.top < until)
              fail(`${label}: the Live bar (${rect.top}-${rect.bottom}) is not wholly inside any part`);
          }
          for (let part = 0; part < parts; part += 1) {
            const y = starts[part] ?? 0;
            const target = join(
              shotsDir,
              `readout-${plan.name}-${scheme}-${scene}${parts > 1 ? `-part${part + 1}` : ''}.png`,
            );
            await page.screenshot({
              path: target,
              fullPage: true,
              clip: { x: 0, y, width: plan.width, height: Math.min(height, total - y) },
            });
            count += 1;
            process.stdout.write(`📸 ${target}\n`);
          }
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
