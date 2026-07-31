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

export function chromeExecutableCandidates(platform: NodeJS.Platform, override?: string): readonly string[] {
  if (override?.trim()) return [override.trim()];
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

export function selectChromeExecutable(
  platform: NodeJS.Platform,
  override: string | undefined,
  exists: (candidate: string) => boolean,
): string {
  const selected = chromeExecutableCandidates(platform, override).find(exists);
  if (selected) return selected;
  throw new BrowserControlError(
    'launch_failed',
    `Google Chrome was not found for ${platform}; configure FY_CHROME_BIN`,
  );
}

export interface ChromeLaunchOptions {
  readonly cdp?: boolean;
  readonly initialUrl?: string;
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
  const arguments_ = [
    executable,
    ...(platform === 'linux' ? [] : ['--headless=new']),
    `--user-data-dir=${profile}`,
    ...(cdp
      ? ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*']
      : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter',
    '--disable-dev-shm-usage',
    ...(platform === 'linux'
      ? [
          '--no-sandbox',
          '--ozone-platform=x11',
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
