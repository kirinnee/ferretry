/**
 * How long the app takes to become useful over the RELAY, and what it asks the daemon for on the way.
 *
 * Everything is real except the network's distance: two compiled daemons, the real rendezvous code
 * (`scripts/test/rendezvous-process.ts`) holding every frame it forwards for half the chosen round trip,
 * the built PWA in a real Chrome, and two pairings made through the confirm screen. Direct is a
 * sinkhole, so every request crosses the relay — the carrier a phone away from home uses.
 *
 * The fleet is the owner's: 15 sessions across 2 machines, one of them bound to a 200 MB transcript
 * with a long journal behind it, the others to ordinary ones.
 *
 * WHAT IS COUNTED, AND HOW. A relay record is end-to-end encrypted (relay-protocol.md §7), so neither
 * the rendezvous nor a proxy can say which route a request named. The page can: an init script wraps
 * `SubtleCrypto.encrypt`/`decrypt` for AES-GCM and keeps each §14 plaintext's `t`, `id`, `method`,
 * `path`, `status` and size. Nothing is altered, and the credentials it would see are this run's
 * throwaway pairing. Milestones are DOM facts the app already exposes (`data-session-row`,
 * `data-transcript-kind`, `data-cache-updating`, `data-connection-pill`).
 *
 * Phases, each from the page's own clock:
 *   cold open    — the sessions list right after pairing, nothing cached
 *   warm open    — a reload of the same list, the cache present (median of `--samples`)
 *   switch       — clicking the 200 MB session from the list, until its transcript is live
 *   idle         — 20 s on that session doing nothing
 *   back         — Back to the list
 *   blip         — the rendezvous dropped and back at once (a sub-second outage), on the session
 *   outage       — the rendezvous down for 3 s, on the session
 *
 * Manual only, never CI. Needs the compiled `dist/bin/fy*-<host>` binaries and Chrome:
 *
 *   bun scripts/local/bench-app-load.ts [--rtt 100] [--samples 3] [--transcript-mb 200] [--journal 2000]
 *     [--out report.json] [--shots <dir>] [--quick] [--profile-only]
 *
 * `--quick` stops after the cold open, `--profile-only` after the daemon route profile (no browser),
 * and `--shots` writes the outage screenshots (desktop and phone, light and dark).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type E2eEnvironment, withE2eEnvironment } from '../../tests/e2e/fixture.ts';
import { seedRunningSession } from '../../tests/e2e/support/seeded-session.ts';
import {
  type BrowserSession,
  buildPwaBundle,
  clickFirstPresent,
  harnessTeardown,
  launchChrome,
  type RendezvousProcess,
  startDirectSinkhole,
  startPwaOrigin,
  startRelayDirectory,
  startRendezvous,
  waitForDaemonFingerprint,
} from '../../tests/e2e/support/relay-harness.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
const PAIRING_LINK = /https?:\/\/\S*#v\d;\S+/u;

interface Options {
  readonly rttMs: number;
  readonly samples: number;
  readonly transcriptMb: number;
  readonly out: string | undefined;
  readonly label: string;
  /** Stop after the cold open: for checking the harness itself. */
  readonly quick: boolean;
  /** Stop after the daemon's own route profile: no browser at all. */
  readonly profileOnly: boolean;
  /** Journal events seeded on the big session. */
  readonly journal: number;
  /** Where to write the evidence screenshots; absent: none are taken. */
  readonly shots: string | undefined;
}

function parseOptions(argv: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    rttMs: Number(value('--rtt') ?? 100),
    samples: Number(value('--samples') ?? 3),
    transcriptMb: Number(value('--transcript-mb') ?? 200),
    out: value('--out'),
    label: value('--label') ?? 'run',
    quick: argv.includes('--quick'),
    profileOnly: argv.includes('--profile-only'),
    journal: Number(value('--journal') ?? 2_000),
    shots: value('--shots'),
  };
}

// ─── the fleet ───────────────────────────────────────────────────────────────────────────────

interface SeededMachine {
  readonly label: string;
  readonly environment: E2eEnvironment;
  readonly sessions: readonly { readonly id: string; readonly name: string }[];
  fingerprint: string;
  pairUrl: string;
}

