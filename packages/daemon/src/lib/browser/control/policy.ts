import {
  BROWSER_MAX_HEIGHT,
  BROWSER_MAX_WIDTH,
  BROWSER_MIN_HEIGHT,
  BROWSER_MIN_WIDTH,
  type BrowserMode,
  type BrowserViewport,
} from '@ferretry/protocol';

export const browserLoginDefaultMinutes = 15;
export const browserLoginMaximumMinutes = 60;
export const browserLoginUrl = 'https://accounts.google.com/';
export const vncSupervisorKillAfterSeconds = 10;

const vncPasswordAlphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const vncPasswordLength = 8;

export class BrowserControlError extends Error {
  constructor(
    readonly code: 'bad_request' | 'launch_failed',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserControlError';
  }
}

/** Rejects URL schemes Chrome can use to execute local or active content. */
export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new BrowserControlError('bad_request', 'a URL is required');
  const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed);
  const candidate = loopback
    ? `http://${trimmed}`
    : /^[a-z][a-z\d+.-]*:/i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new BrowserControlError('bad_request', `invalid browser URL: ${trimmed}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.href !== 'about:blank') {
    throw new BrowserControlError('bad_request', 'browser navigation supports only HTTP(S) URLs and about:blank');
  }
  return url.href;
}

/**
 * Keeps browser process environments narrow and makes display ownership explicit.
 *
 * `authority` is the Xauthority file holding the cookie the private display demands. It is set
 * explicitly and never inherited: the host's own `XAUTHORITY` belongs to the operator's desktop, and
 * a client without this one is refused by the display.
 */
export function browserEnvironment(
  display: string | undefined,
  source: Readonly<Record<string, string | undefined>>,
  authority?: string,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const key of [
    'PATH',
    'HOME',
    'FONTCONFIG_FILE',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
  ]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  if (display !== undefined) result.DISPLAY = display;
  if (authority !== undefined) result.XAUTHORITY = authority;
  return result;
}

/**
 * What the daemon may look at to find a browser beyond the fixed install locations: the home
 * directory (per-user macOS apps), the PATH the daemon itself was given (Nix profiles, Homebrew
 * on Linux), and which package managers exist — the last one only to name the right install
 * command when no browser is found at all.
 */
export interface ChromeSearch {
  readonly home?: string;
  readonly path?: string;
  readonly available?: (command: string) => boolean;
}

const LINUX_CHROME_NAMES = ['google-chrome', 'google-chrome-stable'] as const;
const LINUX_CHROMIUM_NAMES = ['chromium', 'chromium-browser'] as const;

/**
 * Every place a browser may be, GOOGLE CHROME FIRST: the real, installed Google Chrome is the browser a
 * site sees every day, so it wins over a Chromium build wherever each was found — a Chromium in
 * `/usr/bin` no longer shadows a Google Chrome on PATH. Chromium is the fallback, never the preference.
 */
export function chromeExecutableCandidates(
  platform: NodeJS.Platform,
  override?: string,
  search: ChromeSearch = {},
): readonly string[] {
  if (override?.trim()) return [override.trim()];
  if (platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const chromium = '/Applications/Chromium.app/Contents/MacOS/Chromium';
    return search.home
      ? [chrome, `${search.home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, chromium]
      : [chrome, chromium];
  }
  const directories = (search.path ?? '')
    .split(':')
    .filter(directory => directory.startsWith('/'))
    .map(directory => directory.replace(/\/+$/, ''));
  const named = (names: readonly string[]): readonly string[] =>
    directories.flatMap(directory => names.map(name => `${directory}/${name}`));
  return [
    ...new Set([
      ...LINUX_CHROME_NAMES.map(name => `/usr/bin/${name}`),
      '/opt/google/chrome/chrome',
      ...named(LINUX_CHROME_NAMES),
      ...LINUX_CHROMIUM_NAMES.map(name => `/usr/bin/${name}`),
      '/snap/bin/chromium',
      ...named(LINUX_CHROMIUM_NAMES),
    ]),
  ];
}

