import { createServer } from 'node:net';
import { milliseconds } from '@ferretry/std';
import type { BrowserMode, BrowserProxyStatus } from '../../contract/index.ts';
import type { ResolvedBrowserPorts } from '../proxy/wire/ports.ts';
import {
  agentBrowserArguments,
  BrowserControlError,
  type BrowserProfilePort,
  browserEnvironment,
  type CdpEndpoint,
  type CdpTransport,
  defaultCdpTransport,
  honestChromeUserAgent,
  listenerHeldRefusal,
  selectChromeExecutable,
} from './control/index.ts';
import { browserProxyStatus, proxyEndpoint, type ResolvedBrowserProxy } from '../proxy/index.ts';
import type { BrowserSessionLauncher } from '../pages/service.ts';
import type { ChildHandle, Clock, FetchPort, SpawnPort } from '@ferretry/kernel/contract';
import type { BrowserAutomation } from '../pages/automation.ts';
import type { BrowserHost } from '../adapters/host.ts';
import type { ListenerProverPort } from './control/adapters/listener-prover.ts';
import type { BrowserDisplayPort } from './control/adapters/login-runtime.ts';
import { ProxySignInRelay } from '../proxy/adapters/sign-in-relay.ts';
import { BrowserWorkerClient, type StartWorker, type WorkerClientOptions } from './client.ts';

/** Launches the machine's ONE agent Chrome — in the machine's Browser mode (headless by default; a real
 * window when the owner asked for one), over the dedicated agent profile, shared by every session — and the
 * worker that drives it. The profile lease is held until both
 * Chrome and the worker are gone, so a login window can never open over a live automation browser —
 * and a lease kept because cleanup could not be confirmed closes the profile to EVERY later launch,
 * this same session's retry included; only confirmed cleanup or dead-owner recovery frees it.
 *
 * The worker is a PROCESS of its own (`kernel.spawn`, as today; lead decision, port-browsers r1), and Chrome is
 * spawned through `kernel.spawn` too. It reaches Chrome over the machine's DevTools transport (`CdpTransport`).
 * Today's PIPE (`CDP_PIPE_SWITCH`: Chrome's fds 3 and 4 handed to the worker as ITS fds 3 and 4, so nothing on this
 * host has an address to drive the owner's signed-in profile through) is REFUSED here, saying why: the kernel's spawn
 * gives a child no extra pipes and cannot hand one child's ends to another (GAP, kernel spawn). Over a PORT — the
 * default — Chrome listens on loopback and the worker connects to it once it answers — and only
 * once the kernel shows the listener is THIS Chrome's own socket (`lib/browser/control/listener-proof.ts`):
 * the port is picked free and released before Chrome binds it, and a squatter who took it in between would
 * otherwise be the endpoint the worker drives. Either
 * way the daemon spawns Chrome itself, so it holds the real child: the pid on the lease, the exit it waits
 * on and the process it reaps are Chrome's own. A worker that dies is a browser restart: the daemon reaps Chrome
 * ITSELF (`LeasedBrowser`), never trusting the worker to have closed it, and starts a fresh pair on the next need. */
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
  /**
   * Why the worker cannot start on this host (no worker beside the daemon, no Node for a source checkout), checked
   * BEFORE the profile is leased like today's `worker.kind === 'missing'`; `undefined` when it can.
   */
  readonly workerRefusal?: () => string | undefined;
  /** Scope-mode wrappers exec in place, preserving Chrome's PID, lease and DevTools fds 3/4. */
  readonly limits?: { browserCommand(command: readonly string[]): Promise<readonly string[]> };
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
   * unreadable, means the default (`defaultCdpTransport`): the port. A pipe is refused ({@link PIPE_TRANSPORT_REFUSAL}).
   */
  readonly transport?: () => Promise<CdpTransport>;
  /** The DevTools port a PORT-transport Chrome is told to take. Defaults to a free one the kernel picks. */
  readonly cdpPort?: () => Promise<number>;
  /** Proves the listener on that port is the spawned Chrome's. Required. */
  readonly listenerProver: ListenerProverPort;
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

/** The sentence a pipe-transport launch is refused with, before anything is leased or spawned. */
export const PIPE_TRANSPORT_REFUSAL =
  "The browser's DevTools pipe is not available in this build: the browser worker is a process of its own, and " +
  "Ferretry cannot yet hand it Chrome's end of the pipe. Use the private loopback port, the default.";

/**
 * What the launcher reaches the world through: the kernel's ports, and the host facts no kernel port gives a half
 * yet (`./adapters/host.ts`, a declared GAP).
 */