function compiledBinary(prefix: 'fy' | 'fyd'): string {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
  return join(REPOSITORY_ROOT, 'dist', 'bin', `${prefix}-${platform}-${architecture}`);
}

function daemonDocument(bindPort: number, publicUrl: string, appOrigin: string): string {
  return `${JSON.stringify({ publicUrl, corsOrigins: [appOrigin], carriers: [{ kind: 'bind', host: '127.0.0.1', port: bindPort }] }, null, 2)}\n`;
}

/** One exchange of a long conversation, about 2 KB: a question, a tool call, its result and an answer. */
function exchange(harnessSessionId: string, index: number, at: number): string {
  const stamp = (offset: number): string => new Date(at + index * 4_000 + offset).toISOString();
  const prose = `Step ${String(index)}: ${'the agent explains what it changed and why it matters. '.repeat(9)}`;
  const rows = [
    {
      type: 'user',
      uuid: `u-${String(index)}`,
      timestamp: stamp(0),
      message: { role: 'user', content: `Please continue with part ${String(index)}.` },
    },
    {
      type: 'assistant',
      uuid: `a-${String(index)}`,
      timestamp: stamp(1_000),
      message: {
        id: `m-${String(index)}`,
        role: 'assistant',
        model: 'claude-synthetic',
        stop_reason: 'tool_use',
        usage: { input_tokens: 1_200, output_tokens: 300 },
        content: [
          { type: 'text', text: 'Reading the file first.' },
          {
            type: 'tool_use',
            id: `t-${String(index)}`,
            name: 'Read',
            input: { file_path: `/src/part-${String(index)}.ts` },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: `r-${String(index)}`,
      timestamp: stamp(2_000),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `t-${String(index)}`, content: 'export const x = 1;\n'.repeat(20) },
        ],
      },
    },
    {
      type: 'assistant',
      uuid: `b-${String(index)}`,
      timestamp: stamp(3_000),
      message: {
        id: `n-${String(index)}`,
        role: 'assistant',
        model: 'claude-synthetic',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1_500, output_tokens: 400 },
        content: [{ type: 'text', text: prose }],
      },
    },
  ];
  return rows.map(row => JSON.stringify({ ...row, sessionId: harnessSessionId })).join('\n');
}

async function writeTranscript(file: string, harnessSessionId: string, bytes: number): Promise<void> {
  const writer = Bun.file(file).writer();
  const at = Date.parse('2026-09-01T00:00:00.000Z');
  let written = 0;
  for (let index = 0; written < bytes; index += 1) {
    const chunk = `${exchange(harnessSessionId, index, at)}\n`;
    writer.write(chunk);
    written += chunk.length;
  }
  await writer.end();
}

async function seedMachine(
  machine: SeededMachine,
  bigSessionId: string,
  transcriptBytes: number,
  journal: number,
): Promise<void> {
  const home = machine.environment.paths.fyHome;
  const transcripts = join(machine.environment.paths.root, 'transcripts');
  await mkdir(transcripts, { recursive: true });
  for (const [index, session] of machine.sessions.entries()) {
    const harnessSessionId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const file = join(transcripts, `${harnessSessionId}.jsonl`);
    await writeTranscript(file, harnessSessionId, session.id === bigSessionId ? transcriptBytes : 400_000);
    await seedRunningSession(home, new Date(Date.now() - index * 60_000).toISOString(), {
      sessionId: session.id,
      name: session.name,
      transcript: { file, harnessSessionId },
      turnState: 'your-turn',
      journal: session.id === bigSessionId ? journal : 100,
    });
  }
}