/**
 * The ONE command that installs a browser here, chosen from the package managers this machine has.
 * Ordered so the first match is the one that works: Ubuntu ships `chromium` only as a snap, so snap
 * outranks apt; every Linux manager below installs a Chromium the candidate list then finds.
 */
export function chromeInstallCommand(
  platform: NodeJS.Platform,
  available: (command: string) => boolean,
): string | undefined {
  if (platform === 'darwin') return 'brew install --cask google-chrome';
  const managers: readonly (readonly [string, string])[] = [
    ['snap', 'sudo snap install chromium'],
    ['apt-get', 'sudo apt-get install -y chromium'],
    ['dnf', 'sudo dnf install -y chromium'],
    ['pacman', 'sudo pacman -S --noconfirm chromium'],
    ['zypper', 'sudo zypper install -y chromium'],
    ['nix', 'nix profile install nixpkgs#chromium'],
  ];
  return managers.find(([manager]) => available(manager))?.[1];
}

export function selectChromeExecutable(
  platform: NodeJS.Platform,
  override: string | undefined,
  exists: (candidate: string) => boolean,
  search: ChromeSearch = {},
): string {
  const selected = chromeExecutableCandidates(platform, override, search).find(exists);
  if (selected) return selected;
  if (override?.trim()) {
    throw new BrowserControlError('launch_failed', `FY_CHROME_BIN points at ${override.trim()}, which does not exist.`);
  }
  const command = chromeInstallCommand(platform, search.available ?? (() => false));
  throw new BrowserControlError(
    'launch_failed',
    command === undefined
      ? 'Chrome is not installed on this machine: install Google Chrome or Chromium, or set FY_CHROME_BIN to its path.'
      : `Chrome is not installed on this machine: install it with \`${command}\`, or set FY_CHROME_BIN to its path.`,
  );
}

export interface ChromeLaunchOptions {
  /**
   * Where Chrome opens its DevTools protocol for the agent browser's worker ({@link CdpEndpoint}); the pipe
   * unless told otherwise. `false` opens none: the login window, which a person drives by hand.
   */
  readonly cdp?: CdpEndpoint | false;
  readonly initialUrl?: string;
  /**
   * Run without a window. Defaults to headless everywhere but Linux, where the browser draws into the
   * daemon-owned X display so the operator and the screencast see the same pixels; a Linux daemon
   * with NO display (a server, an SSH-only box) runs it headless instead of failing to start it.
   */
  readonly headless?: boolean;
  /**
   * Keep every window painting while it is not the focused one. A HEADED browser stops rendering a
   * window that is hidden, occluded or in the background, and the agent browser opens each page in a
   * window of its own — every one of which an agent may be driving, and a person watching, at once.
   */
  readonly keepPainting?: boolean;
  /** The user agent to send in place of the one a HEADLESS Chrome reports (`honestChromeUserAgent`). */
  readonly userAgent?: string;
  /** Send the browser's traffic through this proxy (docs/browser-proxy.md). */
  readonly proxy?: { readonly server: string; readonly bypass: readonly string[] };
}

/**
 * The DevTools PIPE: Chrome reads requests on its fd 3 and writes replies and events on its fd 4, and only the
 * daemon and the worker it hands the other ends to hold them.
 *
 * Unlike a debugging port it has no address. The protocol has no authentication at all, so a
 * `--remote-debugging-port` — even one bound to 127.0.0.1 — is a full remote control of the owner's signed-in
 * profile for every account on the host: any local user can connect to it and read cookies, run script in any
 * page, or drive a session. Picking a free port first does not help either, because another user can take it
 * between the probe and Chrome's own bind and serve a fake endpoint the worker would then trust. A pipe has
 * nothing to find, connect to or squat; the file descriptors are inherited, and nobody else has them.
 */
export const CDP_PIPE_SWITCH = '--remote-debugging-pipe';

