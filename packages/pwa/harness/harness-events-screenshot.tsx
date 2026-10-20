/**
 * Screenshots of the HARNESS'S OWN EVENTS in a Chat — Claude Code's background-task notifications and
 * the other records it types into the user channel — as the quiet system rows they now are, never the
 * reader's bubble. Two scenes, each at phone (390) and desktop (1440) in the light and dark studio themes:
 *
 *   * chat — a conversation in which a background command finishes, a monitor and a command fail in one
 *     record, a subagent finishes, a monitor reports, and the run is interrupted, between the reader's
 *     own messages.
 *   * expanded — the same rows opened: the whole command, the subagent's result, and the output file as
 *     text.
 *
 *   bun harness/harness-events-screenshot.tsx    # writes harness/out/events-<scene>-<viewport>-<scheme>.png
 *
 * It renders the REAL `TranscriptRow` over entries projected from a daemon log by
 * `transcriptEntriesFromLog`; the notifications are real Claude Code records with their paths
 * genericised. No network. Review evidence; nothing compares the PNGs.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

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
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { transcriptEntriesFromLog } from '../../src/components/session-workspace-model.ts';

const json = (value) => JSON.stringify(value);
const now = Date.UTC(2026, 9, 20, 2, 0, 0);
const indent = (text) => text.split('\\n').map((line, index) => (index === 0 ? line : '    ' + line)).join('\\n');
const TASKS = '/tmp/claude-1000/-home-kirin-Workspace-personal-ferretry/4ef0ca52/tasks';

const SETUP_DONE = [
  '<task-notification>',
  '<task-id>bdwjs9ydf</task-id>',
  '<tool-use-id>toolu_017HQfBCqvcdsLc218BNK2Nr</tool-use-id>',
  '<output-file>' + TASKS + '/bdwjs9ydf.output</output-file>',
  '<status>completed</status>',
  '<summary>Background command "direnv allow &amp;&amp; (direnv exec . task setup &gt; /tmp/setup.log 2&gt;&amp;1)" completed (exit code 0)</summary>',
  '</task-notification>',
].join('\\n');

const GATE_FAILED = [
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  'This is an automated background-task event, NOT a message from the user.',
  'Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.',
  '',
  '<task-notification>',
  '<task-id>bhl0m9340</task-id>',
  '<output-file>' + TASKS + '/bhl0m9340.output</output-file>',
  '<status>failed</status>',
  '<summary>Monitor "p7 heavy gate progress" script failed (exit 144)</summary>',
  '</task-notification>',
  '',
  '<task-notification>',
  '<task-id>b0v6baykt</task-id>',
  '<output-file>' + TASKS + '/b0v6baykt.output</output-file>',
  '<status>failed</status>',
  '<summary>Background command "cd /tmp/claude-1000/wt-p7-profiles &amp;&amp; direnv exec . task test:gate &gt; /tmp/claude-1000/wt-p7-gate.log 2&gt;&amp;1" failed with exit code 144</summary>',
  '</task-notification>',
].join('\\n');

const AGENT_DONE = [
  '<task-notification>',
  '<task-id>afbd57ca787c50cef</task-id>',
  '<output-file>' + TASKS + '/afbd57ca787c50cef.output</output-file>',
  '<status>completed</status>',
  '<summary>Agent "CLI statusline tests for U7" finished</summary>',
  '<result>The \\\`fy statusline\\\` tests are written and passing: 21 pass, 0 fail, with 100% line coverage of all three statusline files.',
  '',
  'Nothing is committed and no source was edited.</result>',
  '<usage><subagent_tokens>278205</subagent_tokens><tool_uses>4</tool_uses><duration_ms>60219</duration_ms></usage>',
  '</task-notification>',
].join('\\n');

const MONITOR_EVENT = [
  '<task-notification>',
  '<task-id>bemd1jvtu</task-id>',
  '<summary>Monitor event: "CI for #5/#1 + #1 local suite"</summary>',
  '<event>#5 6d05b08 : completed/success</event>',
  'If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn\\'t need one.',
  '</task-notification>',
].join('\\n');

const LOG = [
  '[01:40:02] user/message: Set the worktree up and run the gate in the background.',
  '[01:40:09] assistant/tool-call: Bash(' + json({ command: 'direnv allow && (direnv exec . task setup > /tmp/setup.log 2>&1)', run_in_background: true }) + ')',
  '[01:40:09] tool/tool-result: Command running in background with ID: bdwjs9ydf.',
  '[01:40:12] assistant/message: Setup is running in the background — I will pick it up when it finishes.',
  '[01:41:30] user/message: ' + indent(SETUP_DONE),
  '[01:41:34] assistant/message: Setup finished cleanly. Starting the gate and a monitor on it.',
  '[01:58:02] user/message: ' + indent(GATE_FAILED),
  '[01:58:06] assistant/message: The gate died with **exit 144** — another session took the heavy-gate lock. Retrying after it frees.',
  '[02:03:40] user/message: ' + indent(AGENT_DONE),
  '[02:04:10] user/message: ' + indent(MONITOR_EVENT),
  '[02:04:15] user/message: [Request interrupted by user]',
  '[02:04:20] user/message: Stop there — what failed?',
].join('\\n');

const entries = transcriptEntriesFromLog(LOG, now);
const scene = (name) => (
  <section data-scene={name} style={{ display: 'flow-root', padding: '12px 16px' }}>
    <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
      <div className="fy-transcript-content">
        {entries.map((entry, index) => (
          <TranscriptRow answered entry={entry} key={entry.id} previous={entries[index - 1]} />
        ))}
      </div>
    </div>
  </section>
);

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main style={{ margin: '0 auto', maxWidth: 760 }}>
    {scene('chat')}
    {scene('expanded')}
  </main>,
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/harness-events-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'harness-events-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'harness-events-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(Bun.file(join(outDir, url.pathname)));
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
        const page = await context.newPage();
        await page.goto(`${server.url}?theme=studio-${scheme}`);
        await page.locator('[data-scene="chat"] .fy-message-harness').first().waitFor({ state: 'visible' });
        const bubbles = await page.locator('[data-scene="chat"] [data-transcript-kind="user"]').count();
        if (bubbles !== 2) fail(`expected only the reader's own 2 bubbles, found ${bubbles}`);
        for (const toggle of await page.locator('[data-scene="expanded"] .fy-harness-event-toggle').all()) {
          await toggle.click();
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        for (const name of ['chat', 'expanded'] as const) {
          const target = join(outDir, `events-${name}-${viewport.name}-${scheme}.png`);
          await page.locator(`[data-scene="${name}"]`).screenshot({ path: target });
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
