import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import type { BrowserMode, BrowserProxyStatus } from '@ferretry/protocol';
import {
  agentBrowserArguments,
  honestChromeUserAgent,
  BrowserControlError,
  type BrowserProfilePort,
  browserEnvironment,
  selectChromeExecutable,
} from '../../../lib/browser/control/index.ts';
import { browserProxyStatus, proxyEndpoint, type ResolvedBrowserProxy } from '../../../lib/browser/proxy/index.ts';
import type { BrowserSessionLauncher, BrowserWorkerProgram } from '../../../lib/browser/runtime/index.ts';
import type { BrowserAutomation } from '../../../lib/browser/transport/index.ts';
import type { BrowserDisplayPort } from '../control/login-runtime.ts';
import { ProxySignInRelay } from '../proxy/sign-in-relay.ts';
import { BrowserWorkerClient, type WorkerClientOptions } from '../transport/worker-client.ts';

/** Launches the machine's ONE agent Chrome — in the machine's Browser mode (headless by default; a real
 * window when the owner asked for one), over the dedicated agent profile, shared by every session — and the
 * worker that drives it. The profile lease is held until both
 * Chrome and the worker are gone, so a login window can never open over a live automation browser —
 * and a lease kept because cleanup could not be confirmed closes the profile to EVERY later launch,
 * this same session's retry included; only confirmed cleanup or dead-owner recovery frees it. */
/** Who holds the agent profile's lease: the machine's agent browser, not any one session. */
const AGENT_BROWSER_HOLDER = 'agent-browser';

/**
 * How the launcher learns the machine's Browser mode, and where a Linux real window draws.
 *
 * The mode is READ AT EVERY LAUNCH, never cached: an owner who switches it gets it the next time the browser
 * starts, with no daemon restart. The display is the launcher's OWN private X server — never `$DISPLAY`,
 * which on a desktop host is the operator's real session — and the composition root closes it at shutdown.
 */
export interface SessionBrowserModeOptions {
  /** This machine's Browser mode right now. Absent means headless, which is what every daemon ran before. */
  readonly mode?: () => Promise<BrowserMode>;
  /** The private display a Linux `window` browser draws into. */
  readonly display?: BrowserDisplayPort;
  /**
   * The proxy the shared browser goes through, read at every launch like the mode. Unlike the mode, a proxy
   * that cannot be resolved REFUSES the launch: starting without it would send traffic its owner asked to route
   * elsewhere straight out of this machine. `undefined` means no proxy.
   */
  readonly proxy?: () => Promise<ResolvedBrowserProxy | undefined>;
  readonly platform?: NodeJS.Platform;
  /** The daemon-owned directory the worker stages downloads and PDFs in (the file tools read them from here). */
  readonly stageDirectory?: string;
  /** How long a signalled Chrome gets to exit before the next, harder step. Defaults to the shipped bound. */
  readonly shutdownTimeoutMs?: number;
}

export class NodeSessionBrowserLauncher implements BrowserSessionLauncher {
  constructor(
    private readonly profile: BrowserProfilePort,
    private readonly worker: BrowserWorkerProgram,
    private readonly workerRuntime: string,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly connectWorker: (options: WorkerClientOptions) => Promise<BrowserWorkerClient> = options =>
      BrowserWorkerClient.connect(options),
    private readonly modes: SessionBrowserModeOptions = {},
  ) {}

