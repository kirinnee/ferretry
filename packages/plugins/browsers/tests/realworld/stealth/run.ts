/**
 * THE BOT-CHECK PASS-RATE SUITE (`task test:stealth`, B5 unit D1) — a RUNNER, not a test.
 *
 * It drives the REAL launcher (real Chrome, the real worker, a real private Xvfb in window mode) to the public
 * bot-check pages in `checks.ts`, one GET page load each, reads each page once its score has settled, scores it with
 * the pure scorers (`tests/support/stealth/scorers.ts`, unit-tested on saved fixtures) and prints a scorecard JSON
 * and a table. Its outcome depends on the network and on this machine's IP, so it is deliberately NOT a `*.test.ts`
 * and not part of `task test`, `task test:realworld` or CI.
 *
 *   task test:stealth -- [--modes headless,window] [--runs 3] [--only sannysoft,navia] [--label stock-5.0]
 *                        [--out scorecard.json] [--save-raw <dir>] [--settle <ms>]
 *
 * What it never does: type into a field, submit, sign in, solve a captcha, or open a host that is not in the check
 * list. Browser state is a throwaway directory per run; nothing of the host's own `HOME` or Ferretry state is read.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserMode } from '../../../contract/index.ts';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
import { XvfbDisplay } from '../../../daemon/worker/control/adapters/login-runtime.ts';
import { BrowserProfileStore } from '../../../daemon/worker/control/adapters/profile-store.ts';
import { NodeSessionBrowserLauncher } from '../../../daemon/worker/launcher.ts';
import { hostListenerProver } from '../../support/listener-prover.ts';
import { launcherPorts, loginProcesses, REAL_WORKER } from '../../support/process-workers.ts';
import { CAPTURE_SOURCE, withChallenge } from '../../support/stealth/capture.ts';
import { CHECKS, type Check, allowedHost } from '../../support/stealth/checks.ts';
import { type Observation, renderTable, scorecard } from '../../support/stealth/scorecard.ts';

const SESSION = 's1';
const POLL_MS = 2_000;

interface Options {
  readonly modes: readonly BrowserMode[];
  readonly runs: number;
  readonly only: readonly string[];
  readonly label: string;
  readonly out: string | undefined;
  readonly saveRaw: string | undefined;
  readonly settleMs: number | undefined;
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 2) {
    const flag = argv[at];
    const value = argv[at + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined)
      throw new Error(`unreadable arguments near "${flag ?? ''}": every option is --name value`);
    flags.set(flag.slice(2), value);
  }
  const known = ['modes', 'runs', 'only', 'label', 'out', 'save-raw', 'settle'];
  for (const name of flags.keys()) if (!known.includes(name)) throw new Error(`unknown option --${name}`);
  const modes = (flags.get('modes') ?? 'headless,window').split(',').map(mode => {
    if (mode !== 'headless' && mode !== 'window')
      throw new Error(`--modes takes headless and/or window, not "${mode}"`);
    return mode;
  });
  const runs = Number(flags.get('runs') ?? '3');
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs takes a whole number of at least 1');
  const only = (flags.get('only') ?? '').split(',').filter(id => id !== '');
  for (const id of only) if (!CHECKS.some(check => check.id === id)) throw new Error(`--only names no check "${id}"`);
  const settle = flags.get('settle');
  return {
    modes,
    runs,
    only,
    label: flags.get('label') ?? 'unlabelled',
    out: flags.get('out'),
    saveRaw: flags.get('save-raw'),
    settleMs: settle === undefined ? undefined : Number(settle),
  };
}

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const xvfb = Bun.which('Xvfb');

/** One throwaway browser in `mode`, torn down by `close`. */
async function startBrowser(
  mode: BrowserMode,
): Promise<{ browser: BrowserSessionService; close: () => Promise<void> }> {
  if (chrome === null || (mode === 'window' && xvfb === null))
    throw new Error('the suite needs a real Chrome on PATH, and Xvfb for window mode (the dev shell has both)');
  const root = await mkdtemp(join(tmpdir(), 'ferretry-stealth-'));
  const display = new XvfbDisplay({
    processes: loginProcesses(),
    authorityDirectory: join(root, 'x11'),
    executable: () => xvfb ?? undefined,
  });
  const browser = new BrowserSessionService(
    { get: async id => (id === SESSION ? {} : undefined) },
    new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      REAL_WORKER().start,
      launcherPorts(),
      // A throwaway HOME: nothing of this machine's own home is read by the browser.
      { FY_CHROME_BIN: chrome, PATH: process.env.PATH, HOME: root, FONTCONFIG_FILE: process.env.FONTCONFIG_FILE },
      undefined,
      {
        mode: async () => mode,
        display,
        platform: 'linux',
        transport: async () => 'port',
        listenerProver: hostListenerProver(),
      },
    ),
    () => Date.now(),
  );
  return {
    browser,
    close: async () => {
      await browser.closeAll().catch(() => undefined);
      await display.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** `browser.eval` hands a string result back JSON-quoted; the capture is the string inside. */
const unwrap = (text: string): string => (text.startsWith('"') ? (JSON.parse(text) as string) : text);

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Load one check page and read it until its score is on screen or its settle time is spent. */
async function observe(
  browser: BrowserSessionService,
  check: Check,
  options: Options,
): Promise<{ observation: Observation; html: string }> {
  if (!allowedHost(check.url)) throw new Error(`${check.id}: ${check.url} is not a host this suite may load`);
  const key = check.id;
  const settleMs = options.settleMs ?? check.settleMs;
  let html = '';
  try {
    await browser.openPage(SESSION, key, { url: check.url });
    const deadline = Date.now() + settleMs;
    for (;;) {
      const status = await browser.status(SESSION);
      const challenge = status.pages.find(page => page.name === key)?.challenge?.provider;
      const read = await browser.scriptOnPage(SESSION, key, { source: CAPTURE_SOURCE });
      html = withChallenge(unwrap(read.text), challenge);
      const reading = check.score(html);
      if ((reading.kind === 'scored' && (check.until === 'scored' || reading.pass)) || Date.now() >= deadline)
        return { observation: { check: check.id, reading }, html };
      await sleep(POLL_MS);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      observation: { check: check.id, reading: { kind: 'unreadable', reason: `could not load the page: ${reason}` } },
      html,
    };
  } finally {
    await browser.closePage(SESSION, key).catch(() => undefined);
  }
}

const options = parseOptions(Bun.argv.slice(2));
if (process.platform === 'linux' && process.env.FONTCONFIG_FILE === undefined)
  console.error(
    'note: FONTCONFIG_FILE is not set; on a box with no system fonts (a nix shell) Chrome dies on some pages. Point it at a fonts.conf.',
  );
const checks = options.only.length === 0 ? CHECKS : CHECKS.filter(check => options.only.includes(check.id));
const observations: { mode: BrowserMode; run: number; observation: Observation }[] = [];
if (options.saveRaw !== undefined) await mkdir(options.saveRaw, { recursive: true });

for (const mode of options.modes) {
  for (let run = 1; run <= options.runs; run += 1) {
    const { browser, close } = await startBrowser(mode);
    try {
      for (const check of checks) {
        const { observation, html } = await observe(browser, check, options);
        observations.push({ mode, run, observation });
        if (options.saveRaw !== undefined && html !== '')
          await writeFile(join(options.saveRaw, `${check.id}.${mode}.${String(run)}.html`), html);
        console.error(
          `[${mode} #${String(run)}] ${check.id}: ${observation.reading.kind === 'scored' ? (observation.reading.pass ? 'pass' : 'FAIL') : `UNREADABLE (${observation.reading.reason})`}`,
        );
      }
    } finally {
      await close();
    }
  }
}

const card = scorecard(options.label, observations);
if (options.out !== undefined) await writeFile(options.out, `${JSON.stringify(card, null, 2)}\n`);
console.log(JSON.stringify(card, null, 2));
console.log(renderTable(card));
