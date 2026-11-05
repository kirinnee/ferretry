/**
 * Screenshots of referencing an attachment from the conversation (&F958): the + on a stored attachment's tile,
 * the composer after tapping it (the token at the caret and the file back as a chip, no re-upload), a message
 * whose `%attachment:name` has become a file chip, that chip's click ringing the tile it points back at, and the
 * + disabled while no message box is open. Phone (390) and desktop (1440), light and dark.
 * Review evidence; nothing compares the PNGs.
 *
 *   bun harness/attachment-reference-screenshot.tsx [outDir]   # writes <outDir>/attachment-reference-<step>-<viewport>-<scheme>.png
 *
 * Everything drawn is the REAL thing: `TranscriptRow` over entries projected from a log by
 * `transcriptEntriesFromLog`, inside the real `HandoffSourceProvider`, `AttachmentReferences` and the real
 * `Composer`. Only the data is invented (fake names, a drawn PNG) and nothing is sent.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? join(buildDir, 'attachment-reference'));

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
import { turnFileInstruction } from '@ferretry/protocol';
import { AttachmentGalleryProvider } from '../../src/components/attachment-gallery.tsx';
import { AttachmentReferences } from '../../src/components/attachment-reference-surface.tsx';
import { AttachmentReferenceTarget } from '../../src/components/attachment-reference-target.tsx';
import { Composer } from '../../src/components/composer.tsx';
import { HandoffSourceProvider } from '../../src/components/handoff-message.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { withAgentName } from '../../src/components/transcript.tsx';
import { transcriptEntriesFromLog } from '../../src/components/session-workspace-model.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonDraftStore } from '../../src/lib/drafts.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';

const STATE = '/home/studio/.ferretry/state/sessions/ms-demo/turns';
const LOG = [
  '[01:44:02] user/message: ' + turnFileInstruction(STATE + '/turn-006.md'),
  '[01:44:30] assistant/message: Thanks. I can see the Continue button is hidden at 390px.',
  '[01:45:10] user/message: ' + turnFileInstruction(STATE + '/turn-009.md'),
  '[01:45:44] assistant/message: The **Continue** button in %attachment:onboarding.png sits under the keyboard, so I am adding an inset now.',
].join('\\n');

const HANDOFFS = {
  'turn-006': {
    name: 'turn-006',
    message: 'The Continue button is hidden on my phone. Here is the screen and the spec.',
    attachments: [
      { attachmentId: 'att_1', filename: 'onboarding.png', mime: 'image/png' },
      { attachmentId: 'att_2', filename: 'Onboarding-spec.pdf', mime: 'application/pdf' },
    ],
  },
  'turn-009': {
    name: 'turn-009',
    message: 'Does %attachment:onboarding.png match what %attachment:Onboarding-spec.pdf asks for? Ignore %attachment:missing.png.',
    attachments: [],
  },
} as const;

const SCREEN = '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">' +
  '<rect width="390" height="844" fill="#0f172a"/><rect x="24" y="96" width="342" height="56" rx="12" fill="#1e293b"/>' +
  '<rect x="24" y="180" width="342" height="48" rx="10" fill="#334155"/><text x="40" y="210" fill="#e2e8f0" font-family="sans-serif" font-size="18">Name</text>' +
  '<rect x="0" y="520" width="390" height="324" fill="#cbd5e1"/><text x="140" y="690" fill="#0f172a" font-family="sans-serif" font-size="22">keyboard</text>' +
  '<rect x="24" y="560" width="342" height="52" rx="12" fill="#6366f1" opacity="0.35"/></svg>';

const params = new URLSearchParams(location.search);
const withComposer = params.get('composer') !== '0';
const daemon = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'harness' });
const scope = daemonSessionScope(daemon, 'ms-demo');
const source = {
  daemon,
  sessionId: 'ms-demo',
  read: async (name: string) => {
    const found = (HANDOFFS as Record<string, unknown>)[name];
    if (found === undefined) throw new Error('no hand-off document ' + name);
    return found as never;
  },
};
const load = async (): Promise<Blob> => {
  const image = new Image();
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SCREEN);
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 390;
  canvas.height = 844;
  canvas.getContext('2d')?.drawImage(image, 0, 0);
  return await new Promise<Blob>((done, refuse) =>
    canvas.toBlob(blob => (blob === null ? refuse(new Error('no PNG')) : done(blob)), 'image/png'),
  );
};

const now = Date.UTC(2026, 9, 18, 2, 0, 0);
const entries: TranscriptEntry[] = transcriptEntriesFromLog(LOG, now).map(entry => withAgentName(entry, 'Janella'));
const memory = new Map<string, string>();
const draftStore = new DaemonDraftStore({
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => {
    memory.set(key, value);
  },
});

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <AttachmentGalleryProvider load={load}>
    <HandoffSourceProvider source={source}>
      <AttachmentReferences daemonId={daemon.daemonId} sessionId="ms-demo">
        <AttachmentReferenceTarget scope={scope}>
          <main style={{ margin: '0 auto', maxWidth: 760, padding: '12px 16px', display: 'grid', gap: 12 }}>
            <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
              <div className="fy-transcript-content" data-transcript="">
                {entries.map((entry, index) => (
                  <TranscriptRow answered entry={entry} key={entry.id} previous={entries[index - 1]} />
                ))}
              </div>
            </div>
            {withComposer ? (
              <div data-harness-composer="">
                <Composer api={{ send: async () => ({}) as never }} daemon={daemon} draftStore={draftStore} sessionId="ms-demo" />
              </div>
            ) : null}
          </main>
        </AttachmentReferenceTarget>
      </AttachmentReferences>
    </HandoffSourceProvider>
  </AttachmentGalleryProvider>,
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/attachment-reference-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'attachment-reference-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'attachment-reference-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
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

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
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
        const shot = async (page: import('playwright-core').Page, step: string): Promise<void> => {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${scheme} ${viewport.name} ${step} scrolls sideways by ${overflow}px`);
          const target = join(outDir, `attachment-reference-${step}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: true });
          process.stdout.write(`📸 ${target}\n`);
        };
        const open = async (composer: boolean) => {
          const page = await context.newPage();
          await page.goto(`${server.url}?theme=studio-${scheme}&composer=${composer ? '1' : '0'}`);
          await page.locator('[data-handoff-state="read"] img').first().waitFor({ state: 'visible' });
          await page.locator('a[data-fy-attachment-ref]').first().waitFor({ state: 'visible' });
          return page;
        };

        const page = await open(true);
        const tile = page.locator('[data-attachment-id="att_1"]');
        // 01 — the + on a stored attachment's tile. A pointer reveals it on hover; a finger always sees it.
        if (!viewport.mobile) await tile.hover();
        await shot(page, '01-tile-plus');
        // 02 — tapped: the token is at the caret and the file is back in the composer as a chip.
        await page.locator('[data-attachment-id="att_1"] button[data-attachment-add]').click({ force: true });
        const editor = page.locator('[data-harness-composer] [role="textbox"]');
        await editor.waitFor({ state: 'visible' });
        await page.waitForFunction(() =>
          document
            .querySelector('[data-harness-composer] [role="textbox"]')
            ?.textContent?.includes('%attachment:onboarding.png'),
        );
        const draft = (await editor.textContent()) ?? '';
        if (draft.trim() !== '%attachment:onboarding.png') fail('the token was not written: ' + JSON.stringify(draft));
        await page.locator('[data-harness-composer] [title="onboarding.png"]').waitFor({ state: 'visible' });
        await shot(page, '02-composer-after-plus');
        // Tapping the same file's + again keeps ONE chip and writes a second token.
        await page.locator('[data-attachment-id="att_1"] button[data-attachment-add]').click({ force: true });
        const chips = await page.locator('[data-harness-composer] [title="onboarding.png"]').count();
        if (chips !== 1) fail('expected one chip, saw ' + chips);
        // 03 — a proved %attachment:name in the owner's and the ferret's message is a file chip; an unproved one stays text.
        await page.locator('a[data-fy-attachment-ref]').first().scrollIntoViewIfNeeded();
        await shot(page, '03-reference-chip');
        // 04 — its click scrolls to the tile and rings it.
        await page.locator('a[data-fy-attachment-ref]').last().click();
        await page.locator('[data-attachment-flash]').waitFor({ state: 'visible' });
        await shot(page, '04-chip-scrolled-and-ringed');
        await page.close();

        // 05 — no message box is open: the + is disabled, with the reason.
        const bare = await open(false);
        if (!viewport.mobile) await bare.locator('[data-attachment-id="att_1"]').hover();
        const disabled = await bare.locator('[data-attachment-id="att_1"] button[data-attachment-add]').isDisabled();
        if (!disabled) fail('the + should be disabled without a composer');
        await shot(bare, '05-plus-disabled');
        await bare.close();
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
