/**
 * CONVERSATION TITLES REACH THE REAL DRAWER (r11 S11, review item 3). Nothing here is a stand-in for the wiring under test:
 *
 *  - the REAL conversation index reads fake Claude transcripts (a fake vault masks the values it is told of);
 *  - the daemon's OWN wiring joins it to Ferrets: `ferretConversationNames` (which ferret runs which conversation, with its title
 *    and who chose it), `titleOffer` (`adoptTitle`) and `startTitleSweep` (the 5 s sweep that keeps ferrets' titles fresh);
 *  - the REAL `FerretsService` is behind the REAL drawer (`FerretListBody`) and the REAL header Rename, in Chromium.
 *
 * The owner's lines, as computed DOM: the title Claude Code writes AFTER the first exchange reaches the drawer row within 10 s with
 * nobody asking the index (no refresh is called by the test); and a Rename typed through the header's own form survives the next
 * title Claude Code writes, in the row, the header and the ferret's stored details.
 *
 * Set `FY_CONVERSATION_TITLES_SHOTS_DIR` to keep `<viewport>-<scheme>-drawer.png` and the measured numbers.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import { ConversationIndex, type ScrubBatch } from '../../../daemon/links/lib/conversation-index.ts';
import {
  ferretConversationNames,
  startTitleSweep,
  TITLE_SWEEP_MS,
  titleOffer,
} from '../../../daemon/links/lib/ferret-names.ts';
import { claudeRecord, MemoryHistory, memorySqlite, PARSERS } from '../../support/history-tree.ts';
import { CONVERSATION, drawerDaemon, type DrawerDaemon, FERRET } from './fixtures/titles-drawer-daemon.ts';

setDefaultTimeout(90_000);

/** The scene is Ferrets' own (the real list and header over HTTP); only the daemon behind it is this test's. */
const sceneRoot = join(import.meta.dir, '../../../../../core/ferrets/tests/integration/app');
const shotsDir = process.env.FY_CONVERSATION_TITLES_SHOTS_DIR ?? '';
const TRANSCRIPT = `projects/-work-app/${CONVERSATION}.jsonl`;
const AT = '2026-02-01T09:00:00.000Z';
const FIRST = 'can you look at why the deploy script fails on mac? see /tmp/x.log';
const LATE = 'Fix flaky deploy script';
const NEWER = 'Rewrite the release notes';
const FAKE_VALUE = 'hunter2-prod-deploy';

const vault: ScrubBatch = async work => work(text => text.split(FAKE_VALUE).join('[redacted:DEPLOY_KEY]'));

type Browser = Awaited<ReturnType<typeof sharedChromium>>;
let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let daemon: DrawerDaemon;
let history: MemoryHistory;
let index: ConversationIndex;
let sqlite: ReturnType<typeof memorySqlite>;
let stopSweep: () => void = () => undefined;
const offers: string[] = [];
const warnings: string[] = [];