async function bootMachine(
  machine: SeededMachine,
  rendezvous: RendezvousProcess,
  directoryOrigin: string,
  sinkholeOrigin: string,
  appOrigin: string,
): Promise<void> {
  const { environment } = machine;
  const configPath = join(environment.paths.root, 'daemon.json');
  await writeFile(configPath, daemonDocument(environment.ports.api, sinkholeOrigin, appOrigin), 'utf8');
  const boot = async (): Promise<void> =>
    await environment.startDaemon({
      command: [compiledBinary('fyd'), '--config', configPath],
      readyUrl: environment.httpUrl('/v1/health'),
      timeoutMs: 30_000,
      env: { FY_RELAY_DIRECTORY_ORIGIN: directoryOrigin },
    });
  const before = await rendezvous.dialled();
  await boot();
  machine.fingerprint = await waitForDaemonFingerprint(rendezvous, before);
  await environment.stopDaemon();
  await rendezvous.allow(machine.fingerprint);
  await boot();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = await rendezvous.sockets().catch(() => []);
    if (rows.some(row => row.rendezvous.includes(machine.fingerprint) && row.roles.includes('daemon'))) break;
    await Bun.sleep(100);
  }
  const minted = await environment.runFy(['pair', '--no-wait'], { FY_URL: environment.httpUrl() });
  const link = PAIRING_LINK.exec(`${minted.out}\n${minted.err}`)?.[0];
  if (link === undefined) throw new Error(`\`fy pair --no-wait\` printed no link for ${machine.label}: ${minted.err}`);
  machine.pairUrl = `${appOrigin}/pair#${link.slice(link.indexOf('#') + 1)}`;
}

const diagnostics: string[] = [];

/**
 * The daemon's own cost per route, over loopback with the host token and no relay: the median of
 * five reads of each, with the size of what came back. What a relay adds sits on top of this.
 */
async function profileRoutes(environment: E2eEnvironment, sessionId: string): Promise<Record<string, unknown>> {
  const token = (await Bun.file(join(environment.paths.fyHome, 'api-token')).text()).trim();
  const routes = [
    '/v1/sessions',
    `/v1/sessions/${sessionId}`,
    `/v1/sessions/${sessionId}/logs`,
    `/v1/sessions/${sessionId}/sends`,
    `/v1/sessions/${sessionId}/attention`,
    `/v1/sessions/${sessionId}/events?after=0&limit=1000`,
    '/v1/usage',
  ];
  const profile: Record<string, unknown> = {};
  for (const route of routes) {
    const times: number[] = [];
    let status = 0;
    let bytes = 0;
    let etag: string | null = null;
    for (let sample = 0; sample < 5; sample += 1) {
      const started = performance.now();
      const response = await fetch(environment.httpUrl(route), { headers: { Authorization: `Bearer ${token}` } });
      bytes = (await response.arrayBuffer()).byteLength;
      times.push(performance.now() - started);
      status = response.status;
      etag = response.headers.get('etag');
    }
    let notModifiedMs: number | null = null;
    if (etag !== null) {
      const started = performance.now();
      const response = await fetch(environment.httpUrl(route), {
        headers: { Authorization: `Bearer ${token}`, 'If-None-Match': etag },
      });
      await response.arrayBuffer();
      notModifiedMs = response.status === 304 ? Math.round(performance.now() - started) : null;
    }
    profile[route.replace(sessionId, ':big')] = {
      status,
      bytes,
      medianMs: Math.round(median(times) ?? 0),
      notModifiedMs,
    };
  }
  return profile;
}

