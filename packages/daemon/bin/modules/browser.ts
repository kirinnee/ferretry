import {
  BrowserLoginWindowService,
  BrowserProfileStore,
  NodeBrowserLoginRuntime,
  SystemFrameClock,
  TunnelProxyProbe,
  XvfbDisplay,
} from '../../src/adapters/index.ts';
import type { ResolvedBrowserPorts } from '@ferretry/protocol';
import {
  BrowserProxyTester,
  type BrowserLoginLifecycle,
  type BrowserSessionLauncher,
  BrowserSessionService,
  BrowserViewerStream,
  type CopyPageHost,
  type FoundationPaths,
  type PageInputHost,
} from '../../src/lib/index.ts';
import type { BrowserProxyTestPorts } from '../../src/lib/browser/proxy/index.ts';
import type { BrowserPairingSource, BrowserSessionDirectory } from '../../src/lib/browser/runtime/service.ts';
import type { BrowserSignInWatch } from '../../src/lib/browser/runtime/sign-in-watch.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { browserContribution } from '../../src/lib/runtime/mounts/browser.ts';
import type { BrowserMountedSubsystem } from '../../src/lib/runtime/mounts/browser-login.ts';
import type { BrowserProxySubsystem } from '../../src/lib/runtime/mounts/browser-proxy.ts';

/**
 * The agent's browser: one host per daemon over a session-keyed page runtime, the human sign-in window's routes, and the
 * machine-wide proxy test and state.
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams`: the two production adapters
 * `DaemonWorld` carries for it, the sign-in window (`browserLogin`) and what starts a session's browser
 * (`browserLauncher`), reach `createSubsystems` as parameters, so they are needs. It has no jobs armed by `start()` and
 * no releases: the worker spawn and the sign-in window's teardown are kernel cleanups (`start()` registers
 * `browserLogin.close` and the agent browser's display release), and the session service holds no timer until a page
 * opens (the idle stop is armed by the first act, never by the build).
 *
 * THREE LATE BINDINGS, all in `fyd.ts`: the sign-in window must close the agent browsers that hold the shared profile
 * (built before the state home is opened), a stopped ferret releases its browser's pages (built before this module), and
 * the secure copy and the input requests reach a page through the host (built before this module). They are one
 * {@link LateBound} of {@link BrowserProvides}, filled on the line after the build, and each reader keeps its own
 * early-read answer: the first two do nothing, the page readers say "the agent browser is not running yet".
 *
 * ONE CONSTRUCTION POINT: `createSubsystems` builds the module where the browser service was always made. The proxy
 * tester sat in the final mounted object, after the service; it is a constructor over four ports with no work of its
 * own, so building it a little early is inert.
 */

/**
 * The human login window and the teardown of everything it put on the host.
 *
 * TWO members rather than one, because the window's own lifecycle contract has no release: `start`
 * and `stop` are a person's intent about one sign-in, and the X display outlives any single window by
 * design (see `XvfbDisplay`). So the intent goes on the route and the release goes to `cleanups`.
 */
export interface BrowserLoginWorld {
  readonly window: BrowserLoginLifecycle;
  readonly close: () => Promise<void>;
}

/**
 * The human browser-login window, over the daemon's own private profile and a private X display.
 *
 * ONE PROFILE for the whole daemon, inside the state home. It is the artefact the window exists to
 * produce: a person signs in once, the profile is marked primed, and every later browser run reuses
 * the cookies that sign-in left. The store keeps its lease, its Chrome pid and its primed marker
 * beside the profile, so a second window — or a crashed daemon's leftovers — is refused rather than
 * corrupting it.
 *
 * THE SECRET FILE SHARES THE PROFILE'S DIRECTORY rather than a temp path. x11vnc reads the password
 * once and deletes it (`-passwdfile rm:`), but between the write and that read it is a live
 * credential on disk, and the browser directory is the daemon's own 0700 tree.
 *
 * EVERY EXECUTABLE IS A PATH LOOKUP AT THE POINT OF USE, matching `executables` above: a host that
 * installs x11vnc after the daemon booted must be able to open a window without a restart, and a host
 * that has none refuses with a sentence naming what is missing rather than spawning whatever answers
 * to the name.
 */
export function createBrowserLoginWorld(
  paths: FoundationPaths,
  closeAgentBrowsers: () => Promise<void>,
  ports: () => Promise<ResolvedBrowserPorts>,
): BrowserLoginWorld {
  const profile = new BrowserProfileStore(paths.home);
  const which = (name: string) => () => Bun.which(name, { PATH: process.env.PATH }) ?? undefined;
  const runtime = new NodeBrowserLoginRuntime({
    display: new XvfbDisplay({ executable: which('Xvfb'), authorityDirectory: profile.displayDirectory }),
    secretsDirectory: profile.browserDirectory,
    x11vncExecutable: which('x11vnc'),
    timeoutExecutable: which('timeout'),
    ports,
    // The operator's explicit Chrome, honoured ahead of this platform's candidate list. The domain
    // names the variable in its own refusal, so the name is read here rather than invented.
    chromeOverride: () => process.env.FY_CHROME_BIN,
  });
  return {
    window: new BrowserLoginWindowService({ profile, runtime, closeAgentBrowsers }),
    close: async () => await runtime.close(),
  };
}