  async launch(viewport: { readonly width: number; readonly height: number }): Promise<BrowserAutomation> {
    // Both preconditions are checked BEFORE the profile is leased: a machine with no worker or no
    // browser has nothing to clean up, and the refusal is the one plain sentence that names the fix.
    if (this.worker.kind === 'missing') throw new BrowserControlError('launch_failed', this.worker.message);
    const executable = selectChromeExecutable(process.platform, this.environment.FY_CHROME_BIN, existsSync, {
      home: this.environment.HOME,
      path: this.environment.PATH,
      available: command => Bun.which(command, { PATH: this.environment.PATH ?? '' }) !== null,
    });
    // The display is a precondition too: a Linux real window with no Xvfb refuses here, before any lease.
    const platform = this.modes.platform ?? process.platform;
    const mode = await this.mode();
    const proxy = await this.modes.proxy?.();
    const version = await chromeVersion(executable);
    const display = mode === 'window' && platform === 'linux' ? await this.privateDisplay() : undefined;
    const lease = await this.profile.acquire({ sessionId: AGENT_BROWSER_HOLDER });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    let relay: ProxySignInRelay | undefined;
    try {
      const port = await freePort();
      if (proxy?.credentials !== undefined) {
        relay = await ProxySignInRelay.start(proxyEndpoint(proxy.setting.url), proxy.credentials);
      }
      const userAgent = honestChromeUserAgent(version, platform, process.arch);
      chrome = Bun.spawn({
        cmd: [
          // HEADLESS unless the owner chose a real window. A real window keeps every page's window painting
          // while another has focus (`agentBrowserArguments`), because an agent may be driving — and a
          // person watching — any of them at once.
          ...agentBrowserArguments(executable, lease.profile, port, viewport, platform, mode, {
            ...(userAgent === undefined ? {} : { userAgent }),
            ...(proxy === undefined
              ? {}
              : {
                  proxy: {
                    server: relay === undefined ? proxy.setting.url : `http://127.0.0.1:${relay.port}`,
                    bypass: proxy.setting.bypass,
                  },
                }),
          }),
        ],
        env: defined(browserEnvironment(display, this.environment)),
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const diagnostics = collectTail(chrome.stderr as ReadableStream<Uint8Array>);
      await lease.updateChromePid(chrome.pid, version);
      const endpoint = `http://127.0.0.1:${port}`;
      await waitForCdp(endpoint, chrome, diagnostics);
      const worker = await this.connectWorker({
        runtime: this.workerRuntime,
        workerEntry: this.worker.kind === 'executable' ? this.worker.path : this.worker.entry,
        endpoint,
        workerExecutable: this.worker.kind === 'executable',
        ...(this.modes.stageDirectory === undefined ? {} : { stageDirectory: this.modes.stageDirectory }),
      });
      return new LeasedBrowser(
        worker,
        chrome,
        lease,
        this.modes.shutdownTimeoutMs,
        relay,
        proxy === undefined ? undefined : browserProxyStatus(proxy.setting),
      );
    } catch (error) {
      // A failed launch owns the same ordering obligation as a close: the browser it started is still
      // holding this profile, so the lease is released only once that Chrome is CONFIRMED gone — and
      // never on the strength of a signal alone. SIGKILL first because a Chrome that never reached its
      // debugging endpoint has no clean shutdown left to perform. Retaining the lease is the safe
      // outcome and never the reported one: the caller still gets the error that failed the launch —
      // and the obvious retry of that same session is refused by the store like anyone else, because
      // the Chrome this record still names may be the one that would not die.
      if (chrome === undefined || (await reapChrome(chrome, 'SIGKILL', this.modes.shutdownTimeoutMs))) {
        await lease.release().catch(() => undefined);
      }
      await relay?.close().catch(() => undefined);
      throw error;
    }
  }

  /** The Browser mode to launch in. A setting that cannot be read is the default, never a refusal: the
   *  agent browser must still start on a machine whose configuration is momentarily unreadable. */
  private async mode(): Promise<BrowserMode> {
    return (await this.modes.mode?.().catch(() => undefined)) ?? 'headless';
  }

  private async privateDisplay(): Promise<string> {
    if (this.modes.display === undefined) {
      throw new BrowserControlError('launch_failed', 'this daemon has no private display for a real browser window');
    }
    return await this.modes.display.display();
  }
}

class LeasedBrowser implements BrowserAutomation {
  /**
   * Resolves only once teardown has finished, never before it. The delay is the contract: an owner
   * that learns the browser died reacts by starting another one or opening a login window, and either
   * would race this teardown for the profile if the news arrived first.
   *
   * What teardown finished HAVING DONE is the honest part. On the verified path both children are
   * reaped and the lease is released. When a child could not be confirmed dead the lease is
   * deliberately kept, and this still resolves — the promise reports that cleanup has run its course,
   * not that the profile is free.
   */
  readonly unexpectedExit: Promise<number>;
  private teardown?: Promise<void>;
  constructor(
    private readonly worker: BrowserWorkerClient,
    private readonly chrome: ReturnType<typeof Bun.spawn>,
    private readonly lease: Awaited<ReturnType<BrowserProfilePort['acquire']>>,
    private readonly shutdownTimeoutMs: number = CHROME_SHUTDOWN_TIMEOUT_MS,
    private readonly relay?: ProxySignInRelay,
    readonly proxy?: BrowserProxyStatus,
  ) {
    // Either child settling means the SESSION is over: the worker without Chrome drives nothing, and
    // Chrome without its worker is an unreachable window still holding the profile. So both mean the
    // same teardown, and the one that survived is what teardown exists to kill.
    this.unexpectedExit = Promise.race([worker.unexpectedExit, chrome.exited]).then(async code => {
      await this.stop();
      return code;
    });
  }
  navigate: BrowserAutomation['navigate'] = (pageId, url) => this.worker.navigate(pageId, url);
  click: BrowserAutomation['click'] = (pageId, target, options) => this.worker.click(pageId, target, options);
  type: BrowserAutomation['type'] = (pageId, target, text, options) => this.worker.type(pageId, target, text, options);
  pointer: BrowserAutomation['pointer'] = (pageId, act) => this.worker.pointer(pageId, act);
  read: BrowserAutomation['read'] = (pageId, options) => this.worker.read(pageId, options);
  screenshot: BrowserAutomation['screenshot'] = (pageId, options) => this.worker.screenshot(pageId, options);
  upload: BrowserAutomation['upload'] = (pageId, target, paths, mode) =>
    this.worker.upload(pageId, target, paths, mode);
  download: BrowserAutomation['download'] = (pageId, downloadId) => this.worker.download(pageId, downloadId);
  pdf: BrowserAutomation['pdf'] = pageId => this.worker.pdf(pageId);
  evaluate: BrowserAutomation['evaluate'] = (pageId, script) => this.worker.evaluate(pageId, script);
  back: BrowserAutomation['back'] = pageId => this.worker.back(pageId);
  forward: BrowserAutomation['forward'] = pageId => this.worker.forward(pageId);
  reload: BrowserAutomation['reload'] = pageId => this.worker.reload(pageId);
  location: BrowserAutomation['location'] = pageId => this.worker.location(pageId);
  newPage: BrowserAutomation['newPage'] = options => this.worker.newPage(options);
  closePage: BrowserAutomation['closePage'] = pageId => this.worker.closePage(pageId);
  resize: BrowserAutomation['resize'] = (pageId, viewport) => this.worker.resize(pageId, viewport);
  lifecycle: BrowserAutomation['lifecycle'] = (pageId, request) => this.worker.lifecycle(pageId, request);
  startScreencast: BrowserAutomation['startScreencast'] = (pageId, viewport, listener) =>
    this.worker.startScreencast(pageId, viewport, listener);
  stopScreencast: BrowserAutomation['stopScreencast'] = (pageId, listener) =>
    this.worker.stopScreencast(pageId, listener);
  dispatchInput: BrowserAutomation['dispatchInput'] = (pageId, input) => this.worker.dispatchInput(pageId, input);
  async close(): Promise<void> {
    await this.stop();
  }
  /**
   * Single-flight: a normal close and either child's unexpected exit converge on ONE teardown. A
   * second attempt joins the first rather than repeating it, so no signal is ever aimed at a pid the
   * kernel has already recycled and no lease a later session now holds is released out from under it.
   */
  private stop(): Promise<void> {
    this.teardown ??= this.teardownOnce();
    return this.teardown;
  }
  private async teardownOnce(): Promise<void> {
    // The worker first: it owns the CDP connection and closes Chrome cleanly when it still can. Its
    // own close already escalates until the worker process is really gone and FAILS ONLY when it could
    // not confirm that, so the answer is kept rather than swallowed: a worker still standing is a
    // browser still reachable, whatever happened to Chrome.
    const workerGone = await this.worker.close().then(succeeded, failed);
    // Chrome is reaped either way — a worker that would not die is no reason to leave a browser up.
    const chromeGone = await reapChrome(this.chrome, 'SIGTERM', this.shutdownTimeoutMs);
    await this.relay?.close().catch(() => undefined);
    // Released LAST and only on BOTH confirmations: a lease that outlives either child by even a
    // moment lets a login window or the next session open a second Chrome over a profile the first one
    // is still writing to. A survivor therefore KEEPS the lease — an unreleased lease costs this
    // daemon its one shared profile, while a released one costs a live browser's profile its
    // integrity. Kept means kept against EVERYONE: the store refuses every later acquirer,
    // including this same session restarting, and no retry ever clears it. A later daemon re-derives
    // the verdict from the pids the record names and reclaims only once they are confirmed gone — a
    // Chrome that survived is refused across a restart too, which is the point rather than a defect.
    if (workerGone && chromeGone) await this.lease.release().catch(() => undefined);
  }
}

/**
 * Bounded shutdown budget for the private Chrome — the same one the worker transport gives its own
 * child. Long enough for a browser to flush a profile it was told to close, short enough that one
 * wedged process cannot hold a session's teardown, or daemon shutdown, open indefinitely.
 */
const CHROME_SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * Escalates until Chrome is gone and reports WHETHER IT ACTUALLY WENT. A signal is a request, not an
 * outcome: a browser routinely traps SIGTERM so it can close its profile cleanly, so releasing a
 * profile lease on the strength of having sent one is how a second Chrome opens over a live one.
 *
 * Bounded, so this can never become a shutdown hang — but a bound that expires is a failure to reap,
 * not a licence to proceed, which is why the answer is returned rather than swallowed. Nothing else
 * can stand in for it: Chrome's own SingletonLock would warn the next acquirer, but a browser killed
 * before it finished starting has not written one yet.
 */
async function reapChrome(
  chrome: ReturnType<typeof Bun.spawn>,
  first: 'SIGTERM' | 'SIGKILL',
  timeoutMs: number = CHROME_SHUTDOWN_TIMEOUT_MS,
): Promise<boolean> {
  signalChrome(chrome, first);
  if (await exitedWithin(chrome, timeoutMs)) return true;
  signalChrome(chrome, 'SIGKILL');
  return await exitedWithin(chrome, timeoutMs);
}

/** Named so a shutdown reads as the two-outcome question it is, rather than as a swallowed rejection. */
const succeeded = (): boolean => true;
const failed = (): boolean => false;

function signalChrome(chrome: ReturnType<typeof Bun.spawn>, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    chrome.kill(signal);
  } catch {
    // Already exited between the last wait and this signal, which is the outcome we wanted.
  }
}

/** A wait that is always cleared, so a reaped child leaves no timer holding the runtime alive. */
async function exitedWithin(chrome: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      chrome.exited.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function defined(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined) result[key] = value;
  return result;
}
async function chromeVersion(executable: string): Promise<string> {
  const child = Bun.spawn({ cmd: [executable, '--version'], stdout: 'pipe', stderr: 'ignore' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const version = stdout.trim();
  if (code !== 0 || version === '') throw new BrowserControlError('launch_failed', 'Chrome did not report a version');
  return version;
}
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('Chrome port unavailable'))));
    });
  });
}
async function waitForCdp(
  endpoint: string,
  chrome: ReturnType<typeof Bun.spawn>,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let exited = false;
  while (Date.now() < deadline) {
    if (
      await fetch(`${endpoint}/json/version`)
        .then(response => response.ok)
        .catch(() => false)
    )
      return;
    exited = await Promise.race([chrome.exited.then(() => true), Bun.sleep(100).then(() => false)]);
    if (exited) break;
  }
  const why = exited ? `Chrome exited with code ${chrome.exitCode ?? 'unknown'}` : 'Chrome was still running after 20s';
  const said = diagnostics();
  throw new BrowserControlError(
    'launch_failed',
    `Chrome did not expose its private debugging endpoint (${why})${said === '' ? '' : `: ${said}`}`,
  );
}

const CHROME_STDERR_TAIL_BYTES = 2_048;

/** Drains Chrome's stderr for the browser's whole life (an undrained pipe would eventually block it) and
 *  keeps only the last bytes, so a launch failure can say WHY Chrome did not start. */
function collectTail(stream: ReadableStream<Uint8Array>): () => string {
  let tail = '';
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-CHROME_STDERR_TAIL_BYTES);
      }
    } catch {
      // The pipe closing with the child is the normal end of this drain.
    }
  })();
  return () => tail.trim().replace(/\s+/g, ' ');
}