/** How long the session's journal is, read over loopback with the host token. */
async function journalLength(environment: E2eEnvironment, sessionId: string): Promise<number> {
  const token = (await Bun.file(join(environment.paths.fyHome, 'api-token')).text()).trim();
  let cursor = 0;
  for (;;) {
    const response = await fetch(
      environment.httpUrl(`/v1/sessions/${sessionId}/events?after=${String(cursor)}&limit=1000`),
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const raw = (await response.json()) as unknown;
    if (cursor === 0) diagnostics.push(`events read: ${JSON.stringify(raw).slice(0, 300)}`);
    const page = (Array.isArray(raw) ? raw : ((raw as { events?: unknown[] }).events ?? [])) as readonly {
      readonly sequence: number;
    }[];
    if (page.length === 0) return cursor;
    cursor = page.at(-1)?.sequence ?? cursor;
    if (page.length < 1_000) return cursor;
  }
}

async function pair(browser: BrowserSession, machine: SeededMachine): Promise<void> {
  await browser.page.goto('about:blank');
  await browser.page.goto(machine.pairUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await browser.page.waitForSelector('[data-pairing-stage="confirm"]', { timeout: 20_000 });
  if ((await clickFirstPresent(browser.page, ['[data-pair-confirm]'])) === null)
    throw new Error(`no confirm control for ${machine.label}`);
  await Promise.race([
    browser.page.waitForSelector('[data-pairing-stage="paired"]', { timeout: 45_000 }),
    browser.page.waitForSelector('[data-pairing-stage]', { state: 'detached', timeout: 45_000 }),
  ]);
}

// ─── the recorder ──────────────────────────────────────────────────────────────────────────

/** Installed before any app code: the §14 plaintext of every record this page seals or opens. */
const RECORDER = `(() => {
  if (typeof SubtleCrypto === 'undefined' || typeof window === 'undefined') return;
  const log = [];
  Object.defineProperty(window, '__fyBench', { value: log });
  const text = new TextDecoder();
  const view = data => data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const note = (dir, bytes) => {
    if (bytes.byteLength === 0 || bytes[0] !== 123) return;
    try {
      const m = JSON.parse(text.decode(bytes));
      if (typeof m.t !== 'string') return;
      log.push({ at: performance.now(), dir, t: m.t, id: m.id, method: m.method, path: m.path, status: m.status, more: m.more === true, n: bytes.byteLength });
    } catch {}
  };
  const proto = SubtleCrypto.prototype;
  const encrypt = proto.encrypt;
  const decrypt = proto.decrypt;
  proto.encrypt = function (algorithm, key, data) {
    if (algorithm && algorithm.name === 'AES-GCM') note('out', view(data));
    return encrypt.call(this, algorithm, key, data);
  };
  proto.decrypt = async function (algorithm, key, data) {
    const opened = await decrypt.call(this, algorithm, key, data);
    if (algorithm && algorithm.name === 'AES-GCM') note('in', new Uint8Array(opened));
    return opened;
  };
})();`;

interface Recorded {
  readonly at: number;
  readonly dir: 'out' | 'in';
  readonly t: string;
  readonly id?: number;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly more: boolean;
  readonly n: number;
}

interface PhaseTraffic {
  /** `req` records sent: one per request. */
  readonly requests: number;
  /** Stream sessions opened (`/v1/events`, terminals). */
  readonly streams: number;
  readonly bytesOut: number;
  readonly bytesIn: number;
  /** Requests by `METHOD path`, most first. */
  readonly routes: Readonly<Record<string, number>>;
  /** Responses by status. */
  readonly statuses: Readonly<Record<string, number>>;
  /** Bytes received by record type: `res`/`res-more` are request answers, `data` is stream frames. */
  readonly kbInByType: Readonly<Record<string, number>>;
  /** The deepest chain of requests where one was sent only after another had answered, within 30 ms. */
  readonly waves: number;
}

function traffic(records: readonly Recorded[]): PhaseTraffic {
  const routes: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  const inByType: Record<string, number> = {};
  let requests = 0;
  let streams = 0;
  let bytesOut = 0;
  let bytesIn = 0;
  for (const record of records) {
    if (record.dir === 'out') bytesOut += record.n;
    else {
      bytesIn += record.n;
      inByType[record.t] = (inByType[record.t] ?? 0) + record.n;
    }
    if (record.t === 'req') {
      requests += 1;
      const key = `${record.method ?? '?'} ${normalise(record.path ?? '?')}`;
      routes[key] = (routes[key] ?? 0) + 1;
    }
    if (record.t === 'stream') {
      streams += 1;
      const key = `STREAM ${normalise(record.path ?? '?')}`;
      routes[key] = (routes[key] ?? 0) + 1;
    }
    if (record.t === 'res') statuses[String(record.status)] = (statuses[String(record.status)] ?? 0) + 1;
  }
  return {
    requests,
    streams,
    bytesOut,
    bytesIn,
    routes: Object.fromEntries(Object.entries(routes).sort((left, right) => right[1] - left[1])),
    statuses,
    kbInByType: Object.fromEntries(Object.entries(inByType).map(([type, bytes]) => [type, Math.round(bytes / 1024)])),
    waves: waves(records),
  };
}

/** Request waves: a request sent within 30 ms after a response landed starts the next wave. */
function waves(records: readonly Recorded[]): number {
  let wave = 0;
  let lastResponseAt = Number.NEGATIVE_INFINITY;
  let waveOpenedBy = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    if (record.t === 'res') lastResponseAt = record.at;
    if (record.t !== 'req' && record.t !== 'stream') continue;
    if (wave === 0 || (lastResponseAt > waveOpenedBy && record.at - lastResponseAt < 30)) {
      wave += 1;
      waveOpenedBy = record.at;
    }
  }
  return wave;
}

/** Ids become `:id` so one route is one row. */
function normalise(path: string): string {
  return path
    .replace(/fy_s_[A-Za-z0-9]+/gu, ':session')
    .replace(/\/attachments\/[^/]+/gu, '/attachments/:id')
    .replace(/\/terminals\/[^/]+/gu, '/terminals/:id');
}

async function now(browser: BrowserSession): Promise<number> {
  return await browser.page.evaluate<number>('performance.now()');
}

async function recorded(browser: BrowserSession, from: number, to = Number.POSITIVE_INFINITY): Promise<Recorded[]> {
  const all = await browser.page.evaluate<Recorded[]>('window.__fyBench ?? []');
  return all.filter(record => record.at >= from && record.at <= to);
}

/** Poll a page condition every 10 ms; answer the page instant it first held, or `null` on timeout. */
async function until(browser: BrowserSession, condition: string, timeoutMs = 60_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const at = await browser.page.evaluate<number | null>(`(() => (${condition}) ? performance.now() : null)()`);
    if (at !== null) return at;
    await Bun.sleep(10);
  }
  return null;
}

