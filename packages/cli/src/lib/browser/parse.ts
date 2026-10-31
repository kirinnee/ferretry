import {
  BROWSER_MAX_HEIGHT,
  BROWSER_MAX_WIDTH,
  BROWSER_MIN_HEIGHT,
  BROWSER_MIN_WIDTH,
  type BrowserProxySetting,
  BrowserProxySettingSchema,
} from '@ferretry/protocol';
import { BrowserCommandError } from './types.ts';

function wholeNumber(raw: string, label: string): number {
  const value = Number(raw);
  if (!raw.trim() || !Number.isInteger(value)) throw new BrowserCommandError(`${label} must be a whole number`);
  return value;
}

/**
 * A local shape check only. The daemon owns the maximum duration, and it re-validates every
 * request; kteam mirrored that bound into the CLI, where it could silently drift out of date.
 */
export function parseLoginMinutes(raw: string): number {
  const minutes = wholeNumber(raw, '--minutes');
  if (minutes < 1) throw new BrowserCommandError('--minutes must be at least 1');
  return minutes;
}

/**
 * Viewport bounds come from `@ferretry/protocol`, the same definition the daemon validates against,
 * so a rejected size is reported before a round trip rather than as an opaque 400.
 */
export function parseViewport(rawWidth: string, rawHeight: string): { width: number; height: number } {
  const width = wholeNumber(rawWidth, 'width');
  const height = wholeNumber(rawHeight, 'height');
  if (width < BROWSER_MIN_WIDTH || width > BROWSER_MAX_WIDTH) {
    throw new BrowserCommandError(`width must be between ${BROWSER_MIN_WIDTH} and ${BROWSER_MAX_WIDTH}`);
  }
  if (height < BROWSER_MIN_HEIGHT || height > BROWSER_MAX_HEIGHT) {
    throw new BrowserCommandError(`height must be between ${BROWSER_MIN_HEIGHT} and ${BROWSER_MAX_HEIGHT}`);
  }
  return { width, height };
}

/** Rejects an argument that is present but blank, which commander accepts and the daemon will not. */
export function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new BrowserCommandError(`${label} is required`);
  return trimmed;
}

/** An optional positional: blank and absent mean the same thing — "not given". */
export const optionalText = (value: string | undefined): string | undefined => value?.trim() || undefined;

/** The flags of `fy browser proxy test`; credentials are secret NAMES, never values. */
export interface ProxyTestFlags {
  readonly url?: string | undefined;
  readonly bypass?: string | undefined;
  readonly usernameSecret?: string | undefined;
  readonly passwordSecret?: string | undefined;
}

const FLAG_OF_FIELD = { username: '--username-secret', password: '--password-secret' } as const;

/**
 * The proxy to try, or `undefined` for "the saved one". The setting is built and checked by the same
 * schema the daemon and the app use, so a bad address is refused here with the same sentence, before any
 * round trip. A flag value is only ever a secret NAME; it is wrapped as `${secret:NAME}`, and one that is
 * not a name (a pasted password, say) is refused by the schema without being echoed.
 */
export function parseProxyTestFlags(flags: ProxyTestFlags): BrowserProxySetting | undefined {
  const url = flags.url?.trim() ?? '';
  const bypass = (flags.bypass ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '');
  const username = flags.usernameSecret?.trim() ?? '';
  const password = flags.passwordSecret?.trim() ?? '';
  if (url === '') {
    if (bypass.length > 0 || username !== '' || password !== '') {
      throw new BrowserCommandError('--bypass, --username-secret and --password-secret need --url');
    }
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
  const flag = field === 'username' || field === 'password' ? `${FLAG_OF_FIELD[field]}: ` : '';
  throw new BrowserCommandError(`${flag}${issue?.message ?? 'this proxy setting is not valid'}`);
}
