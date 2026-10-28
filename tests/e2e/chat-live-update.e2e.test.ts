/**
 * A CHAT KEEPS UP WITH A WORKING AGENT, ON THE DIRECT CARRIER AND ACROSS A RELAY.
 *
 * The owner's report: "after sending, the convo doesn't get reflected immediately", on the tunnel and
 * direct. Measured on a real Claude ferret, the daemon journaled the send, the turn starting and the turn
 * ending at once — but a reply's text blocks, its tool calls and their results are not journal events, so
 * the Chat learned of each only when its poll came round: one to three seconds while the turn read as
 * working, and up to two minutes once a page had relaxed its poll behind a feed it believed was live.
 *
 * So this journey drives exactly that seam: a real Chrome on the session page of a compiled daemon, the
 * session's transcript a real file, and the test appending assistant blocks to it the way an agent does —
 * with no journal event of its own — then measuring, per block, the time from the append to the block
 * being on screen. Each must land within {@link BUDGET_MS}.
 *
 * Run it (the numbers land in `$FY_E2E_CHAT_LATENCY_REPORT`, default `<tmpdir>/fy-e2e-chat-latency.md`):
 *
 *     task compile && CLI_BIN=dist/bin/fy-linux-x64-baseline FY_E2E_REAL_TMUX="$(command -v tmux)" \
 *       bun test tests/e2e/chat-live-update.e2e.test.ts --config=bunfig.e2e.toml --timeout 300000
 *
 * Knobs: `FY_E2E_CHAT_BLOCKS` (blocks measured per carrier, default 6), `FY_E2E_CHAT_BUDGET_MS` (default 1000).
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { withE2eEnvironment } from './fixture.ts';
import { seedRunningSession } from './support/seeded-session.ts';
import {
  attributeNow,
  type BrowserPage,
  buildPwaBundle,
  clickFirstPresent,
  harnessTeardown,
  isLostBrowser,
  launchChrome,
  startDirectSinkhole,
  startPwaOrigin,
  startRelayDirectory,
  startRendezvous,
  waitForDaemonAtRendezvous,
  waitForDaemonFingerprint,
} from './support/relay-harness.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
const REPORT_PATH = process.env.FY_E2E_CHAT_LATENCY_REPORT ?? join(tmpdir(), 'fy-e2e-chat-latency.md');
const BLOCKS = Number(process.env.FY_E2E_CHAT_BLOCKS ?? '6');
const BUDGET_MS = Number(process.env.FY_E2E_CHAT_BUDGET_MS ?? '1000');
const FINGERPRINT = /fy_daemon_[A-Za-z0-9_-]{43}/u;
const PAIRING_LINK = /https?:\/\/\S*#v\d;\S+/u;
const TRANSCRIPT = 'section[aria-label="Transcript"]';
/** This browser's per-machine carrier choice (`lib/carrier-preference.ts`): Auto walks direct first. */
const CARRIER_PREFERENCE_KEY = 'fy-carrier-preference-v2';

type Carrier = 'direct' | 'relay';

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
  await appendFile(REPORT_PATH, `${line}\n`, 'utf8');
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs: number, everyMs = 50): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch((error: unknown) => {
      if (isLostBrowser(error)) throw error;
      return undefined;
    });
    if (value !== undefined) return value;
    await Bun.sleep(everyMs);
  }
  return undefined;
}

/**
 * One Claude transcript record, in the shape the harness writes (`scripts/test/fake-claude-tui.sh`): an
 * assistant's text, or its tool call. The daemon's transcript reader is what decides how it renders.
 */
function claudeRecord(
  harnessSessionId: string,
  index: number,
  parent: string | null,
  content: readonly Record<string, unknown>[],
): { readonly uuid: string; readonly line: string } {
  const uuid = `a${String(index)}-${harnessSessionId}`;
  const role = content.some(block => block.type === 'tool_result') ? 'user' : 'assistant';
  return {
    uuid,
    line: `${JSON.stringify({
      type: role,
      uuid,
      parentUuid: parent,
      sessionId: harnessSessionId,
      timestamp: new Date().toISOString(),
      message: { role, content },
    })}\n`,
  };
}

