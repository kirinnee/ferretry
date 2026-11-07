import {
  type BrowserProxySetting,
  type BrowserProxyStatus,
  secretReferencePattern,
  secretReferencesIn,
} from '@ferretry/protocol';
import { BrowserControlError } from '../control/policy.ts';

export type ProxyScheme = 'http' | 'https' | 'socks5';

/** Where a proxy listens, read from its configured address. */
export interface ProxyEndpoint {
  readonly scheme: ProxyScheme;
  readonly host: string;
  readonly port: number;
}

const DEFAULT_PORTS: Readonly<Record<ProxyScheme, number>> = { http: 80, https: 443, socks5: 1080 };

/** Reads an address the setting's schema already accepted. */
export function proxyEndpoint(url: string): ProxyEndpoint {
  const parsed = new URL(url);
  const scheme = parsed.protocol.slice(0, -1) as ProxyScheme;
  const host = parsed.hostname.replace(/^\[(.*)\]$/u, '$1');
  return { scheme, host, port: parsed.port === '' ? DEFAULT_PORTS[scheme] : Number(parsed.port) };
}

/** What the browser pane shows about a running browser's proxy: the address and whether it signs in, never a credential. */
export function browserProxyStatus(setting: BrowserProxySetting): BrowserProxyStatus {
  return {
    url: setting.url,
    authenticated: setting.username !== undefined,
    bypassCount: setting.bypass.length,
  };
}

/** The proxy a launch uses: the setting, and the credentials its `${secret:NAME}` references name, resolved. */
export interface ResolvedBrowserProxy {
  readonly setting: BrowserProxySetting;
  readonly credentials?: { readonly username: string; readonly password: string };
}

/**
 * Puts the secrets a proxy setting names behind it, at the moment a browser starts. A secret the store does not
 * hold REFUSES the launch, naming it: a browser that started without the proxy's credentials would either fail
 * every page with an opaque tunnel error or, worse, go direct around a proxy its owner asked for.
 */
export function resolveBrowserProxy(
  setting: BrowserProxySetting,
  values: ReadonlyMap<string, string>,
): ResolvedBrowserProxy {
  if (setting.username === undefined || setting.password === undefined) return { setting };
  const names = [...new Set([...secretReferencesIn(setting.username), ...secretReferencesIn(setting.password)])];
  const missing = names.filter(name => !values.has(name));
  if (missing.length > 0) {
    throw new BrowserControlError(
      'launch_failed',
      `The browser proxy needs ${missing.length === 1 ? 'a secret' : 'secrets'} this machine does not hold: ${missing.join(', ')}. Store ${missing.length === 1 ? 'it' : 'each'} with \`fy secret set ${missing[0]}\`, or turn the browser proxy off.`,
    );
  }
  const read = (reference: string): string =>
    reference.replace(secretReferencePattern(), (_match, name: string) => values.get(name) ?? '');
  return { setting, credentials: { username: read(setting.username), password: read(setting.password) } };
}
