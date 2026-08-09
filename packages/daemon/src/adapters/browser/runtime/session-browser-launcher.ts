import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import {
  BrowserControlError,
  browserEnvironment,
  chromeLaunchArguments,
  selectChromeExecutable,
  type BrowserProfilePort,
} from '../../../lib/browser/control/index.ts';
import type { BrowserAutomation } from '../../../lib/browser/transport/index.ts';
import type { BrowserSessionLauncher } from '../../../lib/browser/runtime/index.ts';
import { BrowserWorkerClient, type WorkerClientOptions } from '../transport/worker-client.ts';

/** Launches the private Chrome that one session's worker drives. The profile lease is held until both
 * Chrome and the worker are gone, so a login window can never open over a live automation browser. */
export class NodeSessionBrowserLauncher implements BrowserSessionLauncher {
  constructor(
    private readonly profile: BrowserProfilePort,
    private readonly workerEntry: string,
    private readonly workerRuntime: string,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly connectWorker: (options: WorkerClientOptions) => Promise<BrowserWorkerClient> = options =>
      BrowserWorkerClient.connect(options),
    private readonly workerExecutable = false,
  ) {}

  async launch(
    sessionId: string,
    viewport: { readonly width: number; readonly height: number },
  ): Promise<BrowserAutomation> {
    const executable = selectChromeExecutable(process.platform, this.environment.FY_CHROME_BIN, existsSync);
    const lease = await this.profile.acquire({ sessionId });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const port = await freePort();
      chrome = Bun.spawn({
        cmd: [...chromeLaunchArguments(executable, lease.profile, port, viewport, process.platform)],
        // Linux Chrome is intentionally non-headless so the operator and screencast see the same
        // pixels; retain only the daemon-owned X display supplied by composition, never an ambient
        // display invented here.
        env: defined(
          browserEnvironment(process.platform === 'linux' ? this.environment.DISPLAY : undefined, this.environment),
        ),
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await lease.updateChromePid(chrome.pid, await chromeVersion(executable));
      const endpoint = `http://127.0.0.1:${port}`;
      await waitForCdp(endpoint, chrome);
      const worker = await this.connectWorker({
        runtime: this.workerRuntime,
        workerEntry: this.workerEntry,
        endpoint,
        workerExecutable: this.workerExecutable,
      });
      return new LeasedBrowser(worker, chrome, lease);
    } catch (error) {
      // A failed launch owns the same ordering obligation as a close: the browser it started is still
      // holding this profile, so the lease is released only once that Chrome is CONFIRMED gone — and
      // never on the strength of a signal alone. SIGKILL first because a Chrome that never reached its
      // debugging endpoint has no clean shutdown left to perform. Retaining the lease is the safe
      // outcome and never the reported one: the caller still gets the error that failed the launch.
      if (chrome === undefined || (await reapChrome(chrome, 'SIGKILL'))) await lease.release().catch(() => undefined);
      throw error;
    }
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
  ) {
    // Either child settling means the SESSION is over: the worker without Chrome drives nothing, and
    // Chrome without its worker is an unreachable window still holding the profile. So both mean the
    // same teardown, and the one that survived is what teardown exists to kill.
    this.unexpectedExit = Promise.race([worker.unexpectedExit, chrome.exited]).then(async code => {
      await this.stop();
      return code;
    });
  }
  navigate = (url: string) => this.worker.navigate(url);
  click = (selector: string) => this.worker.click(selector);
  type = (selector: string, text: string) => this.worker.type(selector, text);
  read = (selector?: string) => this.worker.read(selector);
  screenshot = () => this.worker.screenshot();
  back = () => this.worker.back();
  forward = () => this.worker.forward();
  reload = () => this.worker.reload();
  location = () => this.worker.location();
  newPage = (url?: string) => this.worker.newPage(url);
  activatePage = (id: string) => this.worker.activatePage(id);
  closePage = (id: string) => this.worker.closePage(id);
  resize = (viewport: { width: number; height: number }) => this.worker.resize(viewport);
  startScreencast = (
    viewport: { width: number; height: number },
    listener: Parameters<BrowserAutomation['startScreencast']>[1],
  ) => this.worker.startScreencast(viewport, listener);
  stopScreencast = () => this.worker.stopScreencast();
  dispatchInput = (input: Parameters<BrowserAutomation['dispatchInput']>[0]) => this.worker.dispatchInput(input);
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
    const chromeGone = await reapChrome(this.chrome, 'SIGTERM');
    // Released LAST and only on BOTH confirmations: a lease that outlives either child by even a
    // moment lets a login window or the next session open a second Chrome over a profile the first one
    // is still writing to. A survivor therefore KEEPS the lease — an unreleased lease costs this
    // daemon one shared profile until it exits, while a released one costs a live browser's profile
    // its integrity.
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
async function reapChrome(chrome: ReturnType<typeof Bun.spawn>, first: 'SIGTERM' | 'SIGKILL'): Promise<boolean> {
  signalChrome(chrome, first);
  if (await exitedWithin(chrome, CHROME_SHUTDOWN_TIMEOUT_MS)) return true;
  signalChrome(chrome, 'SIGKILL');
  return await exitedWithin(chrome, CHROME_SHUTDOWN_TIMEOUT_MS);
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
async function waitForCdp(endpoint: string, chrome: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (
      await fetch(`${endpoint}/json/version`)
        .then(response => response.ok)
        .catch(() => false)
    )
      return;
    if (await Promise.race([chrome.exited.then(() => true), Bun.sleep(100).then(() => false)])) break;
  }
  throw new BrowserControlError('launch_failed', 'Chrome did not expose its private debugging endpoint');
}
