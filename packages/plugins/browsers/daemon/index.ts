import type { ConfigFileDef, FerretId } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { type BrowsersConfig, PageChanged } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { BrowserSessionService } from './pages/service.ts';
import { type BrowserStreamOpener, pageRoutes, streamSocket } from './pages/routes.ts';
import { BrowserProxyTester, resolveBrowserProxy } from './proxy/index.ts';
import { TunnelProxyProbe } from './proxy/adapters/probe.ts';
import { proxyRoutes } from './proxy/routes.ts';
import { KernelFrameClock } from './stream/frame-clock.ts';
import { heldViewerHost } from './stream/held-host.ts';
import { BrowserViewerStream } from './stream/viewer-stream.ts';
// ── part b registers the `page` input target, its holds and challenges here (`../target/index.ts`) ──────────────
import { pageTarget } from './target/index.ts';
import { nodeStagedFiles } from './tools/adapters/staged-files.ts';
import { SurfaceControl } from './tools/control.ts';
import { rootFiles } from './tools/files.ts';
import { controlRoutes, toolHandlers } from './tools/index.ts';
import { BrowserTools } from './tools/service.ts';
import type { RecordedSurfaceEvent } from './tools/types.ts';
import { processHost } from './worker/adapters/host.ts';
import { BrowserLoginWindowService } from './worker/control/adapters/login-window.ts';
import { NodeBrowserLoginRuntime, XvfbDisplay } from './worker/control/adapters/login-runtime.ts';
import { BrowserProfileStore } from './worker/control/adapters/profile-store.ts';
import { NodeSessionBrowserLauncher } from './worker/launcher.ts';

/** A browser nobody watches or drives stops after this long, so a forgotten one does not hold the one shared profile. */
const BROWSER_IDLE_TIMEOUT_MS = 15 * 60_000;

/** `surface.*` event types mapped onto the published `PageChanged` change (a wake-up; the port is the truth). */
const PAGE_CHANGES: Readonly<Record<string, 'opened' | 'taken-over' | 'handed-back' | 'handed-over' | 'asked'>> = {
  'surface.opened': 'opened',
  'surface.takeover': 'taken-over',
  'surface.handback': 'handed-back',
  'surface.handed': 'handed-over',
  'surface.asked': 'asked',
};

/**
 * Browsers' daemon half (§2.3; today's `bin/modules/browser.ts` and its `fyd.ts` wiring): the machine's ONE agent
 * Chrome and the Bun worker thread that drives it (`kernel.workers`), the pages each ferret holds, the viewer stream,
 * the human sign-in window, the proxy test and state, surface control, and the browser tools. Every page act goes
 * through `kernel.act` with its `Op`; page text, addresses and titles are read under `kernel.redaction` (S16).
 */
export default implementDaemon(manifest, {
  build: ctx => {
    const { kernel } = ctx;
    const host = processHost();
    const config = (): BrowsersConfig | undefined =>
      kernel.config.file(manifest.data.config[0] as ConfigFileDef<BrowsersConfig>);
    const which = (name: string) => () => host.which(name);

    // ── the agent browser and its worker ─────────────────────────────────────────────────────────────────────────
    const profile = new BrowserProfileStore(host.stateDirectory);
    const display = new XvfbDisplay({ executable: which('Xvfb'), authorityDirectory: profile.displayDirectory });
    const launcher = new NodeSessionBrowserLauncher(
      profile,
      () => kernel.workers.start(new URL('./worker/main.ts', import.meta.url), { name: 'browser' }),
      kernel.clock,
      host.environment,
      undefined,
      {
        mode: async () => config()?.mode ?? 'headless',
        // GAP: the Vault has no port that hands Browsers a proxy credential (use, never read), so a proxy that
        // names `${secret:…}` credentials refuses the launch rather than going around the proxy.
        proxy: async () => {
          const setting = config()?.proxy;
          return setting === undefined ? undefined : resolveBrowserProxy(setting, new Map());
        },
        display,
        stageDirectory: host.stageDirectory,
      },
    );
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
    );
    const viewerHost = heldViewerHost(kernel, pages);
    const stream: BrowserStreamOpener = async (sessionId, downstream) => {
      let viewer: BrowserViewerStream | undefined;
      return {
        open: async () => {
          viewer = await BrowserViewerStream.connect(viewerHost, sessionId, downstream, new KernelFrameClock(kernel.clock));
        },
        fromClient: frame => viewer?.fromClient(frame),
        close: () => viewer?.close(),
      };
    };

    // ── the human sign-in window ─────────────────────────────────────────────────────────────────────────────────
    const loginRuntime = new NodeBrowserLoginRuntime({
      display,
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
      probe: new TunnelProxyProbe(),
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
    });
    // ── part b: `pageTarget` answers the `page` input target and its four tools; spread below. ──────────────────────
    const target = pageTarget({ kernel, pages, tools });

    kernel.lifecycle.onStop(async () => {
      await pages.closeAll().catch(() => undefined);
      await loginRuntime.close().catch(() => undefined);
    });

    return {
      routes: {
        ...pageRoutes(kernel, login, pages),
        ...proxyRoutes({ tester, state: () => pages.overview() }),
        ...controlRoutes(tools),
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
        },
      },
      hooks: { 'input.targets:page': target.adapter },
    };
  },
});
