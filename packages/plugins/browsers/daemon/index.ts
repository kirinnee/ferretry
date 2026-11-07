import type { ConfigFileDef, FerretId } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { type DaemonContext, type DaemonHalf, implementDaemon } from '@ferretry/kernel/manifest';
import { type BrowsersConfig, PageChanged } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { type BrowserSessionLauncher, BrowserSessionService } from './pages/service.ts';
import { type BrowserStreamOpener, pageRoutes, streamSocket } from './pages/routes.ts';
import { BrowsersReferenceMenu } from './pages/reference-menu.ts';
import { BrowserProxyTester, resolveBrowserProxy } from './proxy/index.ts';
import { TunnelProxyProbe } from './proxy/adapters/probe.ts';
import { proxyRoutes } from './proxy/routes.ts';
import { KernelFrameClock } from './stream/frame-clock.ts';
import { heldViewerHost } from './stream/held-host.ts';
import { BrowserViewerStream } from './stream/viewer-stream.ts';
import { pageTarget, TypedIdentities } from './target/index.ts';
import { nodeStagedFiles } from './tools/adapters/staged-files.ts';
import { SurfaceControl } from './tools/control.ts';
import { rootFiles } from './tools/files.ts';
import { controlRoutes, toolHandlers } from './tools/index.ts';
import { pageToolHost } from './tools/page-host.ts';
import { BrowserTools } from './tools/service.ts';
import type { RecordedSurfaceEvent } from './tools/types.ts';
import { processHost } from './adapters/host.ts';
import { KernelDetachedLauncher } from './open-url/launcher.ts';
import { systemOpenRoutes } from './open-url/routes.ts';
import { type DetachedLauncherPort, OpenUrlService } from './open-url/service.ts';
import { closeLeftoverBrowsers, spawnTerminate } from './leftovers.ts';
import { BrowserLoginWindowService } from './worker/control/adapters/login-window.ts';
import { NodeBrowserLoginRuntime, XvfbDisplay } from './worker/control/adapters/login-runtime.ts';
import { BrowserProfileStore } from './worker/control/adapters/profile-store.ts';
import type { StartWorker } from './worker/client.ts';
import { NodeSessionBrowserLauncher } from './worker/launcher.ts';
import { workerCommand } from './worker/program.ts';

/** A browser nobody watches or drives stops after this long, so a forgotten one does not hold the one shared profile. */
const BROWSER_IDLE_TIMEOUT_MS = 15 * 60_000;

/** `surface.*` event types mapped onto the published `PageChanged` change (a wake-up; the port is the truth). */
const PAGE_CHANGES: Readonly<
  Record<string, 'opened' | 'taken-over' | 'handed-back' | 'handed-over' | 'asked' | 'driving'>
> = {
  'surface.opened': 'opened',
  'surface.takeover': 'taken-over',
  'surface.handback': 'handed-back',
  'surface.handed': 'handed-over',
  'surface.asked': 'asked',
  'surface.driving': 'driving',
};

/**
 * Browsers' daemon half (§2.3; today's `bin/modules/browser.ts` and its `fyd.ts` wiring): the machine's ONE agent
 * Chrome and the worker PROCESS that drives it (`kernel.spawn`, as today), the pages each ferret holds, the viewer stream,
 * the human sign-in window, the proxy test and state, surface control, and the browser tools. Every page act goes
 * through `kernel.act` with its `Op`; page text, addresses and titles are read under `kernel.redaction` (S16).
 */
export default implementDaemon(manifest, { build: ctx => buildBrowsers(ctx) });

/** What a test may stand in for when it builds the half (`../tests/unit/daemon.test.ts`); the daemon passes nothing. */
export interface BrowsersSeams {
  /** Starts the agent browser; by default Chrome and the worker process, both through `kernel.spawn`. */
  readonly launcher?: BrowserSessionLauncher;
  /** Who each page signs in; by default a fresh ledger on the kernel clock. */
  readonly identities?: TypedIdentities;
  /** Hands one address to the operating system's opener; by default `open`, `xdg-open` or `rundll32` through `kernel.spawn`. */
  readonly opener?: DetachedLauncherPort;
}