/** Whether the Chat on screen shows `token` in its transcript. */
async function chatShows(page: BrowserPage, token: string): Promise<boolean> {
  return await page.evaluate<boolean>(
    `(document.querySelector(${JSON.stringify(TRANSCRIPT)})?.textContent ?? '').includes(${JSON.stringify(token)})`,
  );
}

/** Wait for `selector` in the DOM; on a miss, keep a screenshot and what the page said about itself. */
async function expectOnScreen(page: BrowserPage, selector: string, carrier: Carrier): Promise<void> {
  try {
    await page.waitForSelector(selector, { state: 'attached', timeout: 30_000 });
  } catch (error) {
    const shot = join(tmpdir(), `fy-e2e-chat-latency-${carrier}.png`);
    await page.screenshot({ path: shot }).catch(() => undefined);
    const said = await page
      .evaluate<string>(
        `JSON.stringify({ path: location.pathname, carrier: document.querySelector('[data-carrier-kind]')?.getAttribute('data-carrier-kind') ?? null, stream: document.querySelector('[data-live-stream]')?.getAttribute('data-live-stream') ?? null, alert: document.querySelector('[role="alert"]')?.textContent?.slice(0, 200) ?? null })`,
      )
      .catch(() => 'unreadable');
    throw new Error(`${selector} never appeared over ${carrier}: ${said}; screenshot ${shot}`, { cause: error });
  }
}

interface Measured {
  readonly block: string;
  readonly ms: number | null;
}

/**
 * Pair a real Chrome with a compiled daemon, open a working session's Chat over `carrier`, then append
 * {@link BLOCKS} assistant blocks to its transcript and time each one onto the screen.
 */
