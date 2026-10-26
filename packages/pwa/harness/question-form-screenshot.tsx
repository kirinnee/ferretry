/**
 * Screenshots of the structured question form after a refused answer — at a 390px phone and a 1440px
 * desktop, in the light and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/question-form-screenshot.tsx [out-dir]   # writes question-form-*.png (default harness/out)
 *
 * It renders the REAL `QuestionForm`, picks "Other…", types a reply and presses Submit against a fake
 * daemon that refuses the answer. Two states: `answered` (the daemon already delivered an answer — the
 * form turns read-only and says what it was answered with), `error` (any other refusal — one plain
 * sentence, with the technical explanation behind Details) and `undelivered` (the daemon could not drive
 * the native form — the owner's real report, as an older daemon words it: the raw driver text moves
 * behind Details and an Open Console button offers the pane itself). Every width is asserted to fit without
 * sideways scroll. `paused` is a two-question form whose drive stopped before submitting:
 * the sentence says where, the first question is marked as answered in the terminal, and Resume sits
 * beside Open Console. Like `approval-card-screenshot.tsx` it drives the system Chrome through
 * playwright-core and aborts every request off the loopback origin.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? buildDir);

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
import { FyHttpError } from '@ferretry/protocol/client';
import { QuestionForm } from '../../src/components/question-form.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'http://127.0.0.1', deviceId: 'harness' });
const state = new URLSearchParams(location.search).get('state');
const UNDELIVERED = 'the rendered form is not the exact pending question; no keys were sent\\n\\nAutomatic native cancellation was not confirmed: the failed answer no longer has a positively bound question menu; refusing automatic Escape. The structured form remains bound; inspect the terminal before continuing.\\nPending question:\\nHow should this land?';
const PAUSED = 'Stopped at question 2 of 2 (1 of 2 answered). Nothing was sent yet and the form is still open: resume to answer the rest, or finish it in the Console tab.';
const QUESTIONS = state === 'paused'
  ? [
      { header: 'Colour', question: 'Which colour should the banner use?', options: [{ label: 'Red' }, { label: 'Blue' }] },
      { header: 'Extras', question: 'Which extras should ship with it?', options: [{ label: 'Shadow' }, { label: 'Border' }] },
    ]
  : [{ question: 'How should this land?', options: [{ label: 'Ship it' }, { label: 'Hold' }] }];
const api = {
  answer: async () => {
    if (state === 'answered')
      throw new FyHttpError('This question was already answered with «Ship it».', 409, 'question_already_answered', {
        error: 'x',
        answeredWith: 'Ship it',
      });
    if (state === 'undelivered')
      throw new FyHttpError(UNDELIVERED, 409, 'answer_unconfirmed', { error: UNDELIVERED });
    if (state === 'paused')
      throw new FyHttpError(PAUSED, 409, 'answer_paused', {
        error: PAUSED,
        detail: 'stopped at question 2 of 2 (Extras): the answer keys were sent, but its tab was not ticked and the form did not move on',
        stoppedAt: 1,
        answered: [true, false],
      });
    throw new FyHttpError('A different answer was already sent for this question. Reload the session and check it before answering again.', 409, 'answer_request_id_reused', {
      error: 'x',
      detail: 'request id "question:fy_daemon_x:session:toolu_01" was already used for a different answer',
    });
  },
};
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell kt-chat-surface flex h-full flex-col justify-end bg-bg px-1">
    <div className="fy-chat-input" data-session-input="">
      <div className="fy-chat-input__column">
        <QuestionForm
          api={api}
          daemon={daemon}
          onOpenConsole={() => {}}
          question={{
            toolUseId: 'toolu_01',
            questions: QUESTIONS,
          }}
          sessionId="harness-session"
        />
      </div>
    </div>
  </div>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/question-form-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'question-form-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'question-form-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'desktop', width: 1_440, height: 900, touch: false },
] as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        hasTouch: viewport.touch,
        isMobile: viewport.touch,
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        for (const state of ['answered', 'error', 'undelivered', 'paused'] as const) {
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${state}`);
          const form = page.locator('.fy-question-form');
          await form.waitFor({ state: 'visible' });
          if (state === 'paused') {
            await page.getByText('Blue', { exact: true }).click();
            await page.getByText('Shadow', { exact: true }).click();
          } else {
            await page.getByText('Other…').click();
            await page.getByPlaceholder('Type your response').fill('Ship it, but behind a flag');
          }
          await page.locator('.fy-question-submit').click();
          if (state === 'answered') await page.locator('[data-question-answered]').waitFor({ state: 'visible' });
          else {
            await page.locator('[role="alert"]').waitFor({ state: 'visible' });
            await page.locator('summary').click();
          }
          const where = `${state} at ${viewport.name}/${scheme}`;
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          const box = (await form.boundingBox()) ?? fail(`${where}: no form`);
          const top = Math.max(0, Math.floor(box.y) - 16);
          const target = join(outDir, `question-form-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({
            path: target,
            clip: { x: 0, y: top, width: viewport.width, height: viewport.height - top },
          });
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