const ROWS_SHOWN = `document.querySelectorAll('a[href*="/session/fy_s_bench"]').length > 0`;
const NOT_UPDATING = `document.querySelector('[data-cache-updating]') === null`;
const TRANSCRIPT_SHOWN = `document.querySelectorAll('.fy-message').length > 0`;
const PILL_SHOWN = `document.querySelector('[data-connection-pill], [data-connection-stall]') !== null`;

interface OpenSample {
  readonly firstRowMs: number | null;
  readonly updatingClearedMs: number | null;
  readonly traffic: PhaseTraffic;
}

async function openList(browser: BrowserSession, url: string, reload: boolean): Promise<OpenSample> {
  const page = browser.page as unknown as { reload(options: { waitUntil: string }): Promise<unknown> };
  if (reload) await page.reload({ waitUntil: 'commit' });
  else await browser.page.goto(url, { waitUntil: 'commit' });
  // A new document: its clock starts at zero at navigation, so every milestone is from navigation.
  const firstRowMs = await until(browser, ROWS_SHOWN);
  const updatingClearedMs = await until(browser, `${ROWS_SHOWN} && ${NOT_UPDATING}`);
  await Bun.sleep(5_000);
  return {
    firstRowMs,
    updatingClearedMs,
    traffic: traffic(await recorded(browser, 0, (updatingClearedMs ?? 0) + 5_000)),
  };
}

interface SwitchSample {
  readonly transcriptMs: number | null;
  readonly updatingClearedMs: number | null;
  readonly traffic: PhaseTraffic;
  readonly trafficFirst10s: PhaseTraffic;
}

async function switchTo(browser: BrowserSession, sessionId: string): Promise<SwitchSample> {
  const start = await now(browser);
  await browser.page.evaluate(`(() => {
    const link = [...document.querySelectorAll('a[href*="/session/"]')].find(node => node.getAttribute('href').endsWith(${JSON.stringify(sessionId)}));
    link?.click();
  })()`);
  const transcriptAt = await until(browser, TRANSCRIPT_SHOWN);
  const clearedAt = await until(browser, `${TRANSCRIPT_SHOWN} && ${NOT_UPDATING}`);
  await Bun.sleep(10_000);
  return {
    transcriptMs: transcriptAt === null ? null : transcriptAt - start,
    updatingClearedMs: clearedAt === null ? null : clearedAt - start,
    traffic: traffic(await recorded(browser, start, (clearedAt ?? start) + 1)),
    trafficFirst10s: traffic(await recorded(browser, start, start + 10_000)),
  };
}

interface DropSample {
  readonly pillShown: boolean;
  readonly pillFirstMs: number | null;
  readonly pillGoneMs: number | null;
  readonly traffic: PhaseTraffic;
}

