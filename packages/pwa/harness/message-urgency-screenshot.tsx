/**
 * Screenshots of LABELLED and COMBINED ferret messages as the receiver's Chat draws them. Five scenes,
 * each at phone (390) and desktop (1440) in the light and dark studio themes:
 *
 *   * blocker / action / fyi — ONE message carrying its label, delivered inline: the sender's chip, its
 *     kind and the label chip.
 *   * batched — ONE turn that combined three messages from two ferrets (mixed labels, one a question),
 *     read from the turn file: three rows in order, each from its own sender — never one "You" bubble.
 *   * digest — ONE turn that held four FYIs from three ferrets until the receiver's turn ended.
 *
 *   bun harness/message-urgency-screenshot.tsx      # writes harness/out/urgency-<scene>-<viewport>-<scheme>.png
 *
 * It renders the REAL `TranscriptRow` over entries projected from a daemon-shaped log by
 * `transcriptEntriesFromLog`, with the combined text built by the REAL `combinedDelivery` and
 * `peerEnvelopePreamble`, inside the real hand-off and reference providers, with the daemon's answers
 * faked in the page — no network, fixture names only. Review evidence; nothing compares the PNGs.
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
import { combinedDelivery, peerEnvelopePreamble, turnFileInstruction } from '@ferretry/protocol';
import { HandoffSourceProvider } from '../../src/components/handoff-message.tsx';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { withAgentName } from '../../src/components/transcript.tsx';
import { transcriptEntriesFromLog } from '../../src/components/session-workspace-model.ts';
import { createAgentReferenceResolver } from '../../src/lib/agent-references.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { placeLedgerRows } from '../../src/lib/ledger-placement.ts';

const RUNE = 'mvrune00-6b1c2d3e';
const AVARY = 'mvavary0-ddd75d7b';
const BAXTER = 'mvbaxte0-0a9b8c7d';
const CLEO = 'mvcleo000-1f2e3d4c';
const fleet = [
  { config: { id: RUNE, teammate: 'rune' }, state: { status: 'running' } },
  { config: { id: AVARY, teammate: 'avary' }, state: { status: 'running' } },
  { config: { id: BAXTER, teammate: 'baxter' }, state: { status: 'waiting' } },
  { config: { id: CLEO, teammate: 'cleo' }, state: { status: 'running' } },
];
const surface = { agentReferenceResolver: createAgentReferenceResolver('harness', fleet), onNavigate: () => undefined };
const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'harness' });
const json = (value) => JSON.stringify(value);
const now = Date.UTC(2026, 9, 19, 2, 0, 0);
const RUNE_TURNS = '/home/kirin/.ferretry/state/sessions/' + RUNE + '/turns';
const indent = (text) => text.split('\\n').map((line, index) => (index === 0 ? line : '    ' + line)).join('\\n');

const single = (sender, label, kind, body) => {
  const text = peerEnvelopePreamble({ ...sender, kind, label, clientName: 'fy' }) + body;
  return {
    log: [
      '[01:40:02] user/message: Keep working on the relay branch; ferrets may message you.',
      '[01:40:09] assistant/message: Understood.',
      '[01:51:30] user/message: ' + indent(text),
    ].join('\\n'),
    handoffs: {},
  };
};

const combined = (parts, turn, reply) => {
  const text = combinedDelivery(parts, 'fy');
  return {
    log: [
      '[01:40:02] user/message: Keep working on the relay branch; ferrets may message you.',
      '[01:40:09] assistant/message: Understood.',
      '[01:52:10] user/message: ' + turnFileInstruction(RUNE_TURNS + '/' + turn + '.md'),
      '[01:52:11] assistant/tool-call: Read(' + json({ file_path: RUNE_TURNS + '/' + turn + '.md' }) + ')',
      '[01:52:11] tool/tool-result: ' + indent(text),
      '[01:52:20] assistant/message: ' + reply,
    ].join('\\n'),
    handoffs: { [turn]: text },
  };
};

const avary = { name: 'avary', sessionId: AVARY };
const baxter = { name: 'baxter', sessionId: BAXTER };
const cleo = { name: 'cleo', sessionId: CLEO };

const SCENES = {
  blocker: single(avary, 'blocker', 'message', 'I cannot go on: the **relay** migration needs your decision on the schema before I touch the tests.'),
  action: single(baxter, 'action', 'message', 'Please rebase \`feat/relay\` on main when you next stop; CI is waiting on it.'),
  fyi: single(cleo, 'fyi', 'message', 'FYI: the docs build is green again after the link fix. Nothing to do.'),
  batched: combined(
    [
      { sender: { ...avary, kind: 'message', label: 'action' }, body: 'Please rebase \`feat/relay\` on main when you next stop.' },
      { sender: { ...baxter, kind: 'question', label: 'blocker' }, body: 'Is **CI** green on the relay branch? I am holding the merge on it.' },
      { sender: { ...avary, kind: 'message', label: 'fyi' }, body: 'The fixture names changed in \`harness/\`; no action needed.' },
    ],
    'turn-007',
    'Read all of them; the blocker first.',
  ),
  digest: combined(
    [
      { sender: { ...avary, kind: 'message', label: 'fyi' }, body: 'Docs build is green again.' },
      { sender: { ...cleo, kind: 'message', label: 'fyi' }, body: 'Lint noise on \`relay/\` is a known false positive.' },
      { sender: { ...baxter, kind: 'message', label: 'fyi' }, body: 'I finished the cask check; nothing changed.' },
      { sender: { ...cleo, kind: 'message', label: 'fyi' }, body: 'Release notes drafted, parked for later.' },
    ],
    'turn-009',
    'Read the digest; nothing needs me.',
  ),
};

const scene = (name, { log, handoffs }) => {
  const entries = placeLedgerRows(transcriptEntriesFromLog(log, now), [], now).map(entry => withAgentName(entry, 'Rune'));
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
      {Object.entries(SCENES).map(([name, value]) => scene(name, value))}
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/message-urgency-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'message-urgency-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'message-urgency-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
const SCENE_NAMES = ['blocker', 'action', 'fyi', 'batched', 'digest'] as const;
const EXPECTED_ROWS = { blocker: 1, action: 1, fyi: 1, batched: 3, digest: 4 } as const;

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
        for (const name of SCENE_NAMES) {
          const rows = page.locator(`[data-scene="${name}"] .fy-message-peer`);
          await rows.first().waitFor({ state: 'visible' });
          const found = await rows.count();
          if (found !== EXPECTED_ROWS[name]) fail(`${name}: ${found} peer rows, expected ${EXPECTED_ROWS[name]}`);
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        for (const name of SCENE_NAMES) {
          const target = join(outDir, `urgency-${name}-${viewport.name}-${scheme}.png`);
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
