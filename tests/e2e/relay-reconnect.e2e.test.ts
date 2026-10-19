/**
 * THE RELAY GOES AWAY MID-SESSION, AND THE PAGE HAS TO COME BACK BY ITSELF.
 *
 * A real Chrome pairs with a compiled daemon over a real rendezvous PROCESS and opens a session page;
 * the rendezvous is then killed and restarted on the same port — what a Worker redeploy does: every
 * socket on both sides drops at once. Nothing is clicked afterwards. The journey MEASURES, per drop:
 *
 *   t(drop) → t(daemon re-claimed the rendezvous) → t(Chrome shows the daemon's next event)
 *
 * and asserts the recovery time stays under a threshold, that a message sent through the composer
 * before and after lands exactly once in the daemon's send ledger, and that a message in flight while
 * the relay dies is delivered at most once (reported as not sent, or delivered — never twice).
 *
 * Run it (the numbers land in `$FY_E2E_RECONNECT_REPORT`, default `<tmpdir>/fy-e2e-relay-reconnect.md`):
 *
 *     task compile && CLI_BIN=dist/bin/fy-linux-x64-baseline FY_E2E_REAL_TMUX="$(command -v tmux)" \
 *       bun test tests/e2e/relay-reconnect.e2e.test.ts --config=bunfig.e2e.toml --timeout 400000
 *
 * Knobs: `FY_E2E_RECONNECT_RUNS` (drops measured, default 3), `FY_E2E_RECONNECT_BUDGET_MS` (default 10000).
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture.ts';
import { seedRunningSession } from './support/seeded-session.ts';
import {
  attributeNow,
  type BrowserPage,
  buildPwaBundle,
  clickFirstPresent,
  harnessTeardown,
  launchChrome,
  type RendezvousProcess,
  startDirectSinkhole,
  startPwaOrigin,
  startRelayDirectory,
  startRendezvous,
  waitForDaemonAtRendezvous,
  waitForDaemonFingerprint,
} from './support/relay-harness.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
const REPORT_PATH = process.env.FY_E2E_RECONNECT_REPORT ?? join(tmpdir(), 'fy-e2e-relay-reconnect.md');
const RUNS = Number(process.env.FY_E2E_RECONNECT_RUNS ?? '3');
const BUDGET_MS = Number(process.env.FY_E2E_RECONNECT_BUDGET_MS ?? '10000');
const FINGERPRINT = /fy_daemon_[A-Za-z0-9_-]{43}/u;
const PAIRING_LINK = /https?:\/\/\S*#v\d;\S+/u;
const FIELD = '.fy-composer [role="textbox"], .fy-composer textarea';
const SEND = '[data-composer-send]';

function compiledDaemon(): string {
  const explicit = process.env.FYD_BIN;
  if (explicit !== undefined && explicit !== '') return resolve(REPOSITORY_ROOT, explicit);
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
  return join(REPOSITORY_ROOT, 'dist', 'bin', `fyd-${platform}-${architecture}`);
}

function daemonDocument(bindPort: number, publicUrl: string, appOrigin: string): string {
  return `${JSON.stringify({ publicUrl, corsOrigins: [appOrigin], carriers: [{ kind: 'bind', host: '127.0.0.1', port: bindPort }] }, null, 2)}\n`;
}

async function note(line: string): Promise<void> {
  await appendFile(currentReport, `${line}\n`, 'utf8');
}

async function adminToken(environment: E2eEnvironment): Promise<string> {
  return (await readFile(join(environment.paths.fyHome, 'api-token'), 'utf8')).trim();
}

/**
 * An out-of-band event: a send over loopback with the host token, which appends `control.send_accepted` to the
 * session's journal whatever the browser is doing. (A signal cannot be used: the first composer send revives the
 * seeded session, which a bare `cat` pane cannot satisfy, and a failed session refuses `waiting`.)
 */
