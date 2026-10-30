/**
 * Screenshots of agenda messages in the owner's bubble: an answer picked from a card, a written answer with a
 * note, a reply naming two items, a discussion, a batch of board answers, and an answer with its sent text
 * shown. Phone (390) and desktop (1440), the light and dark studio themes. Review evidence; nothing compares
 * the PNGs.
 *
 *   bun harness/agenda-message-screenshot.tsx [outDir]   # writes <outDir>/answer-bubble-<scene>-<scheme>-<viewport>.png
 *
 * It renders the REAL `TranscriptRow` inside the real `ReferenceSurfaceProvider` (so each `!A45` chip is a
 * proved reference) and `AgendaItemsProvider` (so each card names its item by the board's title). The
 * messages are worded by the protocol's own writer, exactly as the daemon words them.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? join(buildDir, 'agenda-message'));

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
import {
  agendaAnswerMessage,
  agendaBatchMessage,
  agendaDiscussMessage,
  agendaDoneMessage,
  agendaNeedsInfoMessage,
  agendaReMessage,
} from '@ferretry/protocol';
import { AgendaItemsProvider } from '../../src/components/agenda-message.tsx';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';

const A45 = { id: 'A45', quote: 'How should outdated ferrets pick up new instructions after an update?' };
const A46 = { id: 'A46', quote: 'Should the restart wait for a running turn to finish, or interrupt it?' };
const A47 = { id: 'A47', quote: 'Which machines get the new instructions first?' };

const snapshot = {
  items: [
    { id: 'A46', subject: A46.quote, title: 'Restart during a running turn' },
    { id: 'A47', subject: A47.quote, title: 'Rollout order for new instructions' },
  ],
  resolved: [
    {
      id: 'A45',
      subject: A45.quote,
      title: 'Picking up new instructions after an update',
      ask: { kind: 'multiple-choice', options: [{ label: 'Button only: you press Restart outdated' }, { label: 'Automatic' }] },
      response: { kind: 'multiple-choice', choice: 'Button only: you press Restart outdated' },
    },
  ],
};

const SCENES: Record<string, { readonly before: string; readonly message: string; readonly after: string }> = {
  answer: {
    before: 'I raised **!A45** so you can choose how outdated ferrets pick up new instructions.',
    message: agendaAnswerMessage(A45, 'Button only: you press Restart outdated'),
    after: 'Got it — outdated ferrets restart only when you press **Restart outdated**. Wiring the button now.',
  },
  written: {
    before: 'I need a call on **!A46** before I change the restart path.',
    message: agendaAnswerMessage(A46, 'Wait for the turn to finish, but never longer than ten minutes.', 'a stuck turn should not block the update'),
    after: 'Understood: wait, capped at ten minutes. I will add the cap to the restart path.',
  },
  reply: {
    before: 'Both **!A46** and **!A47** are open on your agenda.',
    message: agendaReMessage([A46, A47], 'Are these two related? If the rollout is staged, does the wait still matter?'),
    after: 'They are related: a staged rollout restarts fewer ferrets at once, so the wait matters less.',
  },
  discuss: {
    before: 'I raised **!A47** about the rollout order.',
    message: agendaDiscussMessage(A47, 'I am not sure what "first" means here — by machine, or by ferret?', 'fy'),
    after: 'By machine: each machine restarts its own ferrets together. I have updated the item to say so.',
  },
  batch: {
    before: 'Three items are waiting on you.',
    message: agendaBatchMessage([
      agendaAnswerMessage(A45, 'Button only: you press Restart outdated'),
      agendaNeedsInfoMessage(A46, 'What happens to a turn that is mid-tool-call?'),
      agendaDoneMessage(A47),
    ]),
    after: 'Thanks — A45 is wired, A47 is closed, and I have expanded A46 with what happens mid-tool-call.',
  },
  raw: {
    before: 'I raised **!A45** so you can choose how outdated ferrets pick up new instructions.',
    message: agendaAnswerMessage(A45, 'Button only: you press Restart outdated'),
    after: 'Got it.',
  },
};

const params = new URLSearchParams(location.search);
const scene = SCENES[params.get('scene') ?? 'answer'] ?? SCENES.answer!;
const at = Date.UTC(2026, 9, 30, 9, 7, 0);
const entries: TranscriptEntry[] = [
  { id: 'a1', kind: 'assistant', label: 'Ethan', text: scene.before, at },
  { id: 'u1', kind: 'user', text: scene.message, at: at + 60_000 },
  { id: 'a2', kind: 'assistant', label: 'Ethan', text: scene.after, at: at + 120_000 },
];
const surface = {
  agendaReferenceResolver: (id: string) => ['A45', 'A46', 'A47'].includes(id),
  onAgendaOpen: () => undefined,
};

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <ReferenceSurfaceProvider surface={surface}>
    <AgendaItemsProvider snapshot={snapshot as never}>
      <main style={{ margin: '0 auto', maxWidth: 760, padding: '12px 16px' }}>
        <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
          <div className="fy-transcript-content" data-agenda-shots="">
            {entries.map((entry, index) => (
              <TranscriptRow answered={index === 1} entry={entry} key={entry.id} previous={entries[index - 1]} />
            ))}
          </div>
        </div>
      </main>
    </AgendaItemsProvider>
  </ReferenceSurfaceProvider>,
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/agenda-message-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'agenda-message-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'agenda-message-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
] as const;
const SCENE_NAMES = ['answer', 'written', 'reply', 'discuss', 'batch', 'raw'] as const;

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      for (const scene of SCENE_NAMES) {
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
          await page.goto(`${server.url}?theme=studio-${scheme}&scene=${scene}`);
          await page.locator('[data-agenda-shots] .fy-agenda-msg').waitFor({ state: 'visible' });
          if (scene === 'raw') await page.locator('.fy-agenda-msg-raw-toggle').click();
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scheme} ${viewport.name} ${scene} scrolls sideways by ${overflow}px`);
          const target = join(outDir, `answer-bubble-${scene}-${scheme}-${viewport.name}.png`);
          await page.screenshot({ path: target, fullPage: true });
          process.stdout.write(`📸 ${target}\n`);
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
