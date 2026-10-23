/**
 * Screenshots of PACK MODE from the parent's side (docs/pack-mode.md). Three scenes, each at phone (390)
 * and desktop (1440) in the light and dark studio themes:
 *
 *   * chat — fernanda's Chat: `fy recommend` as "Asked which model suits" (opened), a refused `fy new`
 *     followed by the next attempt, a "Started sub-ferret" card whose `fy wait` folded in as "Result
 *     collected", and a second sub-ferret still working — instead of five `Bash · fy …` rows.
 *   * header — the session bar's sub-ferret indicator, opened to the list.
 *   * info — Info › Overview's lineage: each sub-ferret with its live state, reason and model.
 *
 *   bun harness/pack-cards-screenshot.tsx      # writes harness/out/pack-<scene>-<viewport>-<scheme>.png
 *
 * It renders the REAL `TranscriptRow` over entries projected from a real daemon log by
 * `transcriptEntriesFromLog`, the real `SessionTopBar` and `InfoOverview`, inside the real reference and
 * pack-session providers — no network. Review evidence; nothing compares the PNGs.
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
import { PackSessionsProvider } from '../../src/components/pack-call.tsx';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import { SessionTopBar } from '../../src/components/session-top-bar.tsx';
import { SubFerretIndicator } from '../../src/components/sub-ferrets.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { transcriptEntriesFromLog } from '../../src/components/session-workspace-model.ts';
import { InfoOverview } from '../../src/features/session-info/info-overview.tsx';
import { createAgentReferenceResolver } from '../../src/lib/agent-references.ts';
import { subFerretsOf } from '../../src/lib/sub-ferret-state.ts';

const LEAD = 'mvlead00-1a2b3c4d';
const NADIA = 'mvnadia0-7f3a9c21';
const TOMI = 'mvtomi00-8b4c0d32';
const KAMILA = 'mvkamil4-0a9b8c7d';
const CWD = '/home/kirin/Workspace/personal/ferretry';
const view = (id, config, state) => ({
  config: { id, name: 'Session ' + id, agent: 'claude-work', harness: 'claude', modelHint: 'claude-opus-5-5', mode: 'auto',
    cwd: CWD, createdAt: '2026-10-20T02:00:00.000Z', updatedAt: '2026-10-20T02:00:00.000Z', boardAccess: 'none', ...config },
  state: { id, status: 'running', turn: 1, lastActivityAt: '2026-10-20T02:09:00.000Z', ...state },
  directory: '/state/' + id,
});
const lead = view(LEAD, { teammate: 'fernanda', mode: 'interactive', label: 'Harden the pack service' }, { turnState: 'working' });
const nadia = view(NADIA, { teammate: 'nadia', parent: LEAD, model: 'claude-opus-5-5', name: 'Review the pack service for races', createdAt: '2026-10-20T02:01:11.000Z' },
  { status: 'stopped', reason: 'its result was collected' });
const tomi = view(TOMI, { teammate: 'tomi', parent: LEAD, model: 'claude-haiku-4-5', agent: 'claude-fast', name: 'Sweep unused imports', createdAt: '2026-10-20T02:01:30.000Z' },
  { turnState: 'working' });
const kamila = view(KAMILA, { teammate: 'kamila', parent: LEAD, model: 'gpt-6-astra', agent: 'codex-work', harness: 'codex', name: 'Second opinion on the plan', createdAt: '2026-10-20T01:50:00.000Z' },
  { turnState: 'needs-input', turnPrompt: 'Allow codex to run git push?' });
// A long pack: the finished ones that used to flood the bar (stopped, completed, failed) beside the three live.
const finished = [
  ['mvdone01-1a2b3c4d', 'ottilie', 'Port the grant policy tests', { status: 'stopped', reason: 'its result was collected' }],
  ['mvdone02-2b3c4d5e', 'bertrand', 'Audit the relay allowlist', { status: 'completed' }],
  ['mvdone03-3c4d5e6f', 'celeste', 'Regenerate the protocol fixtures', { status: 'failed', reason: 'exited 1' }],
  ['mvdone04-4d5e6f70', 'dmitri', 'Trim the unused CSS tokens', { status: 'stopped', reason: 'its result was collected' }],
  ['mvdone05-5e6f7081', 'eleni', 'Write the pairing walkthrough', { status: 'completed' }],
].map(([id, teammate, name, state], index) =>
  view(id, { teammate, parent: LEAD, name, createdAt: '2026-10-20T01:' + (10 + index) + ':00.000Z' }, state));
const fleet = [lead, nadia, tomi, kamila, ...finished];
const surface = { agentReferenceResolver: createAgentReferenceResolver('harness', fleet), onNavigate: () => undefined };
const json = (value) => JSON.stringify(value);
const indent = (text) => text.split('\\n').map((line, index) => (index === 0 ? line : '    ' + line)).join('\\n');
const now = Date.UTC(2026, 9, 20, 2, 10, 0);

const heredoc = (head, brief) => head + ' "$(cat <<\\'EOF\\'\\n' + brief + '\\nEOF\\n)"';
const REVIEW = 'Review packages/daemon/src/lib/pack for races between concurrent starts.\\n\\nFocus on the probe cache and the admission count. Report each race as: where, how it happens, and a fix.';
const ADVICE = [
  'Routing prompt (your routing prompt):',
  'Planning and review go to claude-opus-5-5 at max; a second look at code Claude wrote goes to gpt-6-astra at high.',
  'Chores go to claude-haiku-4-5 at low. When a login is low on quota, move down a tier.',
  '',
  'Models usable here now (3):',
  'ready  Claude Opus 5.5 (claude-opus-5-5) at max · claude-work · quota 5h 2% · week 46% · named 1st in the prompt',
  '       fy new --runtime claude-work --model claude-opus-5-5 --effort max "<brief>"',
  'ready  GPT 6 Astra (gpt-6-astra) at high · codex-work · quota 5h 31% · named 2nd in the prompt',
  '       fy new --runtime codex-work --model gpt-6-astra --effort high "<brief>"',
  'cannot GLM 5 (glm-5) · zai-work',
  '       not_logged_in: zai-work needs signing in',
  '',
  'Start the first: fy new --runtime claude-work --model claude-opus-5-5 --effort max "<brief>"',
].join('\\n');
const REFUSED = [
  'Exit code 2',
  'fy new: refused (probe_failed): codex-work did not answer a "reply OK" check on gpt-6-astra: timed out after 45s.',
  'Try the next candidate.',
  '',
  'Tried:',
  '  refused codex-work gpt-6-astra (probe failed 45000 ms) — probe_failed: codex-work did not answer a "reply OK" check on gpt-6-astra: timed out after 45s.',
].join('\\n');
const STARTED_NADIA = [
  'Started nadia (' + NADIA + ') on claude-work, claude-opus-5-5 — decided by the routing prompt.',
  '  started claude-work claude-opus-5-5 (probe OK 812 ms)',
  'Wait for its result: fy wait ' + NADIA,
].join('\\n');
const STARTED_TOMI = [
  'Started tomi (' + TOMI + ') on claude-fast, claude-haiku-4-5 — decided by you.',
  '  started claude-fast claude-haiku-4-5 (probe OK, cached)',
  'Wait for its result: fy wait ' + TOMI,
].join('\\n');
const WAITED = [
  NADIA + ' is completed',
  '',
  'Found **two** races:',
  '',
  '1. \`probe.ts\` — two starts for the same model both miss the cache and both probe. Share the in-flight promise.',
  '2. \`admission.ts\` — the running-children count is read before the start is claimed. Count inside the claim.',
  'fy wait: stopped ' + NADIA + ' now its result is collected (--keep leaves it running)',
].join('\\n');
const LOG = [
  '[02:00:00] user/message: Harden the pack service — get a review for races, and sweep the unused imports while it runs.',
  '[02:00:05] assistant/message: I will hand both parts to sub-ferrets. First, which model suits the review:',
  '[02:00:06] assistant/tool-call: Bash(' + json({ command: 'fy recommend "review packages/daemon/src/lib/pack for races"' }) + ')',
  '[02:00:08] tool/tool-result: ' + indent(ADVICE),
  '[02:00:20] assistant/tool-call: Bash(' + json({ command: heredoc('fy new --runtime codex-work --model gpt-6-astra --effort high', REVIEW) }) + ')',
  '[02:01:05] tool/tool-result: error ' + indent(REFUSED),
  '[02:01:10] assistant/message: Codex did not answer its probe, so I am starting the next candidate.',
  '[02:01:11] assistant/tool-call: Bash(' + json({ command: heredoc('fy new --runtime claude-work --model claude-opus-5-5 --effort max', REVIEW) }) + ')',
  '[02:01:14] tool/tool-result: ' + indent(STARTED_NADIA),
  '[02:01:30] assistant/tool-call: Bash(' + json({ command: 'fy new --runtime claude-fast --model claude-haiku-4-5 --effort low "Remove unused imports across packages/pwa/src. Run biome after. Report the files changed."' }) + ')',
  '[02:01:31] tool/tool-result: ' + indent(STARTED_TOMI),
  '[02:01:40] assistant/message: Both are running. Waiting for the review first.',
  '[02:01:41] assistant/tool-call: Bash(' + json({ command: 'fy wait ' + NADIA }) + ')',
  '[02:09:00] tool/tool-result: ' + indent(WAITED),
  '[02:09:20] assistant/message: Nadia found two races. I will fix the probe cache first.',
].join('\\n');

const entries = transcriptEntriesFromLog(LOG, now);
const chat = (
  <section data-scene="chat" style={{ display: 'flow-root', padding: '12px 16px' }}>
    <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
      <div className="fy-transcript-content">
        {entries.map((entry, index) => (
          <TranscriptRow answered entry={entry} key={entry.id} previous={entries[index - 1]} />
        ))}
      </div>
    </div>
  </section>
);

const compact = window.innerWidth < 640;
const header = (
  <section data-scene="header" style={{ padding: '0 0 300px', minHeight: 360 }}>
    <SessionTopBar
      actions={<button className="kt-btn kt-btn--sm" type="button">Interrupt</button>}
      compact={compact}
      onToggleInfo={() => undefined}
      project="ferretry"
      session={lead}
      subFerrets={<SubFerretIndicator onOpenSession={() => undefined} sessions={subFerretsOf(LEAD, fleet)} />}
      turn="working"
    />
  </section>
);

const info = (
  <section className="fy-info" data-scene="info" style={{ padding: '12px 16px', maxWidth: 520 }}>
    <InfoOverview
      name="Fernanda"
      now={now}
      onOpenSession={() => undefined}
      project="ferretry"
      sessions={fleet}
      view={lead}
      worktrees={[]}
      write={async () => undefined}
    />
  </section>
);

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <ReferenceSurfaceProvider surface={surface}>
    <PackSessionsProvider sessions={fleet}>
      <main style={{ margin: '0 auto', maxWidth: 760 }}>
        {chat}
        {header}
        {info}
      </main>
    </PackSessionsProvider>
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/pack-cards-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'pack-cards-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'pack-cards-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
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
const SCENES = ['chat', 'header', 'info'] as const;

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
        await page.locator('[data-scene="chat"] [data-pack-state="started"]').first().waitFor({ state: 'visible' });
        // The folds a reader would open: the routing prompt, the models usable now and the working sub-ferret's brief.
        for (const summary of await page.locator('[data-pack-kind="recommend"] summary').all()) await summary.click();
        await page.locator('[data-pack-state="started"]').last().locator('.fy-pack-fold summary').click();
        // A phone's bar draws no sub-ferret pill at all; the desktop's opens to the ACTIVE ones only.
        if (viewport.mobile) {
          if ((await page.locator('[data-sub-ferret-toggle]').count()) !== 0)
            fail('a phone bar drew the sub-ferret pill');
        } else {
          await page.locator('[data-sub-ferret-toggle]').click();
          await page.locator('[data-sub-ferret-popover]').waitFor({ state: 'visible' });
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${overflow}px`);
        for (const name of SCENES) {
          const target = join(outDir, `pack-${name}-${viewport.name}-${scheme}.png`);
          await page.locator(`[data-scene="${name}"]`).screenshot({ path: target });
          process.stdout.write(`📸 ${target}\n`);
        }
        await page.locator('[data-sub-ferret-finished-toggle]').click();
        const expanded = join(outDir, `pack-info-finished-${viewport.name}-${scheme}.png`);
        await page.locator('[data-scene="info"]').screenshot({ path: expanded });
        process.stdout.write(`📸 ${expanded}\n`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
