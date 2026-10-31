import { closeSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import type { BrowserMode, BrowserProxyStatus, ResolvedBrowserPorts } from '@ferretry/protocol';
import {
  agentBrowserArguments,
  type CdpEndpoint,
  type CdpTransport,
  defaultCdpTransport,
  BrowserControlError,
  listenerHeldRefusal,
  type BrowserProfilePort,
  browserEnvironment,
  honestChromeUserAgent,
  selectChromeExecutable,
} from '../../../lib/browser/control/index.ts';
import { browserProxyStatus, proxyEndpoint, type ResolvedBrowserProxy } from '../../../lib/browser/proxy/index.ts';
import type { BrowserSessionLauncher, BrowserWorkerProgram } from '../../../lib/browser/runtime/index.ts';
import { type BrowserAutomation, CDP_PIPE_ENDPOINT } from '../../../lib/browser/transport/index.ts';
import { type ListenerProverPort, ProcListenerProver } from '../control/listener-prover.ts';
import type { BrowserDisplayPort } from '../control/login-runtime.ts';
import { ProxySignInRelay } from '../proxy/sign-in-relay.ts';
import { BrowserWorkerClient, type CdpPipeEnds, type WorkerClientOptions } from '../transport/worker-client.ts';

/** Launches the machine's ONE agent Chrome — in the machine's Browser mode (headless by default; a real
 * window when the owner asked for one), over the dedicated agent profile, shared by every session — and the
 * worker that drives it. The profile lease is held until both
 * Chrome and the worker are gone, so a login window can never open over a live automation browser —
 * and a lease kept because cleanup could not be confirmed closes the profile to EVERY later launch,
 * this same session's retry included; only confirmed cleanup or dead-owner recovery frees it.
 *
 * The worker reaches Chrome over the machine's DevTools transport (`CdpTransport`). Over the PIPE
 * (`CDP_PIPE_SWITCH`) Chrome is spawned with its fds 3 and 4 wired, the daemon's ends become the worker's
 * fds 3 and 4, and the daemon then closes its own copies: nothing on this host — another account included —
 * has an address to drive the owner's signed-in profile through, and there is no free-port probe for anyone
 * to race. Over a PORT, Chrome listens on loopback and the worker connects to it once it answers — and only
 * once the kernel shows the listener is THIS Chrome's own socket (`lib/browser/control/listener-proof.ts`):
 * the port is picked free and released before Chrome binds it, and a squatter who took it in between would
 * otherwise be the endpoint the worker drives. Either
 * way the daemon spawns Chrome itself, so it holds the real child: the pid on the lease, the exit it waits
 * on and the process it reaps are Chrome's own. A worker that dies takes the pipe's only other end with it;
 * Chrome reads end-of-file and quits, and the browser is torn down and started fresh on the next need
 * rather than reattached — a pipe, unlike a port, cannot be reconnected to. */
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
  /**
   * How the worker reaches Chrome's DevTools protocol, read at every launch like the mode. Absent, or
   * unreadable, means the default (`defaultCdpTransport`): the port. The pipe runs only when this names it.
   */
  readonly transport?: () => Promise<CdpTransport>;
  /** The DevTools port a PORT-transport Chrome is told to take. Defaults to a free one the kernel picks. */
  readonly cdpPort?: () => Promise<number>;
  /** Proves the listener on that port is the spawned Chrome's. Defaults to this host's `/proc`. */
  readonly listenerProver?: ListenerProverPort;
  /** Which loopback ports `browserPorts` asks for, read at every launch like the mode; absent means random. */
  readonly ports?: () => Promise<ResolvedBrowserPorts>;
  /**
   * Asked at each start that binds fixed ports: the sentence that declines it (the owner chose `refuse` and this
   * account's firewall check failed), or `undefined` to go ahead. An unreadable answer never blocks a start.
   */
  readonly checkFirewall?: () => Promise<string | undefined>;
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
    const transport = (await this.modes.transport?.().catch(() => undefined)) ?? defaultCdpTransport();
    const ports = await this.modes.ports?.();
    if (ports?.kind === 'refused') throw new BrowserControlError('launch_failed', ports.reason);
    const fixed = ports?.kind === 'fixed' ? ports.ports : undefined;
    if (fixed !== undefined) {
      const refusal = await this.modes.checkFirewall?.().catch(() => undefined);
      if (refusal !== undefined) throw new BrowserControlError('launch_failed', refusal);
    }
    const proxy = await this.modes.proxy?.();
    const version = await chromeVersion(executable);
    const display = mode === 'window' && platform === 'linux' ? await this.privateDisplay() : undefined;
    const lease = await this.profile.acquire({ sessionId: AGENT_BROWSER_HOLDER });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    let relay: ProxySignInRelay | undefined;
    let pipe: CdpPipeEnds | undefined;
    try {
      const cdp: CdpEndpoint =
        transport === 'pipe'
          ? { kind: 'pipe' }
          : { kind: 'port', port: fixed?.cdp ?? (await (this.modes.cdpPort ?? freePort)()) };
      if (proxy?.credentials !== undefined) {
        relay = await ProxySignInRelay.start(
          proxyEndpoint(proxy.setting.url),
          proxy.credentials,
          undefined,
          fixed === undefined ? {} : { port: fixed.relay },
        );
      }
      const userAgent = honestChromeUserAgent(version, platform, process.arch);
      chrome = Bun.spawn({
        cmd: [
          // HEADLESS unless the owner chose a real window. A real window keeps every page's window painting
          // while another has focus (`agentBrowserArguments`), because an agent may be driving — and a
          // person watching — any of them at once.
          ...agentBrowserArguments(executable, lease.profile, cdp, viewport, platform, mode, {
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
        // The window's cookie rides with its display: a Chrome without it is refused by the private X server.
        env: defined(
          browserEnvironment(
            display,
            this.environment,
            display === undefined ? undefined : this.modes.display?.authority(),
          ),
        ),
        // Over the pipe, fds 3 and 4 are the DevTools protocol (`--remote-debugging-pipe`): Chrome reads
        // requests on 3 and writes replies and events on 4. Stderr is drained for the launch diagnostic.
        stdio: cdp.kind === 'pipe' ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
      });
      if (cdp.kind === 'pipe') pipe = cdpPipeEnds(chrome);
      const diagnostics = collectTail(chrome.stderr as ReadableStream<Uint8Array>);
      // Recorded BEFORE anything else can fail: from here on, the Chrome holding the profile is this pid.
      await lease.updateChromePid(chrome.pid, version);
      const endpoint = cdp.kind === 'pipe' ? CDP_PIPE_ENDPOINT : `http://127.0.0.1:${cdp.port}`;
      if (cdp.kind === 'port') {
        await waitForCdp(
          endpoint,
          cdp.port,
          chrome,
          diagnostics,
          this.modes.listenerProver ?? new ProcListenerProver(),
        );
      }
      let worker: BrowserWorkerClient;
      try {
        worker = await this.connectWorker({
          runtime: this.workerRuntime,
          workerEntry: this.worker.kind === 'executable' ? this.worker.path : this.worker.entry,
          endpoint,
          ...(pipe === undefined ? {} : { cdpPipe: pipe }),
          workerExecutable: this.worker.kind === 'executable',
          readyTimeoutMs: WORKER_ATTACH_TIMEOUT_MS,
          ...(this.modes.stageDirectory === undefined ? {} : { stageDirectory: this.modes.stageDirectory }),
        });
      } catch (error) {
        throw await attachFailure(error, chrome, diagnostics);
      } finally {
        // The worker has its own copies now, or never will. Closing the daemon's is what lets Chrome see
        // end-of-file when the worker goes, and is what keeps the pipe between exactly two processes.
        // Forgotten once closed, so the failure path below never closes a descriptor reused since.
        if (pipe !== undefined) closePipe(pipe);
        pipe = undefined;
      }
      return new LeasedBrowser(
        worker,
        chrome,
        lease,
        this.modes.shutdownTimeoutMs,
        relay,
        proxy === undefined ? undefined : browserProxyStatus(proxy.setting),
      );
    } catch (error) {
      if (pipe !== undefined) closePipe(pipe);
      // A failed launch owns the same ordering obligation as a close: the browser it started is still
      // holding this profile, so the lease is released only once that Chrome is CONFIRMED gone — and
      // never on the strength of a signal alone. SIGKILL first because a Chrome its worker never attached
      // to — or that never reached its debugging endpoint — has no clean shutdown left to perform. Retaining the lease is the safe
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
    // Chrome without its worker is an unreachable window still holding the profile — the pipe died with
    // the worker, and nothing can attach to Chrome again. So both mean the same teardown, and the one that
    // survived is what teardown exists to kill. The browser service then launches a fresh pair on the
    // next need: a worker crash is a browser restart, never a reattach.
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
  inputDocument: BrowserAutomation['inputDocument'] = pageId => this.worker.inputDocument(pageId);
  inputObserve: BrowserAutomation['inputObserve'] = (pageId, fields) => this.worker.inputObserve(pageId, fields);
  inputShot: BrowserAutomation['inputShot'] = (pageId, facts) => this.worker.inputShot(pageId, facts);
  inputType: BrowserAutomation['inputType'] = (pageId, expected, values, submit) =>
    this.worker.inputType(pageId, expected, values, submit);
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
    // The worker first: it holds the CDP connection and closes Chrome cleanly when it still can. Its
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
/**
 * Waits for Chrome's debugging endpoint — asking it for `/json/version` only once the kernel shows the listener
 * on its port is this Chrome's own socket, so nothing is ever sent to a program that took the port first. A
 * listener that is not Chrome's refuses at once: Chrome cannot bind a port somebody holds, so waiting longer
 * would only report a timeout instead of the squatter. A host that cannot prove (macOS) asks as it always did.
 */
async function waitForCdp(
  endpoint: string,
  port: number,
  chrome: ReturnType<typeof Bun.spawn>,
  diagnostics: () => string,
  prover: ListenerProverPort,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let exited = false;
  while (Date.now() < deadline) {
    const proof = await prover.prove(port, chrome.pid);
    if (proof.kind === 'foreign') throw new BrowserControlError('launch_failed', listenerHeldRefusal(port, proof.uid));
    if (
      proof.kind !== 'absent' &&
      (await fetch(`${endpoint}/json/version`)
        .then(response => response.ok)
        .catch(() => false))
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

/**
 * How long a freshly spawned Chrome and its worker get to finish the DevTools handshake — over the pipe that
 * is Chrome's whole start-up, which a port spends polling its endpoint instead, so it gets that budget.
 */
const WORKER_ATTACH_TIMEOUT_MS = 25_000;

/** How long a Chrome whose worker could not attach gets to show that it is the one that died. */
const CHROME_EXIT_GRACE_MS = 250;

/**
 * The daemon's ends of Chrome's DevTools pipe — numbers, because both slots were spawned as `'pipe'`. Reading
 * `stdio` hands them to the caller to close; Bun creates them close-on-exec, so no other child this daemon
 * starts inherits an end by accident.
 */
function cdpPipeEnds(chrome: ReturnType<typeof Bun.spawn>): CdpPipeEnds {
  const [, , , toChrome, fromChrome] = chrome.stdio as unknown as readonly [null, null, null, number, number];
  return { toChrome, fromChrome };
}

/** Closes the daemon's ends of the pipe. Called exactly once per launch, never on a descriptor reused since. */
function closePipe(pipe: CdpPipeEnds): void {
  closeSync(pipe.toChrome);
  closeSync(pipe.fromChrome);
}

/**
 * Why a worker could not attach, told as Chrome's failure when Chrome is what died: a Chrome that exits closes
 * its end of the pipe, the worker's handshake fails on it, and "the worker failed" alone would hide the
 * browser's own words about why it would not start.
 */
async function attachFailure(
  error: unknown,
  chrome: ReturnType<typeof Bun.spawn>,
  diagnostics: () => string,
): Promise<unknown> {
  if (!(await exitedWithin(chrome, CHROME_EXIT_GRACE_MS))) return error;
  const said = diagnostics();
  return new BrowserControlError(
    'launch_failed',
    `Chrome exited with code ${chrome.exitCode ?? 'unknown'} before its worker could attach${said === '' ? '' : `: ${said}`}`,
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