async function drop(browser: BrowserSession, rendezvous: RendezvousProcess, downMs: number): Promise<DropSample> {
  const start = await now(browser);
  const restarting = rendezvous.restart({ downMs });
  let pillFirstMs: number | null = null;
  let pillGoneMs: number | null = null;
  const stopAt = Date.now() + 20_000;
  while (Date.now() < stopAt) {
    const shown = await browser.page.evaluate<boolean>(PILL_SHOWN);
    const at = (await now(browser)) - start;
    if (shown && pillFirstMs === null) pillFirstMs = at;
    if (!shown && pillFirstMs !== null && pillGoneMs === null) pillGoneMs = at;
    await Bun.sleep(20);
  }
  await restarting;
  return {
    pillShown: pillFirstMs !== null,
    pillFirstMs,
    pillGoneMs,
    traffic: traffic(await recorded(browser, start, start + 20_000)),
  };
}

/**
 * The session page at 1 s and at 3 s into an outage, at desktop and phone width in both schemes: the
 * first is inside the quiet window (nothing said), the second past it (the pill).
 */
async function evidence(
  browser: BrowserSession,
  rendezvous: RendezvousProcess,
  url: string,
  dir: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await browser.page.emulateMedia({ colorScheme: scheme });
    for (const viewport of [
      { name: 'desktop', width: 1_440, height: 900 },
      { name: 'phone', width: 390, height: 844 },
    ]) {
      await browser.page.setViewportSize({ width: viewport.width, height: viewport.height });
      await browser.page.goto(url, { waitUntil: 'commit' });
      await until(browser, `${TRANSCRIPT_SHOWN} && ${NOT_UPDATING}`);
      await Bun.sleep(4_000);
      // This run has no authenticator, so the passkey prompt is dismissed the way a person would.
      await browser.page.evaluate(
        `[...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')]
          .find(button => button.textContent?.trim() === 'Cancel')?.click()`,
      );
      await Bun.sleep(300);
      const restarting = rendezvous.restart({ downMs: 5_000 });
      await Bun.sleep(1_000);
      await browser.page.screenshot({ path: join(dir, `outage-1s-${viewport.name}-${scheme}.png`) });
      await Bun.sleep(2_000);
      await browser.page.screenshot({ path: join(dir, `outage-3s-${viewport.name}-${scheme}.png`) });
      await restarting;
      await until(browser, `!(${PILL_SHOWN})`, 30_000);
    }
  }
}

function median(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null).sort((left, right) => left - right);
  if (known.length === 0) return null;
  return known[Math.floor(known.length / 2)] ?? null;
}

function progress(line: string): void {
  process.stderr.write(`[bench] ${new Date().toISOString().slice(11, 19)} ${line}\n`);
}