/** A session browser nobody watches or drives stops after this long, so a forgotten one does not hold the one shared profile away from every other session. */
const BROWSER_IDLE_TIMEOUT_MS = 15 * 60_000;

/** What the browser module is built from. */
export interface BrowserNeeds {
  /** The session directory a page is checked against (and grouped under the ferret's name from). */
  readonly sessions: BrowserSessionDirectory;
  /** What starts a session's browser: a Chrome and the browser worker (the world's `browserLauncher`). */
  readonly launcher: BrowserSessionLauncher;
  /** The daemon-global human sign-in window (the world's `browserLogin.window`). */
  readonly login: BrowserLoginLifecycle;
  /** Who a page is signing in, as the ferret typed it, dropped on every act that may have changed it. */
  readonly signIns: BrowserSignInWatch;
  /**
   * What the browser guard reads of pairing, beyond every page: whether a code is live (the pairing service tells it) and
   * which origins are Ferretry's app. The pairing screen's refusal stands on this, not on anything a page can write.
   */
  readonly pairing: BrowserPairingSource;
  /** The saved browser proxy and the secret store's values, which a proxy test reads. */
  readonly proxy: Pick<BrowserProxyTestPorts, 'saved' | 'secrets'>;
  /** Whether the loopback firewall fences this daemon's fixed browser ports; `undefined` while they are random. */
  readonly firewall: NonNullable<BrowserProxySubsystem['firewall']>;
}

/** What other code may use from the browser module. */
export interface BrowserProvides {
  /** The host the routes, the sockets and the agent tools address: the same instance in each. */
  readonly host: BrowserMountedSubsystem;
  /** The same runtime, as the secure copy and the input requests reach a page through it. */
  readonly pages: PageInputHost & CopyPageHost;
}

export const browserModule: DaemonModule<void, BrowserNeeds, BrowserProvides> = {
  id: 'browser',
  build: needs => {
    const browserService = new BrowserSessionService(
      needs.sessions,
      needs.launcher,
      () => Date.now(),
      {
        timeoutMs: BROWSER_IDLE_TIMEOUT_MS,
        after: (milliseconds, action) => {
          const timer = setTimeout(action, milliseconds);
          return { cancel: () => clearTimeout(timer) };
        },
      },
      // Who a page is signing in, as the ferret typed it, is dropped by the runtime itself on every act that may have
      // changed it, whoever made it: the toolbar route, the live view, the agent tools, an act that failed partway.
      needs.signIns,
      needs.pairing,
    );
    const browserHost: BrowserMountedSubsystem = {
      ...browserService,
      status: browserService.status.bind(browserService),
      act: browserService.act.bind(browserService),
      attachViewer: browserService.attachViewer.bind(browserService),
      dispatchHumanInput: browserService.dispatchHumanInput.bind(browserService),
      releaseSession: browserService.releaseSession.bind(browserService),
      openPage: browserService.openPage.bind(browserService),
      actOnPage: browserService.actOnPage.bind(browserService),
      filesOnPage: browserService.filesOnPage.bind(browserService),
      scriptOnPage: browserService.scriptOnPage.bind(browserService),
      closePage: browserService.closePage.bind(browserService),
      lifecycleOnPage: browserService.lifecycleOnPage.bind(browserService),
      inputOnPage: browserService.inputOnPage.bind(browserService),
      adoptPage: browserService.adoptPage.bind(browserService),
      closeAll: browserService.closeAll.bind(browserService),
      stream: async (sessionId, downstream) => {
        let viewer: BrowserViewerStream | undefined;
        return {
          open: async () => {
            viewer = await BrowserViewerStream.connect(browserService, sessionId, downstream, new SystemFrameClock());
          },
          fromClient: frame => viewer?.fromClient(frame),
          close: () => viewer?.close(),
        };
      },
    };
    return {
      id: 'browser',
      provides: { host: browserHost, pages: browserService },
      jobs: {},
      contributes: browserContribution({
        browserLogin: needs.login,
        browser: browserHost,
        browserProxy: {
          tester: new BrowserProxyTester({
            saved: needs.proxy.saved,
            secrets: needs.proxy.secrets,
            probe: new TunnelProxyProbe(),
            now: () => performance.now(),
          }),
          state: () => browserService.overview(),
          firewall: needs.firewall,
        },
      }),
    };
  },
};