async function probe(environment: E2eEnvironment, sessionId: string, message: string): Promise<void> {
  const response = await fetch(environment.httpUrl(`/v1/sessions/${sessionId}/send`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await adminToken(environment)}`,
      'Content-Type': 'application/json',
      'x-fy-request-id': crypto.randomUUID(),
    },
    body: JSON.stringify({ message }),
  });
  // Refusal is tolerated: what matters is whether the journal grew, which the caller reads back.
  await response.text();
}

async function lastSequence(environment: E2eEnvironment, sessionId: string): Promise<number> {
  const response = await fetch(environment.httpUrl(`/v1/sessions/${sessionId}/events?after=0&limit=1000`), {
    headers: { Authorization: `Bearer ${await adminToken(environment)}` },
  });
  const events = (await response.json()) as readonly { readonly sequence: number }[];
  return events.at(-1)?.sequence ?? 0;
}

/** The daemon's send ledger: how many rows carry exactly this message. The authority on loss and duplication. */
async function sendsOf(environment: E2eEnvironment, sessionId: string, message: string): Promise<number> {
  const response = await fetch(environment.httpUrl(`/v1/sessions/${sessionId}/sends`), {
    headers: { Authorization: `Bearer ${await adminToken(environment)}` },
  });
  if (!response.ok) throw new Error(`send ledger refused with ${String(response.status)}`);
  const body = (await response.json()) as { readonly sends: readonly { readonly message: string }[] };
  return body.sends.filter(row => row.message === message).length;
}

/** Every ledger row, compact, for the report when a count is not what it should be. */
async function ledgerDump(environment: E2eEnvironment, sessionId: string): Promise<string> {
  const response = await fetch(environment.httpUrl(`/v1/sessions/${sessionId}/sends`), {
    headers: { Authorization: `Bearer ${await adminToken(environment)}` },
  });
  const body = (await response.json()) as {
    readonly sends: readonly {
      readonly message: string;
      readonly path: string;
      readonly fate: string;
      readonly withdrawn?: boolean;
    }[];
  };
  return body.sends
    .map(row => `${row.message.slice(0, 22)}[${row.path}/${row.fate}${row.withdrawn === true ? '/withdrawn' : ''}]`)
    .join(' ');
}

interface Glass {
  readonly events: number;
  readonly stream: string | null;
  readonly carrier: string | null;
  readonly health: string | null;
  readonly alert: string | null;
}

async function glass(page: BrowserPage): Promise<Glass> {
  return page.evaluate<Glass>(`(() => {
    const read = (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? null;
    return {
      events: Number(read('[data-live-events]', 'data-live-events')),
      stream: read('[data-live-stream]', 'data-live-stream'),
      carrier: read('[data-carrier-kind]', 'data-carrier-kind'),
      health: read('[data-connection]', 'data-connection'),
      alert: document.querySelector('.fy-composer [role="alert"]')?.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 160) ?? null,
    };
  })()`);
}

interface ComposerState {
  readonly alert: string | null;
  readonly draft: string;
  readonly sendEnabled: boolean;
  readonly stepUpOpen: boolean;
}

async function composerState(page: BrowserPage): Promise<ComposerState> {
  return page.evaluate<ComposerState>(`(() => {
    const field = document.querySelector(${JSON.stringify(FIELD)});
    const send = document.querySelector(${JSON.stringify(SEND)});
    return {
      alert: document.querySelector('.fy-composer [role="alert"]')?.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 160) ?? null,
      draft: (field?.value ?? field?.textContent ?? '').trim(),
      sendEnabled: send !== null && !send.disabled,
      stepUpOpen: document.querySelector('[data-step-up-dialog]') !== null,
    };
  })()`);
}

/** Empty the box, so a failed earlier send's draft cannot be glued onto this message. */
async function clearComposer(page: BrowserPage): Promise<void> {
  await page.focus(FIELD, { timeout: 20_000 });
  await page.evaluate<boolean>(
    `(() => { const f = document.querySelector(${JSON.stringify(FIELD)}); f.focus(); if ('value' in f) { f.select(); } else { document.execCommand('selectAll'); } document.execCommand('delete'); return true; })()`,
  );
}

/** Type a message and confirm the box holds exactly it: a keystroke lost to a re-render once sent `reco` for `reconnect-A-…`. */
async function typeExactly(page: BrowserPage, message: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await clearComposer(page);
    await page.keyboard.type(message);
    if ((await composerState(page)).draft === message) return;
  }
  throw new Error(`the composer would not hold ${message}`);
}

interface SendOutcome {
  readonly rows: number;
  readonly state: ComposerState;
}

/** Type a message into the composer and press Send; answer how many ledger rows it ended up with. */
async function sendViaComposer(
  page: BrowserPage,
  environment: E2eEnvironment,
  sessionId: string,
  message: string,
): Promise<SendOutcome> {
  await typeExactly(page, message);
  await page.waitForSelector(`${SEND}:not([disabled])`, { timeout: 10_000 }).catch(() => undefined);
  const before = await composerState(page);
  if (before.sendEnabled) await page.click(SEND, { timeout: 10_000 });
  await until(async () => ((await sendsOf(environment, sessionId, message)) >= 1 ? true : undefined), 15_000);
  const rows = await sendsOf(environment, sessionId, message);
  await settleComposer(page);
  return { rows, state: await composerState(page) };
}

/** Wait for a send to be resolved on the glass: the box emptied (it went) or an error shown (it did not). */
async function settleComposer(page: BrowserPage): Promise<void> {
  await until(async () => {
    const state = await composerState(page);
    return state.draft === '' || state.alert !== null ? true : undefined;
  }, 20_000);
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  return undefined;
}

interface Drop {
  readonly run: number;
  readonly daemonBackMs: number | null;
  readonly eventShownMs: number | null;
  readonly healthSeen: readonly string[];
  readonly streamSeen: readonly string[];
  readonly alertSeen: string | null;
}

/** Kill the rendezvous, then measure — with nothing clicked — until Chrome shows an event appended after the drop. */
async function dropAndMeasure(
  environment: E2eEnvironment,
  rendezvous: RendezvousProcess,
  page: BrowserPage,
  sessionId: string,
  run: number,
  kind: 'waiting' | 'working',
): Promise<Drop> {
  const before = await glass(page);
  const dropped = await rendezvous.restart();
  const tDrop = dropped.droppedAt;
  const healthSeen = new Set<string>();
  const streamSeen = new Set<string>();
  let alertSeen: string | null = null;
  let finished = false;
  let lastHealth = '';
  let lastStream = '';

  const watch = (async () => {
    // Sampled for the whole window so a transient "reconnecting" is on the record even if it clears.
    const stopAt = Date.now() + 45_000;
    while (!finished && Date.now() < stopAt) {
      const now = await glass(page).catch(() => undefined);
      if (now !== undefined) {
        if (now.health !== null && now.health !== lastHealth) {
          lastHealth = now.health;
          healthSeen.add(`${String(Date.now() - tDrop)}ms:${now.health}`);
        }
        if (now.stream !== null && now.stream !== lastStream) {
          lastStream = now.stream;
          streamSeen.add(`${String(Date.now() - tDrop)}ms:${now.stream}`);
        }
        if (now.alert !== null) alertSeen ??= now.alert;
      }
      await Bun.sleep(100);
    }
  })();

  const daemonBackAt = await until(async () => {
    const rows = await rendezvous.sockets();
    return rows.some(row => row.roles.includes('daemon')) ? Date.now() : undefined;
  }, 45_000);

  // The event is appended once the daemon is back on the relay; it is durable, so a page that comes back
  // later must still be handed it (resume from its cursor). The signal itself goes over loopback.
  const sequenceBefore = await lastSequence(environment, sessionId);
  await probe(environment, sessionId, `reconnect-probe-${String(run)}-${String(kind)}`);
  const target = await lastSequence(environment, sessionId);
  if (target <= sequenceBefore)
    await note(
      `  - WARNING: the probe appended no journal event (sequence stayed ${String(target)}); the recovery time below is not an event measurement`,
    );
  const shownAt = await until(async () => {
    const now = await glass(page);
    return Number.isSafeInteger(now.events) && now.events >= target ? Date.now() : undefined;
  }, 45_000);
  finished = true;
  await watch;
  if (daemonBackAt === undefined) {
    const evidence = `${currentReport}.daemon-never-returned-drop-${String(run)}.log`;
    const arrivals = await rendezvous.arrivals().catch(() => []);
    const frames = await rendezvous.observations().catch(() => []);
    const textFrames = frames
      .filter(frame => frame.kind === 'text')
      .slice(-40)
      .map(
        frame =>
          `${String(frame.at)} ${frame.direction} ${frame.role}: ${Buffer.from(frame.base64, 'base64').toString('utf8').slice(0, 200)}`,
      );
    const rows = JSON.stringify(await rendezvous.sockets().catch((error: unknown) => String(error)));
    await writeFile(
      evidence,
      `${environment.daemonOutput().err}\n--- sockets now: ${rows}\n--- rendezvous closes by role/code/reason: ${closeSummary(rendezvous.stderr())}\n--- rendezvous stderr tail:\n${rendezvous.stderr().slice(-600)}\n--- last text frames:\n${textFrames.join('\n')}\n--- rendezvous arrivals (${String(arrivals.length)}): ${JSON.stringify(arrivals.map(entry => entry.role))}\n`,
      'utf8',
    );
    await note(
      `  - THE DAEMON NEVER RE-CLAIMED THE RENDEZVOUS within 45 s; its stderr is in ${evidence}; the rendezvous saw ${String(arrivals.filter(entry => entry.role === 'daemon').length)} daemon dial(s) in total`,
    );
  }
  void before;
  return {
    run,
    daemonBackMs: daemonBackAt === undefined ? null : daemonBackAt - tDrop,
    eventShownMs: shownAt === undefined ? null : shownAt - tDrop,
    healthSeen: [...healthSeen],
    streamSeen: [...streamSeen],
    alertSeen,
  };
}

let currentReport = REPORT_PATH;

/** The renderer processes of the Chrome THIS test process launched: its descendants whose command line says `--type=renderer`. */
function ownRendererPids(): number[] {
  const listing = Bun.spawnSync(['ps', '-eo', 'pid=,ppid=,args=']).stdout.toString().split('\n');
  const rows = listing.flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] ?? '' }];
  });
  const owned = new Set<number>(rows.filter(row => row.ppid === process.pid).map(row => row.pid));
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (!owned.has(row.pid) && owned.has(row.ppid)) {
        owned.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter(row => owned.has(row.pid) && row.args.includes('--type=renderer')).map(row => row.pid);
}

/** "role code reason ×count" for every application-level close the rendezvous logged. */
function closeSummary(stderr: string): string {
  const counts = new Map<string, number>();
  for (const line of stderr.split('\n')) {
    const match = /^rendezvous close (role=\S+ code=\d+ reason=.*)$/u.exec(line);
    if (match?.[1] !== undefined) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => `${key} ×${String(count)}`).join('; ') || 'none';
}

interface Journey {
  readonly environment: E2eEnvironment;
  readonly teardown: ReturnType<typeof harnessTeardown>;
  readonly rendezvous: RendezvousProcess;
  readonly browser: Awaited<ReturnType<typeof launchChrome>>;
  readonly page: BrowserPage;
  readonly session: { readonly sessionId: string };
  readonly fingerprint: string;
  readonly mark: string;
}

/** Boot every moving part, pair a real Chrome over the relay, open the session page, then run `body`. */
async function withJourney(label: string, body: (journey: Journey) => Promise<void>): Promise<void> {
  currentReport = label === 'restart' ? REPORT_PATH : REPORT_PATH.replace(/\.md$/u, `-${label}.md`);
  await writeFile(currentReport, `# relay reconnect (${label}) — ${new Date().toISOString()}\n\n`, 'utf8');
  const teardown = harnessTeardown();
  let journeyError: unknown;
  try {
    await withE2eEnvironment(async environment => {
      const daemonBin = compiledDaemon();
      if (!(await Bun.file(daemonBin).exists()))
        throw new Error(`no compiled daemon at ${daemonBin} — run \`task compile\``);
      const rendezvous = await startRendezvous(environment.paths.root, teardown);
      const directory = await startRelayDirectory();
      directory.publish(rendezvous.relayUrl);
      const sinkhole = await startDirectSinkhole(teardown);
      const distDir = await buildPwaBundle(directory.origin);
      const served = await startPwaOrigin(distDir, teardown);
      const appOrigin = served.origin.replace('//127.0.0.1:', '//localhost:');
      const configPath = join(environment.paths.root, 'daemon.json');
      await writeFile(configPath, daemonDocument(environment.ports.api, sinkhole.origin, appOrigin), 'utf8');
      const session = await seedRunningSession(environment.paths.fyHome);
      // The seeded session is two documents with no pane behind it, and a send needs both a lifecycle-shaped
      // config (absolute `command`, a `tmuxSession`) and a pane to type into — a plain `cat` is enough, since
      // the ledger's acceptance of the message is what this journey audits, not the agent's reply.
      const tmuxSession = `fy-e2e-reconnect-${Math.trunc(Math.random() * 1e6).toString(36)}`;
      const configFile = join(environment.paths.fyHome, 'state', 'sessions', session.sessionId, 'config.json');
      const seeded = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
      const cat = Bun.which('cat');
      if (cat === null) throw new Error('no cat on PATH');
      await writeFile(configFile, `${JSON.stringify({ ...seeded, command: [cat], tmuxSession })}\n`, 'utf8');
      // The daemon drives tmux over its own private socket (`<FY_HOME>/tmux.sock`, with `-S`), which the
      // fixture's scoped-tmux shim on PATH forbids. So the daemon is launched with the REAL tmux first on its PATH
      // (see `daemonCommand`), and the pane is made on that same private socket.
      const realTmux = process.env.FY_E2E_REAL_TMUX ?? '';
      if (realTmux === '') throw new Error('FY_E2E_REAL_TMUX is not set');
      const privateSocket = join(environment.paths.fyHome, 'tmux.sock');
      const pane = Bun.spawnSync([
        realTmux,
        '-S',
        privateSocket,
        'new-session',
        '-d',
        '-s',
        tmuxSession,
        '-x',
        '120',
        '-y',
        '30',
        cat,
      ]);
      if (pane.exitCode !== 0) throw new Error(`could not open the session pane: ${pane.stderr.toString()}`);
      teardown.add('session tmux server', () => {
        Bun.spawnSync([realTmux, '-S', privateSocket, 'kill-server']);
      });
      const daemonEnv = { FY_RELAY_DIRECTORY_ORIGIN: directory.origin };
      const daemonCommand = {
        command: [
          '/usr/bin/env',
          `PATH=${dirname(realTmux)}:${process.env.PATH ?? ''}`,
          daemonBin,
          '--config',
          configPath,
        ] as const,
        readyUrl: environment.httpUrl('/v1/health'),
        timeoutMs: 30_000,
        env: daemonEnv,
      };

      // First boot mints the fingerprint the self-hosted rendezvous must be told to admit.
      const seen = await rendezvous.dialled();
      await environment.startDaemon(daemonCommand);
      const fingerprint = await waitForDaemonFingerprint(rendezvous, seen);
      await environment.stopDaemon();
      if (!FINGERPRINT.test(fingerprint)) throw new Error(`malformed fingerprint ${fingerprint}`);
      await rendezvous.allow(fingerprint);
      await environment.startDaemon(daemonCommand);
      await waitForDaemonAtRendezvous(rendezvous);

      // Pair over the relay (direct is a sinkhole).
      const minted = await environment.runFy(['pair', '--no-wait'], { FY_URL: environment.httpUrl() });
      const link = PAIRING_LINK.exec(`${minted.out}\n${minted.err}`)?.[0];
      if (link === undefined) throw new Error(`fy pair printed no link: ${minted.err.trim()}`);
      const browser = await launchChrome(teardown);
      const page = browser.page;
      await page.goto(`${appOrigin}/pair#${link.slice(link.indexOf('#') + 1)}`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });
      await page.waitForSelector('[data-pairing-stage="confirm"]', { timeout: 20_000 });
      if ((await clickFirstPresent(page, ['[data-pair-confirm]'])) === null) throw new Error('no confirm control');
      await Promise.race([
        page.waitForSelector('[data-pairing-stage="paired"]', { timeout: 45_000 }),
        page.waitForSelector('[data-pairing-stage]', { state: 'detached', timeout: 45_000 }),
      ]);

      // A send is a step-up act on this unlock-off home: give the browser a real (virtual) passkey and answer
      // each prompt in the background, exactly as the relay browser journey does.
      const token = await adminToken(environment);
      const listed = (await (
        await fetch(environment.httpUrl('/v1/pair/devices'), { headers: { Authorization: `Bearer ${token}` } })
      ).json()) as {
        readonly devices?: readonly { readonly name?: string }[];
      };
      const deviceName = listed.devices?.map(device => device.name ?? '').find(name => /^Chrome on Linux/u.test(name));
      if (deviceName === undefined) throw new Error('the daemon lists no paired Chrome device');
      const devtools = await browser.cdp();
      await devtools.send('WebAuthn.enable', { enableUI: false });
      await devtools.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      const window = await environment.runFy(['passkey', 'window', deviceName], { FY_URL: environment.httpUrl() });
      if (window.code !== 0) throw new Error(`fy passkey window refused: ${window.err.trim() || window.out.trim()}`);
      await page.goto(`${appOrigin}/d/${fingerprint}/settings#security`, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.click('[data-step-up-dialog] button:has-text("Cancel")', { timeout: 5_000 }).catch(() => undefined);
      await page.click('[data-security-card] [data-security-add]', { timeout: 20_000 });
      await page.waitForSelector('[data-security-card] [data-security-passkey]', { timeout: 30_000 });
      let answering = true;
      const answerer = (async () => {
        const confirm = '[data-step-up-dialog] [data-step-up-confirm]';
        while (answering) {
          const asked = await page
            .evaluate<boolean>(`document.querySelector(${JSON.stringify(confirm)}) !== null`)
            .catch(() => false);
          if (asked) await page.click(confirm, { timeout: 5_000 }).catch(() => undefined);
          await Bun.sleep(150);
        }
      })();
      teardown.add('step-up answerer', async () => {
        answering = false;
        await answerer;
      });

      // Act: the session page, over the relay.
      await page.goto(`${appOrigin}/d/${fingerprint}/session/${session.sessionId}`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });
      await page.waitForSelector('[data-carrier-kind="relay"]', { timeout: 30_000 });
      await page.waitForSelector('[data-live-events]', { timeout: 30_000 });
      await note(
        `- paired over the relay, session page open, carrier=${String(await attributeNow(page, '[data-carrier-kind]', 'data-carrier-kind'))}`,
      );
      const mark = Math.trunc(Math.random() * 1e9).toString(36);
      await body({ environment, teardown, rendezvous, browser, page, session, fingerprint, mark });
    });
  } catch (error) {
    journeyError = error;
  } finally {
    await teardown.closeAll().catch((error: unknown) => {
      journeyError ??= error;
    });
  }
  if (journeyError !== undefined) {
    const written = await readFile(currentReport, 'utf8').catch(() => '');
    throw new Error(`${(journeyError as Error).message}\n\n--- report (${currentReport}) ---\n${written}`, {
      cause: journeyError,
    });
  }
}

