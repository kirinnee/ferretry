/**
 * Screenshots of the stepped question form — a four-question ask (RWC socials / MX Weekly / Meet & Greet /
 * Sprint plan) at step 1, step 3 and Review, a question with very long option descriptions, and the phone
 * with its keyboard up — at a 390px phone and a 1440px desktop in the light and dark studio themes.
 * Review evidence; nothing compares the PNGs. What IS asserted, at 320, 390, 768 and 1440 wide and in a
 * short 1440x420 desktop panel, is that the form never overflows sideways, never outgrows the screen, and
 * keeps Back / Next / Submit inside the viewport at every step.
 *
 *   bun harness/question-stepper-screenshot.tsx [out-dir]   # writes question-stepper-*.png (default harness/out)
 *
 * It renders the REAL `QuestionForm` against a fake daemon, drives the system Chrome through playwright-core
 * and aborts every request off the loopback origin, like `question-form-screenshot.tsx`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

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
import { QuestionForm } from '../../src/components/question-form.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';

const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'http://127.0.0.1', deviceId: 'harness' });
const params = new URLSearchParams(location.search);
const FOUR = [
  {
    header: 'RWC socials',
    question: 'Which socials should the team plan around the Rugby World Cup final weekend, given the office is closed on the Monday?',
    options: [
      { label: 'Pub screening', description: 'Book the back room at the usual pub with a projector for the whole squad and partners, food included.' },
      { label: 'Watch party at the office', description: 'Bring the projector in, order pizza, and keep it to people already in town.' },
      { label: 'Skip it', description: 'No event; people make their own plans.' },
    ],
  },
  {
    header: 'MX Weekly',
    question: 'Keep the MX Weekly on Thursday at 10:00 or move it?',
    options: [{ label: 'Keep Thursday' }, { label: 'Move to Wednesday', description: 'Clashes with the platform sync.' }],
  },
  {
    header: 'Meet & Greet',
    question: 'Who should host the new-starter meet and greet next Tuesday?',
    options: [{ label: 'Team lead' }, { label: 'Buddy' }, { label: 'Both', description: 'Back to back, thirty minutes each.' }],
  },
  {
    header: 'Sprint plan',
    question: 'Which items go into the sprint?',
    multiSelect: true,
    options: [
      { label: 'Question stepper', description: 'One question at a time with a review page.' },
      { label: 'Relay carrier fallback' },
      { label: 'Warden remedies' },
    ],
  },
];
const LONG = [
  {
    header: 'Long descriptions',
    question: 'Pick the rollout. ' + 'This question is deliberately wordy so that it wraps over many lines on a narrow phone. '.repeat(4),
    options: Array.from({ length: 6 }, (_, index) => ({
      label: 'Option ' + (index + 1) + ' with a label long enough to wrap',
      description: 'Description ' + (index + 1) + ': ' + 'a long explanation that keeps going and going so the option grows taller than a line. '.repeat(3),
    })),
  },
  { header: 'Second', question: 'Anything else?', options: [{ label: 'No' }] },
];
const questions = params.get('form') === 'long' ? LONG : FOUR;
const api = { answer: async () => ({}) };
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
          question={{ toolUseId: 'toolu_stepper', questions }}
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
  <body><div id="root"></div><script type="module" src="/question-stepper-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'question-stepper-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'question-stepper-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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

/** The form fits the screen, scrolls inside itself, and keeps its footer buttons reachable. */
const assertFits = async (page: Page, where: string, viewportHeight: number): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
  const form = (await page.locator('.fy-question-form').boundingBox()) ?? fail(`${where}: no form`);
  if (form.y < -0.5 || form.y + form.height > viewportHeight + 0.5)
    fail(
      `${where}: the form (${Math.round(form.y)}..${Math.round(form.y + form.height)}) leaves the ${viewportHeight}px screen`,
    );
  const foot = await page.locator('.fy-question-foot button').evaluateAll(nodes =>
    nodes.map(node => {
      const box = node.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
    }),
  );
  for (const box of foot) {
    if (
      box.top < 0 ||
      box.bottom > viewportHeight + 0.5 ||
      box.left < 0 ||
      box.right > (await page.evaluate(() => window.innerWidth))
    )
      fail(`${where}: a footer button sits outside the screen (${JSON.stringify(box)})`);
  }
  const body = await page.locator('.fy-question-body').evaluate(node => node.scrollWidth - node.clientWidth);
  if (body > 0) fail(`${where}: the step content is ${body}px wider than its box`);
};

