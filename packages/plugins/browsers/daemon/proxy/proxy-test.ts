import type {
  BrowserProxyErrorClass,
  BrowserProxySetting,
  BrowserProxyTestRequest,
  BrowserProxyTestResult,
} from '@ferretry/protocol';
import { BrowserControlError } from '../control/policy.ts';
import { type ProxyEndpoint, proxyEndpoint, resolveBrowserProxy } from './endpoint.ts';

/** The one neutral HTTPS endpoint a test asks: it answers with nothing but the address the request came from. */
export const PROBE_DESTINATION = { host: 'api64.ipify.org', port: 443 } as const;

/** The failures a probe can tell apart on the wire; `secret` and `no-proxy` are decided before anything is dialled. */
export type ProbeFailure = Exclude<BrowserProxyErrorClass, 'secret' | 'no-proxy'>;

export type ProbeOutcome =
  | { readonly ok: true; readonly egressIp: string }
  | { readonly ok: false; readonly errorClass: ProbeFailure };

/** One short-lived request to the test endpoint, through `endpoint`, signing in with `credentials` when given. */
export interface ProxyProbe {
  run(request: {
    readonly endpoint: ProxyEndpoint;
    readonly credentials?: { readonly username: string; readonly password: string };
  }): Promise<ProbeOutcome>;
}

export interface BrowserProxyTestPorts {
  /** The proxy saved in this machine's configuration, or nothing. */
  readonly saved: () => Promise<BrowserProxySetting | null | undefined>;
  /** The secret store's values; they are read here and go no further than the probe. */
  readonly secrets: () => Promise<ReadonlyMap<string, string>>;
  readonly probe: ProxyProbe;
  /** A monotonic clock in milliseconds. */
  readonly now: () => number;
}

const FAILURE_WORDS: Readonly<Record<ProbeFailure, string>> = {
  dns: "The proxy's host name did not resolve, or the proxy could not look up the test endpoint.",
  connect: "Nothing accepted a connection at the proxy's address.",
  auth: 'The proxy refused the username and password.',
  tls: 'The secure connection through the proxy failed.',
  timeout: 'The proxy did not answer in time.',
  proxy: 'The proxy answered, but would not open the connection.',
  other: 'The test did not get an answer through the proxy.',
};

/**
 * "Test proxy": opens one throwaway connection through the saved proxy (or the one being edited) and reports what
 * came back. Nothing here is kept, and nothing returned carries a credential, a header, the proxy's address or
 * the test endpoint's URL: a result is a class, a sentence, a time and the address the endpoint saw.
 */
export class BrowserProxyTester {
  constructor(private readonly ports: BrowserProxyTestPorts) {}

  async test(request: BrowserProxyTestRequest): Promise<BrowserProxyTestResult> {
    const tested = request.proxy === undefined ? 'saved' : 'unsaved';
    const setting = request.proxy ?? (await this.ports.saved()) ?? undefined;
    if (setting === undefined) {
      return {
        reachable: false,
        tested,
        errorClass: 'no-proxy',
        message: 'No browser proxy is saved, and none was given to test.',
      };
    }
    let resolved: ReturnType<typeof resolveBrowserProxy>;
    try {
      resolved = resolveBrowserProxy(setting, await this.ports.secrets());
    } catch (error) {
      if (!(error instanceof BrowserControlError)) throw error;
      return { reachable: false, tested, errorClass: 'secret', message: error.message };
    }
    const started = this.ports.now();
    const outcome = await this.ports.probe.run({
      endpoint: proxyEndpoint(setting.url),
      ...(resolved.credentials === undefined ? {} : { credentials: resolved.credentials }),
    });
    const roundTripMs = Math.max(0, Math.round(this.ports.now() - started));
    if (outcome.ok) {
      return {
        reachable: true,
        tested,
        roundTripMs,
        egressIp: outcome.egressIp,
        message: 'The proxy carried a request to the test endpoint, which saw it come from the address shown.',
      };
    }
    const wantedSignIn = outcome.errorClass === 'auth' && resolved.credentials === undefined;
    return {
      reachable: false,
      tested,
      errorClass: outcome.errorClass,
      roundTripMs,
      message: wantedSignIn
        ? 'The proxy wants a username and password, and none are set.'
        : FAILURE_WORDS[outcome.errorClass],
    };
  }
}

/** What a socket error means for a person, from the codes Node and its TLS stack give. */
export function classifyNetworkError(error: unknown): ProbeFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA' || code === 'EAI_NONAME') return 'dns';
  if (code === 'ETIMEDOUT' || message === 'timed out') return 'timeout';
  if (
    code.startsWith('ERR_TLS') ||
    code.startsWith('ERR_SSL') ||
    code.includes('CERT') ||
    code.includes('SELF_SIGNED') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  )
    return 'tls';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) return 'connect';
  return 'other';
}

/** What the test endpoint's HTTP reply said: its status and its body, with a chunked body put back together. */
export function parseProbeReply(text: string): { readonly status: number; readonly body: string } | undefined {
  const end = text.indexOf('\r\n\r\n');
  const status = /^HTTP\/\d(?:\.\d)? (\d{3})/u.exec(text)?.[1];
  if (end < 0 || status === undefined) return undefined;
  const head = text.slice(0, end).toLowerCase();
  const raw = text.slice(end + 4);
  if (!/transfer-encoding:\s*chunked/u.test(head)) return { status: Number(status), body: raw.trim() };
  let body = '';
  let rest = raw;
  for (;;) {
    const line = rest.indexOf('\r\n');
    const size = line < 0 ? Number.NaN : Number.parseInt(rest.slice(0, line), 16);
    if (!Number.isInteger(size) || size === 0) break;
    body += rest.slice(line + 2, line + 2 + size);
    rest = rest.slice(line + 2 + size + 2);
  }
  return { status: Number(status), body: body.trim() };
}
