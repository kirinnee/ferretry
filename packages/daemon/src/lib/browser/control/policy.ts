import {
  BROWSER_MAX_HEIGHT,
  BROWSER_MAX_WIDTH,
  BROWSER_MIN_HEIGHT,
  BROWSER_MIN_WIDTH,
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

/** Keeps browser process environments narrow and makes display ownership explicit. */
export function browserEnvironment(
  display: string | undefined,
  source: Readonly<Record<string, string | undefined>>,
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

const LINUX_BROWSER_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'] as const;

export function chromeExecutableCandidates(
  platform: NodeJS.Platform,
  override?: string,
  search: ChromeSearch = {},
): readonly string[] {
  if (override?.trim()) return [override.trim()];
  if (platform === 'darwin') {
    const system = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    return search.home
      ? [...system, `${search.home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`]
      : system;
  }
  const fixed = [...LINUX_BROWSER_NAMES.map(name => `/usr/bin/${name}`), '/snap/bin/chromium'];
  const onPath = (search.path ?? '')
    .split(':')
    .filter(directory => directory.startsWith('/'))
    .flatMap(directory => LINUX_BROWSER_NAMES.map(name => `${directory.replace(/\/+$/, '')}/${name}`));
  return [...new Set([...fixed, ...onPath])];
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
  readonly cdp?: boolean;
  readonly initialUrl?: string;
  /**
   * Run without a window. Defaults to headless everywhere but Linux, where the browser draws into the
   * daemon-owned X display so the operator and the screencast see the same pixels; a Linux daemon
   * with NO display (a server, an SSH-only box) runs it headless instead of failing to start it.
   */
  readonly headless?: boolean;
}

export function chromeLaunchArguments(
  executable: string,
  profile: string,
  cdpPort: number,
  viewport: BrowserViewport,
  platform: NodeJS.Platform,
  options: ChromeLaunchOptions = {},
): readonly string[] {
  const cdp = options.cdp !== false;
  const headless = options.headless ?? platform !== 'linux';
  const arguments_ = [
    executable,
    ...(headless ? ['--headless=new'] : []),
    `--user-data-dir=${profile}`,
    ...(cdp ? ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter',
    '--disable-dev-shm-usage',
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
    0,
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