const open = async (page: Page, theme: string, form: string): Promise<void> => {
  await page.goto(`${server.url}?theme=studio-${theme}&form=${form}`);
  await page.locator('.fy-question-form').waitFor({ state: 'visible' });
};

const choose = async (page: Page, label: string): Promise<void> => {
  await page.locator('label.fy-question-option').filter({ hasText: label }).first().click();
};

const next = async (page: Page, label = 'Next'): Promise<void> => {
  await page.getByRole('button', { name: label, exact: true }).click();
};

const shot = async (page: Page, target: string, viewportHeight: number, width: number): Promise<void> => {
  const box = (await page.locator('.fy-question-form').boundingBox()) ?? fail('no form to capture');
  const top = Math.max(0, Math.floor(box.y) - 16);
  await page.screenshot({ path: target, clip: { x: 0, y: top, width, height: viewportHeight - top } });
  process.stdout.write(`📸 ${target}\n`);
};

const browser = await chromium.launch({ executablePath, headless: true });
try {
  // 1. The evidence set: phone 390 and desktop 1440, light and dark.
  for (const viewport of [
    { name: 'phone', width: 390, height: 844, touch: true },
    { name: 'desktop', width: 1_440, height: 900, touch: false },
  ] as const) {
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
        const name = (state: string) => join(outDir, `question-stepper-${state}-${viewport.name}-${scheme}.png`);
        const where = (state: string) => `${state} at ${viewport.name}/${scheme}`;

        await open(page, scheme, 'four');
        await assertFits(page, where('step 1'), viewport.height);
        await shot(page, name('step1'), viewport.height, viewport.width);

        await choose(page, 'Pub screening');
        await next(page);
        await choose(page, 'Keep Thursday');
        await next(page);
        await assertFits(page, where('step 3'), viewport.height);
        await shot(page, name('step3'), viewport.height, viewport.width);

        await choose(page, 'Buddy');
        await next(page);
        await choose(page, 'Question stepper');
        await choose(page, 'Warden remedies');
        await next(page, 'Review');
        await page.getByText('Review · 4 questions').waitFor({ state: 'visible' });
        await assertFits(page, where('review'), viewport.height);
        await shot(page, name('review'), viewport.height, viewport.width);

        await open(page, scheme, 'long');
        await assertFits(page, where('long descriptions'), viewport.height);
        await shot(page, name('long'), viewport.height, viewport.width);

        if (viewport.name === 'phone') {
          // The keyboard is up: the shell is the visible box (--app-h) and the Other field has focus.
          await open(page, scheme, 'four');
          await page.evaluate(() => {
            document.documentElement.dataset.keyboard = 'open';
            document.documentElement.style.setProperty('--app-h', '508px');
            document.documentElement.style.setProperty('--kb-h', '336px');
          });
          await choose(page, 'Other…');
          await page
            .getByPlaceholder('Type your response')
            .fill('Something else: a quiet dinner after the match, somewhere with a long name that wraps');
          await assertFits(page, where('keyboard open'), 508);
          await shot(page, name('keyboard'), 508, viewport.width);
        }
      } finally {
        await context.close();
      }
    }
  }

  // 2. The fit assertions at the other widths and in a short desktop panel, every step of both forms.
  for (const size of [
    { width: 320, height: 568 },
    { width: 768, height: 1_024 },
    { width: 1_440, height: 420 },
    { width: 390, height: 360 },
  ]) {
    const context = await browser.newContext({
      viewport: size,
      reducedMotion: 'reduce',
      hasTouch: size.width < 768,
      isMobile: size.width < 768,
    });
    try {
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
        return await route.continue();
      });
      const page = await context.newPage();
      for (const form of ['four', 'long'] as const) {
        await open(page, 'light', form);
        const steps = form === 'four' ? 4 : 2;
        for (let step = 1; step <= steps; step += 1) {
          await assertFits(page, `${form} step ${step} at ${size.width}x${size.height}`, size.height);
          await page.locator('.fy-question-option input').first().check();
          await next(page, step === steps ? 'Review' : 'Next');
        }
        await assertFits(page, `${form} review at ${size.width}x${size.height}`, size.height);
        const target = join(outDir, `question-stepper-fit-${form}-${size.width}x${size.height}.png`);
        if (form === 'four' && size.width === 1_440) await shot(page, target, size.height, size.width);
      }
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.stop();
}