export interface LauncherPorts {
  readonly clock: Clock;
  /** `kernel.spawn`: Chrome and its `--version`, under a name `permissions.spawn` declares. */
  readonly spawn: Pick<SpawnPort, 'start' | 'run'>;
  /** `kernel.fetch`: Chrome's `/json/version` on loopback (`permissions.network`). */
  readonly fetch: FetchPort;
  readonly host: Pick<BrowserHost, 'platform' | 'arch' | 'exists' | 'which'>;
}

export class NodeSessionBrowserLauncher implements BrowserSessionLauncher {
  constructor(
    private readonly profile: BrowserProfilePort,
    /** Starts the browser worker PROCESS (`kernel.spawn.start` of the worker program; `../index.ts`). */
    private readonly workers: StartWorker,
    private readonly ports: LauncherPorts,
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly connectWorker: (options: WorkerClientOptions) => Promise<BrowserWorkerClient> = options =>
      BrowserWorkerClient.connect(options),
    private readonly modes: SessionBrowserModeOptions,
  ) {}

  async launch(viewport: { readonly width: number; readonly height: number }): Promise<BrowserAutomation> {
    // Both preconditions are checked BEFORE the profile is leased: a machine with no worker or no browser has
    // nothing to clean up, and the refusal is the one plain sentence that names the fix.
    const noWorker = this.modes.workerRefusal?.();
    if (noWorker !== undefined) throw new BrowserControlError('launch_failed', noWorker);
    const host = this.ports.host;
    const executable = selectChromeExecutable(host.platform, this.environment.FY_CHROME_BIN, host.exists, {
      home: this.environment.HOME,
      path: this.environment.PATH,
      available: command => host.which(command, this.environment.PATH) !== undefined,
    });
    // The display is a precondition too: a Linux real window with no Xvfb refuses here, before any lease.
    const platform = this.modes.platform ?? host.platform;
    const mode = await this.mode();
    const transport = (await this.modes.transport?.().catch(() => undefined)) ?? defaultCdpTransport();
    // Refused before anything is leased or spawned, and never quietly swapped for the port: GAP (kernel spawn).
    if (transport === 'pipe') throw new BrowserControlError('launch_failed', PIPE_TRANSPORT_REFUSAL);
    const ports = await this.modes.ports?.();
    if (ports?.kind === 'refused') throw new BrowserControlError('launch_failed', ports.reason);
    const fixed = ports?.kind === 'fixed' ? ports.ports : undefined;
    if (fixed !== undefined) {
      const refusal = await this.modes.checkFirewall?.().catch(() => undefined);
      if (refusal !== undefined) throw new BrowserControlError('launch_failed', refusal);
    }
    const proxy = await this.modes.proxy?.();
    const version = await chromeVersion(this.ports.spawn, executable);
    const display = mode === 'window' && platform === 'linux' ? await this.privateDisplay() : undefined;
    const lease = await this.profile.acquire({ sessionId: AGENT_BROWSER_HOLDER });
    let chrome: ChromeChild | undefined;
    let relay: ProxySignInRelay | undefined;
    try {
      const cdp: Extract<CdpEndpoint, { readonly kind: 'port' }> = {
        kind: 'port',
        port: fixed?.cdp ?? (await (this.modes.cdpPort ?? freePort)()),
      };
      const prover = this.modes.listenerProver;
      if (proxy?.credentials !== undefined) {
        relay = await ProxySignInRelay.start(proxyEndpoint(proxy.setting.url), proxy.credentials, undefined, {
          ...(fixed === undefined ? {} : { port: fixed.relay }),
          holder: async taken => await prover.holder(taken),
        });
      }
      const userAgent = honestChromeUserAgent(version, platform, host.arch);
      const chromeCommand = [
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
      ];
      const [program, ...args] = (await this.modes.limits?.browserCommand(chromeCommand)) ?? chromeCommand;
      if (program === undefined) throw new BrowserControlError('launch_failed', 'no Chrome command to run');
      chrome = chromeChild(
        this.ports.spawn.start(program, args, {
          // The window's cookie rides with its display: a Chrome without it is refused by the private X server.
          env: defined(
            browserEnvironment(
              display,
              this.environment,
              display === undefined ? undefined : this.modes.display?.authority(),
            ),
          ),
        }),
      );
      // Stderr is kept for the launch diagnostic; stdout (ignored today) is drained so it can never fill.
      void drain(chrome.stdout);
      const diagnostics = collectTail(chrome.stderr);
      // Recorded BEFORE anything else can fail: from here on, the Chrome holding the profile is this pid.
      await lease.updateChromePid(chrome.pid, version);
      const endpoint = `http://127.0.0.1:${cdp.port}`;
      await waitForCdp(this.ports, endpoint, cdp.port, chrome, diagnostics, prover);
      let worker: BrowserWorkerClient;
      try {
        worker = await this.connectWorker({
          start: this.workers,
          clock: this.ports.clock,
          endpoint,
          environment: this.environment,
          readyTimeoutMs: WORKER_ATTACH_TIMEOUT_MS,
          ...(this.modes.stageDirectory === undefined ? {} : { stageDirectory: this.modes.stageDirectory }),
        });
      } catch (error) {
        throw await attachFailure(this.ports.clock, error, chrome, diagnostics);
      }
      return new LeasedBrowser(
        worker,
        chrome,
        lease,
        this.ports.clock,
        this.modes.shutdownTimeoutMs,
        relay,
        proxy === undefined ? undefined : browserProxyStatus(proxy.setting),
        // A window on a desktop other than Linux's private display draws on this computer's own clipboard.
        mode === 'window' && platform !== 'linux',
      );
    } catch (error) {
      // A failed launch owns the same ordering obligation as a close: the browser it started is still
      // holding this profile, so the lease is released only once that Chrome is CONFIRMED gone — and
      // never on the strength of a signal alone. SIGKILL first because a Chrome its worker never attached
      // to — or that never reached its debugging endpoint — has no clean shutdown left to perform. Retaining the lease is the safe
      // outcome and never the reported one: the caller still gets the error that failed the launch —
      // and the obvious retry of that same session is refused by the store like anyone else, because
      // the Chrome this record still names may be the one that would not die.
      if (
        chrome === undefined ||
        (await reapChrome(this.ports.clock, chrome, 'SIGKILL', this.modes.shutdownTimeoutMs))
      ) {
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
    private readonly chrome: ChromeChild,
    private readonly lease: Awaited<ReturnType<BrowserProfilePort['acquire']>>,
    private readonly clock: Clock,
    private readonly shutdownTimeoutMs: number = CHROME_SHUTDOWN_TIMEOUT_MS,
    private readonly relay?: ProxySignInRelay,
    readonly proxy?: BrowserProxyStatus,
    private readonly clipboardShared = false,
  ) {
    // Either child settling means the SESSION is over: the worker without Chrome drives nothing, and
    // Chrome without its worker is a window still holding the profile that nothing drives — and is never
    // reattached to. So both mean the same teardown, and the one that
    // survived is what teardown exists to kill. The browser service then launches a fresh pair on the
    // next need: a worker crash is a browser restart, never a reattach.
    this.unexpectedExit = Promise.race([worker.unexpectedExit, chrome.exited.then(code => code ?? -1)]).then(
      async code => {
        await this.stop();
        return code;
      },
    );
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
  copyRead: BrowserAutomation['copyRead'] = (pageId, target, part, attribute) =>
    this.worker.copyRead(pageId, target, part, attribute);
  /** A real window on a desktop shares this computer's own clipboard: nothing is read from it. */
  copyClipboard: BrowserAutomation['copyClipboard'] = async pageId =>
    this.clipboardShared ? { ok: false, reason: 'shared' } : await this.worker.copyClipboard(pageId);
  inputDocument: BrowserAutomation['inputDocument'] = pageId => this.worker.inputDocument(pageId);
  pushNumberRead: NonNullable<BrowserAutomation['pushNumberRead']> = pageId => this.worker.pushNumberRead(pageId);
  inputText = (pageId: string): Promise<string> => this.worker.inputText(pageId);
  inputProbe: NonNullable<BrowserAutomation['inputProbe']> = (pageId, expected, fieldIds, dummy) =>
    this.worker.inputProbe(pageId, expected, fieldIds, dummy);
  inputObserve: BrowserAutomation['inputObserve'] = (pageId, fields) => this.worker.inputObserve(pageId, fields);
  inputRefind: BrowserAutomation['inputRefind'] = (pageId, expected, fields) =>
    this.worker.inputRefind(pageId, expected, fields);
  inputShot: BrowserAutomation['inputShot'] = (pageId, facts) => this.worker.inputShot(pageId, facts);
  inputType: BrowserAutomation['inputType'] = (pageId, expected, values, submit) =>
    this.worker.inputType(pageId, expected, values, submit);
  inputArm: NonNullable<BrowserAutomation['inputArm']> = (pageId, expected, fieldIds) =>
    this.worker.inputArm(pageId, expected, fieldIds);
  inputClear: NonNullable<BrowserAutomation['inputClear']> = (pageId, job) => this.worker.inputClear(pageId, job);
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
    // Chrome is reaped HERE, by the daemon that spawned it, either way — a worker that would not die, or one that
    // died first, is no reason to leave a browser up (and the worker's process group is not signalled: GAP).
    const chromeGone = await reapChrome(this.clock, this.chrome, 'SIGTERM', this.shutdownTimeoutMs);
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
  clock: Clock,
  chrome: ChromeChild,
  first: 'SIGTERM' | 'SIGKILL',
  timeoutMs: number = CHROME_SHUTDOWN_TIMEOUT_MS,
): Promise<boolean> {
  signalChrome(chrome, first);
  if (await exitedWithin(clock, chrome, timeoutMs)) return true;
  signalChrome(chrome, 'SIGKILL');
  return await exitedWithin(clock, chrome, timeoutMs);
}

/** Named so a shutdown reads as the two-outcome question it is, rather than as a swallowed rejection. */
const succeeded = (): boolean => true;
const failed = (): boolean => false;

function signalChrome(chrome: ChromeChild, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    chrome.kill(signal);
  } catch {
    // Already exited between the last wait and this signal, which is the outcome we wanted.
  }
}

/** A wait that is always cleared, so a reaped child leaves no timer holding the runtime alive. */
async function exitedWithin(clock: Clock, chrome: ChromeChild, timeoutMs: number): Promise<boolean> {
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      chrome.exited.then(() => true),
      new Promise<boolean>(resolve => {
        cancel = clock.after(milliseconds(timeoutMs), () => resolve(false));
      }),
    ]);
  } finally {
    cancel?.();
  }
}