/**
 * How the agent browser's worker reaches Chrome's DevTools protocol, and what each costs:
 *
 * - `pipe` ({@link CDP_PIPE_SWITCH}) — reachable by nobody else on the host; Chrome reports
 *   `navigator.webdriver === true` to every page.
 * - `port` — a loopback port: `navigator.webdriver` stays `false`, and every account on the host can drive
 *   the profile through it.
 */
export type CdpTransport = 'pipe' | 'port';

/** Where Chrome opens its DevTools protocol: the pipe, or a loopback port with this number. */
export type CdpEndpoint = { readonly kind: 'pipe' } | { readonly kind: 'port'; readonly port: number };

/**
 * The transport when the machine names none. Linux is where one host is shared by several accounts, so it
 * gets the pipe nobody else can reach; a Mac is one person's desktop, where the port's `navigator.webdriver`
 * of `false` is worth more than a boundary between accounts it does not have.
 */
export function defaultCdpTransport(platform: NodeJS.Platform): CdpTransport {
  return platform === 'linux' ? 'pipe' : 'port';
}

function cdpArguments(endpoint: CdpEndpoint | false): readonly string[] {
  if (endpoint === false) return [];
  if (endpoint.kind === 'pipe') return [CDP_PIPE_SWITCH];
  return ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${endpoint.port}`];
}

/**
 * Switches Ferretry would pass to ANNOUNCE automation (`--enable-automation`: the "controlled by automated
 * test software" bar) or to HIDE it (the `AutomationControlled` blink switch, which turns
 * `navigator.webdriver` back off). NEITHER kind is ever passed, so the browser a site meets is the Chrome it
 * is — not a disguised one. Named so the tests can hold every mode to it. `--enable-automation` is also what
 * a driver such as Playwright adds by default when IT launches Chrome, which is one reason the daemon
 * launches Chrome itself.
 *
 * {@link CDP_PIPE_SWITCH} is deliberately NOT one of them: it is the TRANSPORT, the only one no other account
 * on the host can reach. It is not invisible, and this says so rather than pretend: Chrome itself turns on
 * `navigator.webdriver` for any browser started with the DevTools pipe, so every page the agent browser opens
 * reads `navigator.webdriver === true` (over the loopback port it stays `false`: {@link CdpTransport}). That is
 * Chrome telling the truth about a browser that IS driven — the honest-client rule is about what Ferretry
 * adds or hides, and the answer is still nothing.
 */
export const AUTOMATION_SWITCH_PATTERN = /^--(?:enable-automation|disable-blink-features=.*AutomationControlled)/;

export function chromeLaunchArguments(
  executable: string,
  profile: string,
  viewport: BrowserViewport,
  platform: NodeJS.Platform,
  options: ChromeLaunchOptions = {},
): readonly string[] {
  const headless = options.headless ?? platform !== 'linux';
  const arguments_ = [
    executable,
    ...(headless ? ['--headless=new'] : []),
    `--user-data-dir=${profile}`,
    ...cdpArguments(options.cdp ?? { kind: 'pipe' }),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter',
    ...(options.userAgent === undefined ? [] : [`--user-agent=${options.userAgent}`]),
    ...(options.proxy === undefined ? [] : chromeProxyArguments(options.proxy.server, options.proxy.bypass)),
    '--disable-dev-shm-usage',
    ...(options.keepPainting === true
      ? [
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling',
        ]
      : []),
    ...(platform === 'linux'
      ? [
          '--no-sandbox',
          ...(headless ? [] : ['--ozone-platform=x11']),
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
        ]
      : []),
    '--force-device-scale-factor=1',
    `--window-size=${viewport.width},${viewport.height}`,
    options.initialUrl ?? 'about:blank',
  ];
  if (platform === 'linux') arguments_.splice(arguments_.length - 1, 0, '--password-store=basic');
  return arguments_;
}

export function browserLoginChromeArguments(
  executable: string,
  profile: string,
  platform: NodeJS.Platform,
): readonly string[] {
  return chromeLaunchArguments(
    executable,
    profile,
    { width: BROWSER_MAX_WIDTH, height: BROWSER_MAX_HEIGHT },
    platform,
    { cdp: false, initialUrl: browserLoginUrl },
  );
}

export function loginWindowMinutes(value?: number): number {
  if (value === undefined) return browserLoginDefaultMinutes;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > browserLoginMaximumMinutes) {
    throw new BrowserControlError(
      'bad_request',
      `the login window duration must be a whole number of minutes between 1 and ${browserLoginMaximumMinutes}`,
    );
  }
  return value;
}

export function x11vncLaunchArguments(
  executable: string,
  display: string,
  port: number,
  passwordFile: string,
  timeoutSeconds: number,
): readonly string[] {
  return [
    executable,
    '-display',
    display,
    '-rfbport',
    String(port),
    '-listen',
    '127.0.0.1',
    '-localhost',
    '-noipv6',
    '-passwdfile',
    `rm:${passwordFile}`,
    '-once',
    '-timeout',
    String(Math.max(1, Math.round(timeoutSeconds))),
    '-noremote',
    '-nocmds',
    '-nolookup',
    '-quiet',
  ];
}

export function vncSupervisorArguments(
  timeoutExecutable: string,
  windowSeconds: number,
  x11vncArguments: readonly string[],
  killAfterSeconds = vncSupervisorKillAfterSeconds,
): readonly string[] {
  return [
    timeoutExecutable,
    '--signal=TERM',
    `--kill-after=${Math.max(1, Math.round(killAfterSeconds))}`,
    String(Math.max(1, Math.round(windowSeconds))),
    ...x11vncArguments,
  ];
}

export function generateVncPassword(randomValues: (buffer: Uint8Array) => Uint8Array): string {
  const limit = Math.floor(256 / vncPasswordAlphabet.length) * vncPasswordAlphabet.length;
  let password = '';
  while (password.length < vncPasswordLength) {
    for (const byte of randomValues(new Uint8Array(vncPasswordLength))) {
      if (byte >= limit) continue;
      password += vncPasswordAlphabet[byte % vncPasswordAlphabet.length];
      if (password.length === vncPasswordLength) break;
    }
  }
  return password;
}

export function normalizeViewport(width: number, height: number): BrowserViewport {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new BrowserControlError('bad_request', 'browser viewport dimensions must be finite');
  }
  return {
    width: Math.min(BROWSER_MAX_WIDTH, Math.max(BROWSER_MIN_WIDTH, Math.round(width))),
    height: Math.min(BROWSER_MAX_HEIGHT, Math.max(BROWSER_MIN_HEIGHT, Math.round(height))),
  };
}

/**
 * The platform token Chrome puts in its own user agent on this OS — the form Chrome has frozen since user-agent
 * reduction, which does not change with the OS release. `undefined` for an OS or CPU this daemon does not run
 * Chrome on, where the browser is left to say what it says rather than be given a guess.
 */
export function chromePlatformToken(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7';
  if (platform === 'win32') return arch === 'x64' ? 'Windows NT 10.0; Win64; x64' : undefined;
  if (platform !== 'linux') return undefined;
  const machine = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined;
  return machine === undefined ? undefined : `X11; Linux ${machine}`;
}

/**
 * The user agent THIS Chrome sends when it is not headless: the browser's own major version (what
 * `chrome --version` prints) in the platform token of the OS it is running on. A headless Chrome sends the same
 * string with `HeadlessChrome` in place of `Chrome`, and that token is the only difference — its client hints
 * (`Sec-CH-UA`) already name Google Chrome — so removing the token is all this does. It never names another
 * browser, device or operating system. `undefined` when the version or OS is not recognised.
 */
export function honestChromeUserAgent(
  versionOutput: string,
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  const major = /(\d+)\.\d+\.\d+\.\d+/u.exec(versionOutput)?.[1];
  const token = chromePlatformToken(platform, arch);
  if (major === undefined || token === undefined) return undefined;
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** The switches that send Chrome's traffic to `server` and keep WebRTC from reaching around it. */
export function chromeProxyArguments(server: string, bypass: readonly string[]): readonly string[] {
  return [
    `--proxy-server=${server}`,
    ...(bypass.length === 0 ? [] : [`--proxy-bypass-list=${bypass.join(';')}`]),
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
}

/** What a launch adds to the agent browser beyond its mode. */
export interface AgentBrowserExtras {
  /** The honest user agent for a headless Chrome ({@link honestChromeUserAgent}); a real window ignores it. */
  readonly userAgent?: string;
  readonly proxy?: { readonly server: string; readonly bypass: readonly string[] };
  /** Where the worker reaches the DevTools protocol; the pipe when absent. */
  readonly cdp?: CdpEndpoint;
}

/**
 * The machine's one agent browser, launched in the mode `machine.yaml` names (docs/browser-mode.md).
 *
 * - `headless` — no window anywhere: what agents get by default, and the only thing a server with no
 *   display can run.
 * - `window` — a real, headed Chrome: on Linux it draws into the private X display the launcher hands it
 *   (`DISPLAY`), on macOS it is a real window on the owner's desktop. No `--headless`, so the page sees the
 *   browser's own user agent rather than `HeadlessChrome` and renders the way a desktop Chrome does.
 *
 * Both open the DevTools protocol where `extras.cdp` says — the private pipe unless told otherwise
 * ({@link CdpTransport}): it is what the view streams and the agent tools drive through. Neither passes an
 * automation switch ({@link AUTOMATION_SWITCH_PATTERN}).
 *
 * `extras` (docs/browser-proxy.md): a headless browser gets the honest user agent, which is the one it would send
 * with a window — `HeadlessChrome` removed and nothing else changed; and a configured proxy adds its switches.
 */
export function agentBrowserArguments(
  executable: string,
  profile: string,
  viewport: BrowserViewport,
  platform: NodeJS.Platform,
  mode: BrowserMode,
  extras: AgentBrowserExtras = {},
): readonly string[] {
  return chromeLaunchArguments(executable, profile, viewport, platform, {
    headless: mode === 'headless',
    keepPainting: mode === 'window',
    // Only a headless Chrome says "Headless" about itself; a real window already sends the ordinary token.
    ...(mode === 'headless' && extras.userAgent !== undefined ? { userAgent: extras.userAgent } : {}),
    ...(extras.proxy === undefined ? {} : { proxy: extras.proxy }),
    ...(extras.cdp === undefined ? {} : { cdp: extras.cdp }),
  });
}

/** What to install for the private display a Linux `window` browser draws into, from this host's managers. */
export function xvfbInstallCommand(available: (command: string) => boolean): string | undefined {
  const managers: readonly (readonly [string, string])[] = [
    ['apt-get', 'sudo apt-get install -y xvfb'],
    ['dnf', 'sudo dnf install -y xorg-x11-server-Xvfb'],
    ['pacman', 'sudo pacman -S --noconfirm xorg-server-xvfb'],
    ['zypper', 'sudo zypper install -y xvfb-run'],
    ['nix', 'nix profile install nixpkgs#xvfb'],
  ];
  return managers.find(([manager]) => available(manager))?.[1];
}

/**
 * The refusal a Linux `window` browser gives on a host with no Xvfb: one sentence naming the fix — install
 * it, or go back to headless — rather than a Chrome that fails to open a display.
 */
export function xvfbMissingMessage(available: (command: string) => boolean): string {
  const command = xvfbInstallCommand(available);
  const install = command === undefined ? 'install Xvfb' : `install it with \`${command}\``;
  return `Browser mode is Real window, which needs Xvfb on Linux and this host has none: ${install}, or set Browser mode back to Headless.`;
}