/** The daemon half, composed once: every piece below is built here and nowhere else. */
export function buildBrowsers(
  ctx: DaemonContext<typeof manifest>,
  seams: BrowsersSeams = {},
): DaemonHalf<typeof manifest> {
  const { kernel } = ctx;
  const vault = ctx.needs.vault;
  const host = processHost();
  const config = (): BrowsersConfig | undefined =>
    kernel.config.file(manifest.data.config[0] as ConfigFileDef<BrowsersConfig>);
  const which = (name: string) => () => host.which(name);
  // The sign-in window's and the private display's processes and time: kernel.spawn and the kernel clock.
  const processes = {
    spawn: kernel.spawn,
    clock: kernel.clock,
    platform: host.platform,
    environment: host.environment,
  };

  // ── the agent browser and its worker ─────────────────────────────────────────────────────────────────────────
  const profile = new BrowserProfileStore(host.stateDirectory);
  const display = new XvfbDisplay({
    executable: which('Xvfb'),
    authorityDirectory: profile.displayDirectory,
    processes,
  });
  // The worker is a process of its own, as today (lead decision, port-browsers r1): the compiled worker beside the
  // daemon, or Node over the source entry, started through kernel.spawn under a name permissions.spawn declares.
  const command = workerCommand(host.workerProgram(), host.which('node'));
  const startWorker: StartWorker = (args, env) => {
    if ('refused' in command) throw new Error(command.refused);
    return kernel.spawn.start(command.program, [...command.args, ...args], { env });
  };
  const launcher =
    seams.launcher ??
    new NodeSessionBrowserLauncher(
      profile,
      startWorker,
      { clock: kernel.clock, spawn: kernel.spawn, fetch: kernel.fetch, host },
      host.environment,
      undefined,
      {
        workerRefusal: () => ('refused' in command ? command.refused : undefined),
        mode: async () => config()?.mode ?? 'headless',
        // GAP: the Vault has no port that hands Browsers a proxy credential (use, never read), so a proxy that
        // names `${secret:…}` credentials refuses the launch rather than going around the proxy.
        proxy: async () => {
          const setting = config()?.proxy;
          return setting === undefined ? undefined : resolveBrowserProxy(setting, new Map());
        },
        display,
        stageDirectory: host.stageDirectory,
        // GAP (card F1931, finding 10): no `ports`, `checkFirewall` or `limits` (today's fyd.ts 8728-8736).
        // - `ports`/`checkFirewall`: 5.0 serves Browsers no read of the machine's `browserPorts` or
        //   `browserFirewallFailure` (Runtimes keeps them, no contract serves them), so every launch takes random
        //   ports. That fails safe: nothing is bound at a fixed port, so there is nothing for the loopback firewall to
        //   fence and nothing for its check to refuse.
        // - `limits`: there is no kernel ferret-limits port that wraps a program in the shared browser slice, so the
        //   agent Chrome runs outside the shared browser memory slice docs/ferret-limits.md promises.
      },
    );
  // Who each page signs in, in memory only (I154): ONE ledger, cleared by the runtime whenever an act may have changed
  // it, whoever made it (I155), and read and written by every browser tool.
  const identities = seams.identities ?? new TypedIdentities(() => kernel.clock.nowMs());
  const pages = new BrowserSessionService(
    {
      get: async sessionId => {
        const ferret = await ctx.uses.ferrets.current()?.get(sessionId as FerretId);
        return ferret === undefined ? undefined : { name: ferret.name };
      },
    },
    launcher,
    () => kernel.clock.nowMs(),
    {
      timeoutMs: BROWSER_IDLE_TIMEOUT_MS,
      after: (delay, action) => ({ cancel: kernel.clock.after(milliseconds(delay), action) }),
    },
    identities,
    // A page closed, however it closed (a tool, the toolbar, the session's end, the browser stopping): a wake-up.
    {
      closed: (sessionId, pageId) =>
        kernel.events.publish(PageChanged, { ferret: sessionId, page: pageId, change: 'closed' }),
    },
  );
  const viewerHost = heldViewerHost(kernel, pages);
  const stream: BrowserStreamOpener = async (sessionId, downstream) => {
    let viewer: BrowserViewerStream | undefined;
    return {
      open: async () => {
        viewer = await BrowserViewerStream.connect(
          viewerHost,
          sessionId,
          downstream,
          new KernelFrameClock(kernel.clock),
        );
      },
      fromClient: frame => viewer?.fromClient(frame),
      close: () => viewer?.close(),
    };
  };

  // ── the human sign-in window ─────────────────────────────────────────────────────────────────────────────────
  const loginRuntime = new NodeBrowserLoginRuntime({
    display,
    processes,
    secretsDirectory: profile.browserDirectory,
    x11vncExecutable: which('x11vnc'),
    timeoutExecutable: which('timeout'),
    ports: async () => ({ kind: 'random' }),
    chromeOverride: () => host.environment.FY_CHROME_BIN,
  });
  const login = new BrowserLoginWindowService({
    profile,
    runtime: loginRuntime,
    closeAgentBrowsers: async () => await pages.closeAll(),
  });

  // ── the proxy test and state ─────────────────────────────────────────────────────────────────────────────────
  const tester = new BrowserProxyTester({
    saved: async () => config()?.proxy,
    // GAP: as above, no Vault port reads a proxy credential for Browsers; a proxy with credentials tests as `secret`.
    secrets: async () => new Map(),
    probe: new TunnelProxyProbe({ clock: kernel.clock }),
    now: () => kernel.clock.nowMs(),
  });

  // ── surface control and the tools ────────────────────────────────────────────────────────────────────────────
  const history = new Map<string, RecordedSurfaceEvent[]>();
  const control = new SurfaceControl(
    {
      publish: async (sessionId, type, data) => {
        history.set(sessionId, [...(history.get(sessionId) ?? []), { type, data }]);
        const change = PAGE_CHANGES[type];
        const page = (data as { readonly id?: unknown }).id;
        if (change !== undefined && typeof page === 'string')
          kernel.events.publish(PageChanged, { ferret: sessionId, page, change });
      },
      history: async sessionId => history.get(sessionId) ?? [],
    },
    { now: () => kernel.clock.nowMs() },
  );
  const tools = new BrowserTools({
    browser: pages,
    control,
    kernel,
    // GAP: "What agents may control" is Ferrets' machine switches and no port reads them yet. Browsers is on (an
    // enabled Browsers plugin is the owner's yes); Files and Page scripts, off by default today, fail closed.
    policy: { allows: async kind => kind === 'browser' },
    files: rootFiles(kernel.roots, nodeStagedFiles(host.uploadDirectory, kernel.clock)),
    binaryName: 'fy',
    typedIdentities: identities,
    // Where page scripts ran and what a ferret did to a page, told to the Vault's sign-in lock (lead DECISIONS-2 #5,
    // I98–I100; today's `scriptedOrigins` and `loginActs`).
    scriptedOrigins: {
      running: () => vault.scriptRunning?.() ?? (() => undefined),
      scriptedOn: scriptHost => vault.scriptedOn?.(scriptHost),
    },
    pageActs: { acted: (sessionId, script) => vault.pageActed?.(sessionId as FerretId, script) },
  });
  // The `page` input target and the four tools that type into a page or hand it over, on the same checks as the rest.
  const target = pageTarget({
    kernel,
    pages,
    host: pageToolHost(tools),
    identities,
    vault,
    acts: { acted: (ferret, script) => vault.pageActed?.(ferret, script) },
  });

  // ── handing a link to this computer's own browser (G27) ──────────────────────────────────────────────────────
  const openUrl = new OpenUrlService({
    launcher: seams.opener ?? new KernelDetachedLauncher(kernel.spawn, host.environment),
    audit: { record: async draft => await ctx.needs.gate.audit(draft) },
    nowMs: () => kernel.clock.nowMs(),
    platform: host.platform,
  });

  kernel.lifecycle.onStop(async () => {
    await pages.closeAll().catch(() => undefined);
    await loginRuntime.close().catch(() => undefined);
  });

  return {
    routes: {
      ...pageRoutes(kernel, login, pages),
      ...proxyRoutes({ tester, state: () => pages.overview() }),
      ...controlRoutes(tools),
      ...systemOpenRoutes(openUrl),
    },
    sockets: { 'GET /v1/sessions/:sessionId/browser/stream': streamSocket(pages, stream) },
    tools: { ...toolHandlers(tools), ...target.tools },
    provides: {
      browsers: {
        state: async () => pages.overview(),
        pagesOf: async ferret => {
          const status = await pages.status(ferret);
          return status.pages.map(page => ({
            id: page.id,
            ...(page.name === undefined ? {} : { name: page.name }),
            ...(page.incognito === true ? { incognito: true as const } : {}),
          }));
        },
        // The Warden's remedy for a browser left under a ferret's pane: its tree read again now, through Terminals.
        closeLeftoverBrowsers: async ferret =>
          await closeLeftoverBrowsers(ferret, {
            terminals: () => ctx.uses.terminals.current(),
            terminate: spawnTerminate(kernel.spawn),
          }),
      },
    },
    hooks: {
      'input.targets:page': target.adapter,
      'reference.catalog:%browser': new BrowsersReferenceMenu(pages, kernel.redaction),
    },
  };
}
