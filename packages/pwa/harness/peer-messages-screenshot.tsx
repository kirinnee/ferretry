/**
 * Screenshots of messages BETWEEN FERRETS, as both ends' Chats draw them. Three scenes, each at phone
 * (390) and desktop (1440) in the light and dark studio themes:
 *
 *   * receiver — Tanna's Chat: a message tomi sent through a turn file, and a question kamila sent
 *     inline, each as a card FROM that ferret with only its body; the delivery's own "Read turn-001.md"
 *     is gone.
 *   * sender — tomi's Chat: its `fy send` calls as "Sent to" cards — one Tanna has since replied to, one
 *     still queued — instead of `Bash · fy send tanna "…"`.
 *   * failed — a send the daemon refused, with the CLI's reason said out loud.
 *
 *   bun harness/peer-messages-screenshot.tsx      # writes harness/out/peer-<scene>-<viewport>-<scheme>.png
 *
 * It renders the REAL `TranscriptRow` over entries projected from a real daemon log by
 * `transcriptEntriesFromLog` and placed by `placeLedgerRows`, inside the real hand-off and reference
 * providers, with the daemon's answers faked in the page — no network. Review evidence; nothing compares
 * the PNGs.
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
import { peerEnvelopePreamble, turnFileInstruction } from '@ferretry/protocol';
import { HandoffSourceProvider } from '../../src/components/handoff-message.tsx';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { withAgentName } from '../../src/components/transcript.tsx';
import { transcriptEntriesFromLog } from '../../src/components/session-workspace-model.ts';
import { createAgentReferenceResolver } from '../../src/lib/agent-references.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { placeLedgerRows } from '../../src/lib/ledger-placement.ts';

const TANNA = 'mvtanna0-6b1c2d3e';
const TOMI = 'mveq0r0r-ddd75d7b';
const KAMILA = 'mvkamil4-0a9b8c7d';
const fleet = [
  { config: { id: TANNA, teammate: 'tanna' }, state: { status: 'running' } },
  { config: { id: TOMI, teammate: 'tomi' }, state: { status: 'running' } },
  { config: { id: KAMILA, teammate: 'kamila' }, state: { status: 'waiting' } },
];
const surface = { agentReferenceResolver: createAgentReferenceResolver('harness', fleet), onNavigate: () => undefined };
const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'harness' });
const json = (value) => JSON.stringify(value);
const now = Date.UTC(2026, 9, 19, 2, 0, 0);

// RECEIVER: the owner's report, verbatim — tomi's message reached Tanna through a turn file, written by
// the older daemon, and Tanna read it before answering.
const TANNA_TURNS = '/home/kirin/.ferretry/state/sessions/' + TANNA + '/turns';
const TOMI_TURN = [
  '[peer message from teammate tomi (session ' + TOMI + ') — not from the human lead]',
  'No reply is required; tomi has carried on. Reply with \\\`fy send tomi "…"\\\` if useful.',
  '',
  'Hello from home-manager-fd (the user asked me to say hi).',
].join('\\n');
const KAMILA_INLINE = peerEnvelopePreamble({ name: 'kamila', sessionId: KAMILA, kind: 'question', clientName: 'fy' }) +
  'Is **CI** green on the relay branch? I am holding the merge on it.';
const indent = (text) => text.split('\\n').map((line, index) => (index === 0 ? line : '    ' + line)).join('\\n');
const RECEIVER_LOG = [
  '[01:40:02] user/message: Say hi back to whoever messages you today.',
  '[01:40:09] assistant/message: Will do.',
  '[01:44:10] user/message: ' + turnFileInstruction(TANNA_TURNS + '/turn-001.md'),
  '[01:44:11] assistant/tool-call: Read(' + json({ file_path: TANNA_TURNS + '/turn-001.md' }) + ')',
  '[01:44:11] tool/tool-result: ' + indent(TOMI_TURN),
  '[01:44:20] assistant/message: Hi **tomi** — thanks for saying hello. Replying now.',
  '[01:51:30] user/message: ' + indent(KAMILA_INLINE),
].join('\\n');
const receiverSends = [
  { sendId: 'r1', acceptedAt: '2026-10-19T01:44:09.000Z', message: TOMI_TURN, attachmentIds: [], fate: 'delivered', turn: 1, from: TOMI, fromName: 'tomi' },
];

// SENDER: tomi's side — a send Tanna has since answered, then one still riding Tanna's queue.
const TOMI_TURNS = '/home/kirin/.ferretry/state/sessions/' + TOMI + '/turns';
const SENDER_LOG = [
  '[01:43:50] user/message: Say hi to tanna from home-manager-fd.',
  '[01:44:02] assistant/tool-call: Bash(' + json({ command: 'fy send tanna "Hello from home-manager-fd (the user asked me to say hi)."' }) + ')',
  '[01:44:09] tool/tool-result: delivered',
  '[01:44:15] assistant/message: Sent. Tanna will see it at its next turn.',
  '[01:45:02] user/message: ' + turnFileInstruction(TOMI_TURNS + '/turn-004.md'),
  '[01:46:40] assistant/tool-call: Bash(' + json({ command: "fy send tanna --ask \\"$(cat <<'EOF'\\nCan you review the **relay** PR next?\\n\\n- it touches the carrier chooser\\n- CI is green\\nEOF\\n)\\"" }) + ')',
  "[01:46:41] tool/tool-result: queued in the agent's own queue (it auto-submits at the turn boundary)",
].join('\\n');
const senderSends = [
  { sendId: 's4', acceptedAt: '2026-10-19T01:45:00.000Z', message: 'x', attachmentIds: [], fate: 'delivered', turn: 4, from: TANNA, fromName: 'tanna' },
];
const TANNA_REPLY = '[reply from ferret tanna (session ' + TANNA + ') — not from the owner]\\nNo reply needed. To reply: fy send tanna "<reply>"\\n\\nHi tomi! Got it — hello back from Tanna.';

// FAILED: a send the daemon refused.
const FAILED_LOG = [
  '[01:52:00] assistant/message: Letting kamila know the merge can go ahead.',
  '[01:52:02] assistant/tool-call: exec_command(' + json({ cmd: 'fy send kamila "CI is green — merge away."' }) + ')',
  '[01:52:03] tool/tool-result: error session mvkamil4-0a9b8c7d is holding an unanswered structured question (toolu_01); answer or abandon it before sending prose',
].join('\\n');

const scene = (name, agent, log, sends, handoffs) => {
  const entries = placeLedgerRows(transcriptEntriesFromLog(log, now), sends, now).map(entry => withAgentName(entry, agent));
  const source = {
    daemon,
    sessionId: name,
    read: async (handoff) => {
      const message = handoffs[handoff];
      if (message === undefined) throw new Error('no hand-off ' + handoff);
      return { name: handoff, message, attachments: [] };
    },
  };
  return (
    <HandoffSourceProvider key={name} source={source}>
      <section data-scene={name} style={{ display: 'flow-root', padding: '12px 16px' }}>
        <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
          <div className="fy-transcript-content">
            {entries.map((entry, index) => (
              <TranscriptRow answered entry={entry} key={entry.id} previous={entries[index - 1]} />
            ))}
          </div>
        </div>
      </section>
    </HandoffSourceProvider>
  );
};

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <ReferenceSurfaceProvider surface={surface}>
    <main style={{ margin: '0 auto', maxWidth: 760 }}>
      {scene('receiver', 'Tanna', RECEIVER_LOG, receiverSends, { 'turn-001': TOMI_TURN })}
      {scene('sender', 'Tomi', SENDER_LOG, senderSends, { 'turn-004': TANNA_REPLY })}
      {scene('failed', 'Tomi', FAILED_LOG, [], {})}
    </main>
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/peer-messages-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'peer-messages-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'peer-messages-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
const SCENES = ['receiver', 'sender', 'failed'] as const;

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
        await page.locator('[data-scene="receiver"] .fy-message-peer[data-peer="tomi"]').waitFor({ state: 'visible' });
        await page.locator('[data-scene="sender"] [data-sent-state="replied"]').first().waitFor({ state: 'visible' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        for (const name of SCENES) {
          const target = join(outDir, `peer-${name}-${viewport.name}-${scheme}.png`);
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