async function measureChat(carrier: Carrier): Promise<readonly Measured[]> {
  const teardown = harnessTeardown();
  let measured: readonly Measured[] = [];
  try {
    await withE2eEnvironment(async environment => {
      const daemonBin = compiledDaemon();
      if (!(await Bun.file(daemonBin).exists()))
        throw new Error(`no compiled daemon at ${daemonBin} — run \`task compile\``);
      const realTmux = process.env.FY_E2E_REAL_TMUX ?? '';
      if (realTmux === '') throw new Error('FY_E2E_REAL_TMUX is not set');
      const rendezvous = await startRendezvous(environment.paths.root, teardown);
      const directory = await startRelayDirectory();
      directory.publish(rendezvous.relayUrl);
      const sinkhole = await startDirectSinkhole(teardown);
      const distDir = await buildPwaBundle(directory.origin);
      const served = await startPwaOrigin(distDir, teardown);
      const appOrigin = served.origin.replace('//127.0.0.1:', '//localhost:');
      // Over the relay the direct address is a sinkhole, so nothing can quietly go direct.
      const publicUrl = carrier === 'relay' ? sinkhole.origin : environment.httpUrl();
      const configPath = join(environment.paths.root, 'daemon.json');
      await writeFile(configPath, daemonDocument(environment.ports.api, publicUrl, appOrigin), 'utf8');

      // The session's transcript: a real file, with the first exchange already in it.
      const harnessSessionId = crypto.randomUUID();
      const transcriptFile = join(environment.paths.root, 'claude-projects', `${harnessSessionId}.jsonl`);
      await mkdir(dirname(transcriptFile), { recursive: true });
      const opening = claudeRecord(harnessSessionId, 0, null, [{ type: 'text', text: 'Ready when you are.' }]);
      await writeFile(transcriptFile, opening.line, 'utf8');
      const session = await seedRunningSession(environment.paths.fyHome, new Date().toISOString(), {
        transcript: { file: transcriptFile, harnessSessionId },
        turnState: 'working',
      });
      // A running session is a pane the daemon can see: a plain `cat` on the daemon's private tmux socket.
      const tmuxSession = `fy-e2e-chat-${Math.trunc(Math.random() * 1e6).toString(36)}`;
      const configFile = join(environment.paths.fyHome, 'state', 'sessions', session.sessionId, 'config.json');
      const seeded = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
      const cat = Bun.which('cat');
      if (cat === null) throw new Error('no cat on PATH');
      await writeFile(configFile, `${JSON.stringify({ ...seeded, command: [cat], tmuxSession })}\n`, 'utf8');
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
        env: { FY_RELAY_DIRECTORY_ORIGIN: directory.origin },
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

      // Pair, then choose the carrier this run measures before the session page loads.
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
      const preference = carrier === 'direct' ? 'auto' : 'relay';
      await page.evaluate<boolean>(
        `(() => { localStorage.setItem(${JSON.stringify(CARRIER_PREFERENCE_KEY)}, JSON.stringify({ [${JSON.stringify(fingerprint)}]: ${JSON.stringify(preference)} })); return true; })()`,
      );

      await page.goto(`${appOrigin}/d/${fingerprint}/session/${session.sessionId}`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });
      await expectOnScreen(page, `[data-carrier-kind="${carrier}"]`, carrier);
      await expectOnScreen(page, '[data-live-stream="live"]', carrier);
      if (
        (await until(async () => ((await chatShows(page, 'Ready when you are.')) ? true : undefined), 20_000)) !== true
      )
        throw new Error('the Chat never showed the transcript it opened on');
      await note(
        `\n## ${carrier} — carrier=${String(await attributeNow(page, '[data-carrier-kind]', 'data-carrier-kind'))}`,
      );

      // Act — the agent writes: a text block, a tool call, its result, more text. None is a journal event.
      const mark = Math.trunc(Math.random() * 1e9).toString(36);
      const results: Measured[] = [];
      let parent: string = opening.uuid;
      for (let index = 1; index <= BLOCKS; index += 1) {
        // Off the poll's beat: a block written just before a poll would look fast for the wrong reason.
        await Bun.sleep(1_100 + Math.trunc(Math.random() * 900));
        const token = `block-${mark}-${String(index)}`;
        const kind = index % 3;
        const toolId = `toolu_${mark}_${String(index)}`;
        const content =
          kind === 1
            ? [{ type: 'text', text: `Working on it: ${token}` }]
            : kind === 2
              ? [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: `echo ${token}` } }]
              : [{ type: 'text', text: `Done with that step, ${token}.` }];
        const record = claudeRecord(harnessSessionId, index, parent, content);
        parent = record.uuid;
        await appendFile(transcriptFile, record.line, 'utf8');
        const appendedAt = Date.now();
        const shownAt = await until(
          async () => ((await chatShows(page, token)) ? Date.now() : undefined),
          BUDGET_MS * 10,
          20,
        );
        const ms = shownAt === undefined ? null : shownAt - appendedAt;
        results.push({ block: token, ms });
        await note(
          `- block ${String(index)} (${kind === 2 ? 'tool call' : 'text'}): ${ms === null ? 'NEVER SHOWN' : `${String(ms)} ms`}`,
        );
      }
      measured = results;
    });
  } finally {
    await teardown.closeAll();
  }
  return measured;
}

describe('a Chat following a working agent', () => {
  for (const carrier of ['direct', 'relay'] as const)
    it(`should show each block the agent writes within the budget of its append, over ${carrier}`, async () => {
      // Arrange / Act
      if (carrier === 'direct')
        await writeFile(REPORT_PATH, `# chat latency — ${new Date().toISOString()} — budget ${String(BUDGET_MS)} ms\n`);
      const measured = await measureChat(carrier);

      // Assert — every block arrived, each within the budget of the moment it was written.
      const slow = measured.filter(entry => entry.ms === null || entry.ms > BUDGET_MS);
      await note(
        `- ${carrier}: worst ${String(Math.max(...measured.map(entry => entry.ms ?? Number.POSITIVE_INFINITY)))} ms over ${String(measured.length)} blocks`,
      );
      should(measured).have.length(BLOCKS);
      should(slow).deepEqual([]);
    });
});