/** Chrome as the daemon holds it: the kernel's child, and the code it exited with once it has. */
interface ChromeChild {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  /** `undefined` while it runs; `null` when a signal ended it. */
  exitCode(): number | null | undefined;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

function chromeChild(child: ChildHandle): ChromeChild {
  let code: number | null | undefined;
  const exited = child.exited.then(
    value => {
      code = value;
      return value;
    },
    () => {
      code = null;
      return null;
    },
  );
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    exitCode: () => code,
    kill: signal => child.kill(signal),
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  try {
    for await (const _chunk of stream) {
      // discarded
    }
  } catch {
    // The pipe closing with the child is the normal end of this drain.
  }
}

function defined(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined) result[key] = value;
  return result;
}
async function chromeVersion(spawn: Pick<SpawnPort, 'run'>, executable: string): Promise<string> {
  const ran = await spawn.run(executable, ['--version']);
  const version = ran.stdout.trim();
  if (ran.exitCode !== 0 || version === '')
    throw new BrowserControlError('launch_failed', 'Chrome did not report a version');
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
// read-scoped: none — it waits for Chrome's DevTools port and shows no page text
async function waitForCdp(
  ports: Pick<LauncherPorts, 'clock' | 'fetch'>,
  endpoint: string,
  port: number,
  chrome: ChromeChild,
  diagnostics: () => string,
  prover: ListenerProverPort,
): Promise<void> {
  const deadline = ports.clock.nowMs() + 20_000;
  let exited = false;
  while (ports.clock.nowMs() < deadline) {
    const proof = await prover.prove(port, chrome.pid);
    if (proof.kind === 'foreign') throw new BrowserControlError('launch_failed', listenerHeldRefusal(port, proof.uid));
    if (
      proof.kind !== 'absent' &&
      (await ports.fetch
        .request(`${endpoint}/json/version`)
        .then(response => response.ok)
        .catch(() => false))
    )
      return;
    exited = await exitedWithin(ports.clock, chrome, 100);
    if (exited) break;
  }
  const why = exited
    ? `Chrome exited with code ${chrome.exitCode() ?? 'unknown'}`
    : 'Chrome was still running after 20s';
  const said = diagnostics();
  throw new BrowserControlError(
    'launch_failed',
    `Chrome did not expose its private debugging endpoint (${why})${said === '' ? '' : `: ${said}`}`,
  );
}

/** How long a freshly spawned Chrome and its worker get to finish the DevTools handshake (today's budget). */
const WORKER_ATTACH_TIMEOUT_MS = 25_000;

/** How long a Chrome whose worker could not attach gets to show that it is the one that died. */
const CHROME_EXIT_GRACE_MS = 250;

/**
 * Why a worker could not attach, told as Chrome's failure when Chrome is what died: a Chrome that exits closes
 * its end of the pipe, the worker's handshake fails on it, and "the worker failed" alone would hide the
 * browser's own words about why it would not start.
 */
async function attachFailure(
  clock: Clock,
  error: unknown,
  chrome: ChromeChild,
  diagnostics: () => string,
): Promise<unknown> {
  if (!(await exitedWithin(clock, chrome, CHROME_EXIT_GRACE_MS))) return error;
  const said = diagnostics();
  return new BrowserControlError(
    'launch_failed',
    `Chrome exited with code ${chrome.exitCode() ?? 'unknown'} before its worker could attach${said === '' ? '' : `: ${said}`}`,
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
