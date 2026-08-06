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
      chrome?.kill('SIGKILL');
      await lease.release().catch(() => undefined);
      throw error;
    }
  }
}

class LeasedBrowser implements BrowserAutomation {
  readonly unexpectedExit: Promise<number>;
  private closed = false;
  constructor(
    private readonly worker: BrowserWorkerClient,
    private readonly chrome: ReturnType<typeof Bun.spawn>,
    private readonly lease: Awaited<ReturnType<BrowserProfilePort['acquire']>>,
  ) {
    this.unexpectedExit = Promise.race([worker.unexpectedExit, chrome.exited]);
    void this.unexpectedExit.then(() => this.release());
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
    if (this.closed) return;
    this.closed = true;
    await this.worker.close().catch(() => undefined);
    this.chrome.kill('SIGTERM');
    await this.release();
  }
  private async release(): Promise<void> {
    await this.lease.release().catch(() => undefined);
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