const rec = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-titles-drawer-scene-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/ferret-titles-scene.tsx'],
    { cwd: sceneRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the drawer scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const served = await daemon.handle(request);
      if (served !== undefined) return served;
      if (new URL(request.url).pathname === '/app.js')
        return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  stopSweep();
  server?.stop(true);
  await daemon?.close();
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

/** A fresh conversation, a fresh index over it and the daemon's own sweep, with the ferret back to untitled. */
const begin = async (): Promise<void> => {
  stopSweep();
  await daemon?.close();
  daemon = await drawerDaemon();
  history = new MemoryHistory();
  history.set(TRANSCRIPT, `${claudeRecord('user', FIRST, AT)}\n${claudeRecord('assistant', 'looking', AT)}\n`);
  sqlite = memorySqlite();
  offers.length = 0;
  const adopt = titleOffer({ adoptTitle: async (id, title) => await daemon.service.adoptTitle(id, title) });
  const names = async () => ferretConversationNames(await daemon.service.list());
  index = new ConversationIndex({
    sqlite: () => sqlite,
    sources: async () => [
      { harness: 'claude-code', parser: 'claude', kind: 'computer', label: 'owner', files: history },
    ],
    ferretNames: names,
    parsers: PARSERS,
    nowMs: () => Date.now(),
    scrubbing: vault,
    adoptTitle: async (ferret, title) => {
      offers.push(`${ferret}=${title}`);
      return await adopt(ferret, title);
    },
  });
  // The daemon's warm-up read, a little after start; after it nothing but the sweep asks the index.
  await index.refresh();
  stopSweep = startTitleSweep({
    every: (intervalMs, tick) => {
      const timer = setInterval(tick, intervalMs);
      return () => clearInterval(timer);
    },
    names,
    refresh: async () => await index.refresh(),
    warn: message => warnings.push(message),
  });
};

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

describe('a title Claude Code writes after the first exchange, and the owner’s Rename, in the real drawer', () => {
  for (const variant of VARIANTS)
    it(`${variant.name}: the late CLI title reaches the drawer within 10 s; an owner's Rename survives the next one`, async () => {
      await begin();
      const context = await browser.newContext({
        viewport: { width: variant.width, height: variant.height },
        deviceScaleFactor: variant.phone ? 2 : 1,
        hasTouch: variant.phone,
        isMobile: variant.phone,
        colorScheme: variant.scheme,
      });
      try {
        const tab = await context.newPage();
        tab.setDefaultTimeout(12_000);
        const problems: string[] = [];
        tab.on('pageerror', error => problems.push(error.message));
        await tab.goto(`${server?.url.origin ?? ''}/?theme=studio-${variant.scheme}&view=live&ferret=${FERRET}`);
        await tab.waitForSelector(`[data-sbar-session="${FERRET}"]`);
        const row = tab.locator(`[data-sbar-session="${FERRET}"] .fy-sbar__name`);
        const header = tab.locator('[data-ferret-name]');

        // First exchange only: the warm-up read offered the title made from it, and the drawer shows it (no callsign).
        const made = (await daemon.stored())?.title;
        expect(made, 'the first read offered the deterministic title').toBeDefined();
        await row.filter({ hasText: made as string }).waitFor();
        expect(await row.innerText()).toBe(made as string);
        expect(await row.innerText()).not.toMatch(/ms-12/iu);
        expect((await daemon.stored())?.titleSource).toBe('auto');

        // Claude Code writes its own title; NOTHING asks the index but the daemon's own sweep.
        history.append(TRANSCRIPT, rec({ type: 'ai-title', aiTitle: LATE }));
        const appendedAt = performance.now();
        await row.filter({ hasText: LATE }).waitFor({ timeout: 12_000 });
        const reachedMs = Math.round(performance.now() - appendedAt);
        expect(reachedMs, `the late title reached the drawer in ${reachedMs} ms`).toBeLessThan(10_000);
        expect(await header.innerText()).toBe(LATE);
        expect(await daemon.stored()).toEqual({ title: LATE, titleSource: 'auto' });
        expect(offers).toContain(`${FERRET}=${LATE}`);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-drawer-late.png`) });

        // The owner renames it with the real form.
        await tab.getByRole('button', { name: 'Rename…' }).click();
        await tab.getByLabel('Task').fill('Ship The Deploy Fix');
        await tab.getByRole('button', { name: 'Save' }).click();
        await row.filter({ hasText: 'Ship The Deploy Fix' }).waitFor();
        await header.filter({ hasText: 'Ship The Deploy Fix' }).waitFor();
        expect(await daemon.stored()).toEqual({ title: 'Ship The Deploy Fix', titleSource: 'owner' });

        // Claude Code writes a newer title. With every ferret titled by its owner the sweep reads nothing; the Conversations list
        // (opened here as `refresh`, which a listing does first) reads it. The index HAS the newer title, and the drawer keeps the owner's.
        history.append(TRANSCRIPT, rec({ type: 'ai-title', aiTitle: NEWER }));
        const offersBefore = offers.length;
        await index.refresh();
        expect(
          sqlite.database
            .query('SELECT file_title FROM conv')
            .all()
            .map(found => (found as { file_title: string }).file_title),
          'the index read the newer title',
        ).toContain(NEWER);
        expect(offers.slice(offersBefore), 'an owner-titled ferret is offered nothing').toEqual([]);
        await Bun.sleep(600);
        expect(await row.innerText()).toBe('Ship The Deploy Fix');
        expect(await header.innerText()).toBe('Ship The Deploy Fix');
        expect(await daemon.stored()).toEqual({ title: 'Ship The Deploy Fix', titleSource: 'owner' });
        // The owner's title wins the Conversations list too.
        expect(index.query().conversations[0]?.row.name).toBe('Ship The Deploy Fix');
        expect(problems).toEqual([]);
        expect(warnings).toEqual([]);
        if (shotsDir !== '') {
          await tab.screenshot({ path: join(shotsDir, `${variant.name}-drawer-renamed.png`) });
          await writeFile(
            join(shotsDir, `${variant.name}-drawer.json`),
            JSON.stringify({ sweepMs: TITLE_SWEEP_MS, lateTitleReachedDrawerMs: reachedMs }, null, 2),
          );
        }
      } finally {
        await context.close();
      }
    });
});