// ─── the run ───────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  process.env.CLI_BIN ??= compiledBinary('fy');
  const teardown = harnessTeardown();
  const report: Record<string, unknown> = {
    label: options.label,
    rttMs: options.rttMs,
    transcriptMb: options.transcriptMb,
    at: new Date().toISOString(),
  };
  try {
    await withE2eEnvironment(async studio => {
      await withE2eEnvironment(async laptop => {
        const rendezvous = await startRendezvous(studio.paths.root, teardown, [
          '--timing-only',
          '--one-way-ms',
          String(options.rttMs / 2),
        ]);
        const directory = await startRelayDirectory();
        directory.publish(rendezvous.relayUrl);
        const sinkhole = await startDirectSinkhole(teardown);
        const served = await startPwaOrigin(await buildPwaBundle(directory.origin), teardown);
        const appOrigin = served.origin.replace('//127.0.0.1:', '//localhost:');

        const sessions = (prefix: string, count: number) =>
          Array.from({ length: count }, (_, index) => ({
            id: `fy_s_bench${prefix}${String(index).padStart(14, '0')}`,
            name: `${prefix === 'st' ? 'Studio' : 'Laptop'} agent ${String(index + 1)}`,
          }));
        const machines: SeededMachine[] = [
          { label: 'studio', environment: studio, sessions: sessions('st', 8), fingerprint: '', pairUrl: '' },
          { label: 'laptop', environment: laptop, sessions: sessions('lp', 7), fingerprint: '', pairUrl: '' },
        ];
        const [studioMachine] = machines as [SeededMachine, SeededMachine];
        const big = studioMachine.sessions[0];
        if (big === undefined) throw new Error('no sessions were planned');
        const started = Date.now();
        for (const machine of machines) {
          await seedMachine(machine, big.id, options.transcriptMb * 1024 * 1024, options.journal);
          await bootMachine(machine, rendezvous, directory.origin, sinkhole.origin, appOrigin);
        }
        progress(`seeded and booted in ${String(Math.round((Date.now() - started) / 1000))} s`);
        report.journalEvents = await journalLength(studio, big.id);
        report.daemonProfile = await profileRoutes(studio, big.id);
        progress(`daemon profile: ${JSON.stringify(report.daemonProfile)}`);
        if (options.profileOnly) return;
        report.seedSeconds = Math.round((Date.now() - started) / 1000);

        const browser = await launchChrome(teardown);
        await (browser.page as unknown as { addInitScript(script: string): Promise<void> }).addInitScript(RECORDER);
        await browser.page.setViewportSize({ width: 1_440, height: 900 });
        for (const machine of machines) await pair(browser, machine);

        progress(`paired; journal at ${String(report.journalEvents)} events`);
        const listUrl = `${appOrigin}/d/${studioMachine.fingerprint}`;
        report.coldOpen = await openList(browser, listUrl, false);
        await browser.page.screenshot({ path: join(tmpdir(), `fy-bench-${options.label}-cold.png`) });
        diagnostics.push(
          `cold text: ${(await browser.page.evaluate<string>('document.body.innerText')).slice(0, 600)}`,
        );
        if (options.quick) {
          if (options.shots !== undefined)
            await evidence(
              browser,
              rendezvous,
              `${appOrigin}/d/${studioMachine.fingerprint}/session/${big.id}`,
              options.shots,
            );
          report.diagnostics = diagnostics;
          report.pageErrors = browser.pageErrors;
          return;
        }
        const warm: OpenSample[] = [];
        for (let sample = 0; sample < options.samples; sample += 1) warm.push(await openList(browser, listUrl, true));
        report.warmOpen = {
          firstRowMs: median(warm.map(sample => sample.firstRowMs)),
          updatingClearedMs: median(warm.map(sample => sample.updatingClearedMs)),
          samples: warm,
        };

        progress(`opens measured`);
        report.switchBig = await switchTo(browser, big.id);
        const idleFrom = await now(browser);
        await Bun.sleep(20_000);
        report.idle20s = traffic(await recorded(browser, idleFrom, idleFrom + 20_000));

        progress(`switch and idle measured`);
        const backFrom = await now(browser);
        await (browser.page as unknown as { goBack(): Promise<unknown> }).goBack();
        const backRows = await until(browser, ROWS_SHOWN);
        const backCleared = await until(browser, `${ROWS_SHOWN} && ${NOT_UPDATING}`);
        await Bun.sleep(5_000);
        report.back = {
          rowsMs: backRows === null ? null : backRows - backFrom,
          updatingClearedMs: backCleared === null ? null : backCleared - backFrom,
          traffic: traffic(await recorded(browser, backFrom, backFrom + 5_000)),
        };

        const second = studioMachine.sessions[1];
        if (second !== undefined) report.switchSmall = await switchTo(browser, second.id);
        await browser.page.goto(`${appOrigin}/d/${studioMachine.fingerprint}/session/${big.id}`, {
          waitUntil: 'commit',
        });
        await until(browser, `${TRANSCRIPT_SHOWN} && ${NOT_UPDATING}`);
        await Bun.sleep(5_000);
        progress(`back and small switch measured`);
        report.blip = await drop(browser, rendezvous, 0);
        await Bun.sleep(3_000);
        report.outage3s = await drop(browser, rendezvous, 3_000);
        if (options.shots !== undefined)
          await evidence(
            browser,
            rendezvous,
            `${appOrigin}/d/${studioMachine.fingerprint}/session/${big.id}`,
            options.shots,
          );
        report.pageErrors = browser.pageErrors;
        report.diagnostics = diagnostics;
      });
    });
  } finally {
    await teardown.closeAll();
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const out = options.out ?? join(tmpdir(), `fy-bench-app-load-${options.label}.json`);
  await writeFile(out, text, 'utf8');
  process.stdout.write(`${text}\nwritten to ${out}\n`);
}

await main();
