import { BrowserProxySettingSchema, type BrowserProxySetting } from '../../../contract/index.ts';
import { flag, UsageError, wholeNumber } from '../args.ts';
import type { Plan, VerbSpec } from '../plan.ts';
import { onMachine, onThisHost } from './define.ts';

/** The files a host admin installs, exactly as the repository ships them. */
export interface FirewallFiles {
  readonly script: string;
  readonly unit: string;
  readonly verifyUnit: string;
  readonly timer: string;
}

const withoutFinalNewline = (text: string): string => (text.endsWith('\n') ? text.slice(0, -1) : text);

/** What `browser firewall entry` says: the one verb with no 5.0 route to ask. */
export const FIREWALL_ENTRY_GAP =
  'browser firewall entry cannot print the line yet: it is built from the machine’s browserPorts setting, and browserPorts is read across plugins, which the browsers plugin has no route for in this build (a declared gap). Ask the host admin to read it from the machine view, or write the line from docs/loopback-firewall.md by hand';

/** A local shape check only. The daemon owns the maximum duration and re-validates every request. */
function minutes(raw: string): number {
  const value = wholeNumber(raw, '--minutes');
  if (value < 1) throw new UsageError('--minutes must be at least 1');
  return value;
}

const FLAG_OF_FIELD = { username: '--username-secret', password: '--password-secret' } as const;

/**
 * The proxy to try, or `undefined` for "the saved one". The setting is built and checked by the schema the daemon
 * and the app use, so a bad address is refused here with the same sentence, before any round trip. A flag value is
 * only ever a secret NAME; it is wrapped as `${secret:NAME}`, and one that is not a name (a pasted password, say) is
 * refused by the schema without being echoed.
 */
function proxySetting(flags: {
  readonly url?: string | undefined;
  readonly bypass?: string | undefined;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
}): BrowserProxySetting | undefined {
  const url = flags.url?.trim() ?? '';
  const bypass = (flags.bypass ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '');
  const username = flags.username?.trim() ?? '';
  const password = flags.password?.trim() ?? '';
  if (url === '') {
    if (bypass.length > 0 || username !== '' || password !== '')
      throw new UsageError('--bypass, --username-secret and --password-secret need --url');
    return undefined;
  }
  const parsed = BrowserProxySettingSchema.safeParse({
    url,
    bypass,
    ...(username === '' ? {} : { username: `\${secret:${username}}` }),
    ...(password === '' ? {} : { password: `\${secret:${password}}` }),
  });
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path[0];
  const label = field === 'username' || field === 'password' ? `${FLAG_OF_FIELD[field]}: ` : '';
  throw new UsageError(`${label}${issue?.message ?? 'this proxy setting is not valid'}`);
}

/**
 * The machine's browser: the human sign-in window and the proxy test (daemon-global, owner only, so no `--ferret`),
 * and the loopback firewall's files for a host admin (printed from what the binary carries, no daemon).
 */
export function machineVerbs(files: FirewallFiles) {
  /** `login close` is v4's other spelling of `login stop`: the same row under a second declared verb. */
  const loginStop = onMachine([], { primed: flag.on('primed') }, words => ({
    kind: 'login',
    body: { action: 'stop', ...(words.on('primed') ? { primed: true } : {}) },
  }));
  const print = (text: string) => onThisHost([], {}, (): Plan => ({ kind: 'print', text: withoutFinalNewline(text) }));
  return {
    'browser login status': onMachine([], {}, (): Plan => ({ kind: 'login' })),
    'browser login start': onMachine([], { minutes: flag.text('minutes', 'm') }, words => {
      const raw = words.text('minutes');
      return { kind: 'login', body: { action: 'start', ...(raw === undefined ? {} : { minutes: minutes(raw) }) } };
    }),
    'browser login confirm': onMachine([], {}, (): Plan => ({ kind: 'login', body: { action: 'confirm' } })),
    'browser login stop': loginStop,
    'browser login close': loginStop,
    'browser proxy test': onMachine(
      [],
      {
        url: flag.text('url'),
        bypass: flag.text('bypass'),
        usernameSecret: flag.text('username-secret'),
        passwordSecret: flag.text('password-secret'),
      },
      (words): Plan => {
        const proxy = proxySetting({
          url: words.text('url'),
          bypass: words.text('bypass'),
          username: words.text('usernameSecret'),
          password: words.text('passwordSecret'),
        });
        return { kind: 'proxy-test', ...(proxy === undefined ? {} : { proxy }) };
      },
    ),
    'browser firewall entry': onThisHost([], {}, (): Plan => ({ kind: 'refuse', message: FIREWALL_ENTRY_GAP })),
    'browser firewall script': print(files.script),
    'browser firewall unit': print(files.unit),
    'browser firewall verify-unit': print(files.verifyUnit),
    'browser firewall timer': print(files.timer),
  } as const satisfies Record<string, VerbSpec>;
}