const IDLE_MINUTES = Number(process.env.FY_E2E_IDLE_MINUTES ?? '3');
const FREEZE_SECONDS = Number(process.env.FY_E2E_FREEZE_SECONDS ?? '75');

describe('a relayed session page that loses its connection', () => {
  it(
    'should bring the page back unaided with no lost or duplicated send when the relay restarts [slow]',
    () =>
      withJourney('restart', async ({ environment, rendezvous, page, session, mark }) => {
        const messageA = `reconnect-A-${mark}`;
        const a = await sendViaComposer(page, environment, session.sessionId, messageA);
        await note(
          `- message A before any drop: ledger rows=${String(a.rows)}; composer: ${JSON.stringify(a.state)}; ledger: ${await ledgerDump(environment, session.sessionId)}`,
        );

        const drops: Drop[] = [];
        const sent: string[] = [messageA];
        for (let run = 1; run <= RUNS; run += 1) {
          const drop = await dropAndMeasure(
            environment,
            rendezvous,
            page,
            session.sessionId,
            run,
            run % 2 === 1 ? 'waiting' : 'working',
          );
          drops.push(drop);
          await note(`  - rendezvous closes so far: ${closeSummary(rendezvous.stderr())}`);
          await note(
            `- drop ${String(run)}: daemon re-claimed rendezvous after ${String(drop.daemonBackMs)} ms; Chrome showed the next event after ${String(drop.eventShownMs)} ms; ` +
              `data-connection-health: ${drop.healthSeen.join(' ') || 'absent'}; data-live-stream: ${drop.streamSeen.join(' ') || 'absent'}; composer alert: ${String(drop.alertSeen)}`,
          );
          const message = `reconnect-B${String(run)}-${mark}`;
          sent.push(message);
          const b = await sendViaComposer(page, environment, session.sessionId, message);
          await note(
            `  - message ${message} sent after recovery: ledger rows=${String(b.rows)}; composer: ${JSON.stringify(b.state)}`,
          );
        }

        // In flight: fire the send and kill the relay a few ms later, at offsets that straddle the request.
        const inflight: {
          readonly message: string;
          readonly offsetMs: number;
          readonly rows: number;
          readonly alert: string | null;
          readonly draft: string;
        }[] = [];
        for (const offsetMs of [0, 8, 25]) {
          const message = `reconnect-C${String(offsetMs)}-${mark}`;
          await typeExactly(page, message);
          await page.waitForSelector(`${SEND}:not([disabled])`, { timeout: 10_000 }).catch(() => undefined);
          const clicked = page.evaluate<boolean>(
            `(() => { document.querySelector(${JSON.stringify(SEND)}).click(); return true; })()`,
          );
          await Bun.sleep(offsetMs);
          await Promise.all([clicked.catch(() => undefined), rendezvous.restart()]);
          await until(
            async () => ((await rendezvous.sockets()).some(row => row.roles.includes('daemon')) ? true : undefined),
            45_000,
          );
          // Time for the page to recover and for anything it retries to land.
          await Bun.sleep(BUDGET_MS + 2_000);
          const now = await composerState(page);
          const rows = await sendsOf(environment, session.sessionId, message);
          inflight.push({ message, offsetMs, rows, alert: now.alert, draft: now.draft });
          await note(
            `- in-flight send, relay killed ${String(offsetMs)} ms after the click: ledger rows=${String(rows)}; composer: ${JSON.stringify(now)}`,
          );
          sent.push(message);
        }

        // Assert: the numbers were written first, so a failure still leaves the evidence.
        const slow = drops.filter(drop => drop.eventShownMs === null || drop.eventShownMs > BUDGET_MS);
        await note(
          `\n## summary\n- budget ${String(BUDGET_MS)} ms; recovery times (ms): ${drops.map(drop => String(drop.eventShownMs)).join(', ')}`,
        );
        should(slow.map(drop => `drop ${String(drop.run)}: ${String(drop.eventShownMs)} ms`)).deepEqual([]);
        for (const message of sent.filter(candidate => !candidate.includes('-C'))) {
          should(await sendsOf(environment, session.sessionId, message)).equal(1);
        }
        for (const entry of inflight) {
          should(entry.rows <= 1).equal(true);
          // Not delivered must be visible: an error, or the draft still in the box to resend.
          if (entry.rows === 0) should(entry.alert !== null || entry.draft !== '').equal(true);
        }
      }),
    900_000,
  );

  it(
    'should have the daemon re-claim a restarted rendezvous with no browser connected',
    () =>
      withJourney('daemon-only', async ({ rendezvous, page }) => {
        await page.goto('about:blank');
        await Bun.sleep(3_000);
        const times: (number | null)[] = [];
        for (let run = 1; run <= 6; run += 1) {
          const dropped = await rendezvous.restart();
          const back = await until(
            async () =>
              (await rendezvous.sockets()).some(row => row.roles.includes('daemon')) ? Date.now() : undefined,
            60_000,
          );
          times.push(back === undefined ? null : back - dropped.droppedAt);
          await note(
            `- drop ${String(run)} (no browser): daemon re-claimed after ${String(times.at(-1))} ms; closes so far: ${closeSummary(rendezvous.stderr())}`,
          );
          await Bun.sleep(2_000);
        }
        await note(`\n## summary\n- re-claim times with no browser (ms): ${times.map(String).join(', ')}`);
        should(times.filter(time => time === null || time > BUDGET_MS)).deepEqual([]);
      }),
    600_000,
  );

  it(
    'should stay connected and send cleanly after sitting idle [slow]',
    () =>
      withJourney('idle', async ({ environment, rendezvous, page, session, fingerprint, mark }) => {
        const dials = async () => {
          const arrivals = await rendezvous.arrivals();
          return {
            daemon: arrivals.filter(entry => entry.role === 'daemon').length,
            client: arrivals.filter(entry => entry.role === 'client' && entry.daemonId === fingerprint).length,
          };
        };
        const openedAt = Date.now();
        const liveAfter = await until(
          async () => ((await glass(page)).stream === 'live' ? Date.now() - openedAt : undefined),
          150_000,
        );
        await note(
          `- the page reached data-live-stream=live ${liveAfter === undefined ? 'NEVER (150 s)' : `${String(liveAfter)} ms after the page was open`}`,
        );
        const before = await dials();
        const transitions: string[] = [];
        let last = '';
        const startedAt = Date.now();
        const stopAt = startedAt + IDLE_MINUTES * 60_000;
        while (Date.now() < stopAt) {
          const now = await glass(page).catch(() => undefined);
          if (now !== undefined) {
            const key = `stream=${String(now.stream)} health=${String(now.health)} carrier=${String(now.carrier)} alert=${String(now.alert)}`;
            if (key !== last) {
              last = key;
              transitions.push(`${String(Math.round((Date.now() - startedAt) / 1000))}s ${key}`);
            }
          }
          await Bun.sleep(2_000);
        }
        const after = await dials();
        await note(
          `- idle for ${String(IDLE_MINUTES)} min with no traffic; glass transitions: ${transitions.join(' | ')}`,
        );
        await note(
          `- relay dials during the idle window: daemon ${String(after.daemon - before.daemon)}, client sessions ${String(after.client - before.client)}`,
        );
        const message = `idle-${mark}`;
        const sent = await sendViaComposer(page, environment, session.sessionId, message);
        await note(`- send after the idle: ledger rows=${String(sent.rows)}; composer: ${JSON.stringify(sent.state)}`);
        const now = await glass(page);
        await note(
          `- glass after the send: ${JSON.stringify(now)}\n\n## summary\n- idle ${String(IDLE_MINUTES)} min; reconnect-ish transitions: ${String(transitions.length - 1)}; send rows=${String(sent.rows)}`,
        );
        should(sent.rows).equal(1);
        should(sent.state.alert).equal(null);
        should(transitions.length).equal(1);
      }),
    (IDLE_MINUTES + 6) * 60_000,
  );

  it(
    'should recover unaided after the page was frozen past the relay eviction grace [slow]',
    () =>
      withJourney('frozen', async ({ environment, teardown, rendezvous, page, session, mark }) => {
        const frozenAt = Date.now();
        // A CDP lifecycle freeze left every socket open and answering in headless Chrome (measured), which is not a
        // backgrounded phone. SIGSTOP on the renderer is: its timers, pings and sockets all stop, as under an OS suspend.
        const liveBefore = await until(
          async () => ((await glass(page)).stream === 'live' ? Date.now() : undefined),
          90_000,
        );
        await note(
          `- live before the freeze: ${String(liveBefore !== undefined)}; glass ${JSON.stringify(await glass(page))}`,
        );
        const renderers = ownRendererPids();
        if (renderers.length === 0) throw new Error('no renderer process to suspend');
        for (const pid of renderers) process.kill(pid, 'SIGSTOP');
        teardown.add('resume renderers', () => {
          for (const pid of renderers) {
            try {
              process.kill(pid, 'SIGCONT');
            } catch {
              // already gone
            }
          }
        });
        await Bun.sleep(FREEZE_SECONDS * 1000);
        const held = await rendezvous.sockets().catch(() => []);
        await note(
          `- page frozen for ${String(FREEZE_SECONDS)} s; rendezvous holds roles: ${JSON.stringify(held.map(row => row.roles))} (a phone backgrounded past the 45 s grace)`,
        );
        const sequenceBefore = await lastSequence(environment, session.sessionId);
        await probe(environment, session.sessionId, `frozen-probe-${mark}`);
        const target = await lastSequence(environment, session.sessionId);
        if (target <= sequenceBefore) await note('  - WARNING: the probe appended no journal event');
        const activeAt = Date.now();
        for (const pid of renderers) process.kill(pid, 'SIGCONT');
        await page.evaluate<boolean>(
          "(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); return true; })()",
        );
        let done = false;
        const seen = new Set<string>();
        let lastKey = '';
        const watch = (async () => {
          const stopAt = Date.now() + 60_000;
          while (!done && Date.now() < stopAt) {
            const now = await glass(page).catch(() => undefined);
            if (now !== undefined) {
              const key = `stream=${String(now.stream)} health=${String(now.health)} carrier=${String(now.carrier)}`;
              if (key !== lastKey) {
                lastKey = key;
                seen.add(`${String(Date.now() - activeAt)}ms ${key}`);
              }
            }
            await Bun.sleep(100);
          }
        })();
        const liveAt = await until(
          async () => ((await glass(page)).stream === 'live' ? Date.now() : undefined),
          60_000,
        );
        const shownAt = await until(async () => {
          const now = await glass(page);
          return Number.isSafeInteger(now.events) && now.events >= target ? Date.now() : undefined;
        }, 60_000);
        done = true;
        await watch;
        await note(
          `- after unfreeze: live again ${liveAt === undefined ? 'NEVER (60 s)' : String(liveAt - activeAt)} ms, the event appended during the freeze shown ${shownAt === undefined ? 'NEVER (60 s)' : String(shownAt - activeAt)} ms; glass: ${[...seen].join(' | ')}`,
        );
        const recovered = await sendViaComposer(page, environment, session.sessionId, `frozen-after-${mark}`);
        await note(
          `- send after recovery: ledger rows=${String(recovered.rows)}; composer: ${JSON.stringify(recovered.state)}\n\n## summary\n- freeze ${String(FREEZE_SECONDS)} s (${String((activeAt - frozenAt) / 1000)} s wall); recovery (ms): live ${String(liveAt === undefined ? null : liveAt - activeAt)}, event ${String(shownAt === undefined ? null : shownAt - activeAt)}; budget ${String(BUDGET_MS)}`,
        );
        should(shownAt === undefined ? Number.POSITIVE_INFINITY : shownAt - activeAt <= BUDGET_MS).equal(true);
        should(recovered.rows).equal(1);
      }),
    (FREEZE_SECONDS + 10) * 1000 + 300_000,
  );
});
