/**
 * The locale variables this CLI reads from its caller, and the only ones it ever hands the daemon.
 *
 * Listed in the order the C library consults them, so the first one set is the one in effect.
 */
const LOCALE_VARIABLES = ['LC_ALL', 'LC_CTYPE', 'LANG'] as const;

type LocaleVariable = (typeof LOCALE_VARIABLES)[number];

/** The caller's locale variables, exactly as its environment holds them. */
export type CallerLocale = Readonly<Partial<Record<LocaleVariable, string | undefined>>>;

function isUtf8(value: string): boolean {
  return /utf-?8/iu.test(value);
}

/**
 * A UTF-8 locale that exists on a stock install of the platform.
 *
 * macOS ships no `C.UTF-8`, and a locale that does not exist is the same as none at all.
 */
function platformUtf8Locale(platform: string): string {
  return platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
}

/**
 * The locale the daemon runs under — always a UTF-8 one.
 *
 * The daemon starts the terminal multiplexer server that hosts every session pane, and that server
 * and every agent inside it inherit this environment. Without a UTF-8 locale the multiplexer
 * rewrites every tab and non-ASCII byte it prints as `_`, and an agent's interface loses its
 * unicode. A service manager hands a daemon no locale at all, and `fy daemon start` used to hand it
 * only `FY_HOME` and `PATH`, so every session launched that way failed.
 *
 * The caller's own variables are forwarded when the one in effect is UTF-8, so a person's language
 * choice reaches their agents. Otherwise the platform's UTF-8 locale is used alone: forwarding a
 * non-UTF-8 `LC_ALL` would override it and bring the breakage back. Nothing else is forwarded; the
 * daemon's environment stays deliberately small.
 */
export function daemonLocale(platform: string, caller: CallerLocale): Readonly<Record<string, string>> {
  const forwarded: Record<string, string> = {};
  for (const name of LOCALE_VARIABLES) {
    const value = caller[name];
    if (value) forwarded[name] = value;
  }
  const inEffect = LOCALE_VARIABLES.map(name => forwarded[name]).find(value => value !== undefined);
  return inEffect !== undefined && isUtf8(inEffect) ? forwarded : { LANG: platformUtf8Locale(platform) };
}
