/**
 * What one Test of an environment login sends, decided before anything is sent (docs/provider-presets.md).
 *
 * The preset says how its provider is tested; the login supplies the values. This turns the two into
 * exactly one request, or a sentence saying why there is none — and it is the only place that decides
 * WHERE a key may be sent:
 *
 * - **A key goes only where the login already sends it, or where a built-in preset says.** The host
 *   of the request must be the host of one of the login's own `https://` values (its base URL), or a
 *   host the built-in preset wrote literally. A preset file of this machine's own cannot name a new
 *   host for a key: it is configuration an agent may be able to edit, and the Test must never be the
 *   way a key reaches somewhere the CLI would not send it.
 * - **A placeholder in the host is a host name, nothing more.** `https://{RESOURCE}.services.ai.azure.com`
 *   takes one DNS label from the login, so the request stays under the domain the preset named.
 * - **A placeholder that is the whole base is the login's own address**, which must be `https://` (or
 *   `http://` to this machine) with no credentials in it.
 * - **The key is a whole `${secret:NAME}`.** A template around a reference (`Bearer ${secret:X}`) is a
 *   login the CLI understands and this Test does not, so it is not tested rather than guessed at.
 *
 * Pure.
 */
import {
  type Credential,
  isCredentialSafeUrl,
  type PresetTest,
  type ProviderPreset,
  templatePlaceholders,
} from '@ferretry/fleet';
import { isLoopbackHost, SECRET_REFERENCE_SOURCE, type SecretName } from '@ferretry/protocol';
import type { CredentialPlacement, OutboundHttpRequest } from '../speedups/ports.ts';

/** How long a Test waits for the provider. */
export const PROVIDER_PROBE_TIMEOUT_MS = 10_000;

/** A model list or a balance is a few kilobytes; a 2xx past this still proves the key. */
export const PROVIDER_PROBE_MAX_BYTES = 512 * 1_024;

/** One Test, ready to send. */
export type ProviderProbePlan =
  | {
      /** Through the outbound holder: the named secret on one request to one host. */
      readonly kind: 'authorized';
      readonly secretName: SecretName;
      readonly hosts: readonly string[];
      readonly request: OutboundHttpRequest;
      readonly placement: CredentialPlacement;
      /** `one-token` when the request is an inference. */
      readonly spends: 'nothing' | 'one-token';
    }
  | {
      /** No key: one read of a server on this machine. */
      readonly kind: 'local';
      readonly request: OutboundHttpRequest;
      readonly spends: 'nothing';
    };

/** Why there is no plan: `not_testable` is how the login is, `refused` is a request that would go astray. */
export type ProviderProbeRefusal = { readonly code: 'not_testable' | 'refused'; readonly reason: string };

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
/** Exactly one secret reference and nothing around it. */
const WHOLE_REFERENCE = new RegExp(`^${SECRET_REFERENCE_SOURCE}$`, 'u');

const refusal = (code: ProviderProbeRefusal['code'], reason: string): ProviderProbeRefusal => ({ code, reason });

/** A login's plain value for a placeholder: present, and no secret inside it. */
function plainValue(env: Readonly<Record<string, string>>, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value.length === 0 || value.includes('$')) return undefined;
  return value;
}

/** The hosts the login itself sends to: every one of its plain values that is a key-safe URL. */
export function loginHosts(env: Readonly<Record<string, string>>): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const value of Object.values(env)) {
    if (value.includes('$') || !isCredentialSafeUrl(value)) continue;
    hosts.add(new URL(value).host.toLowerCase());
  }
  return hosts;
}

/**
 * The URL a template makes with this login's values, and whether its host came from the preset's own
 * text (a literal host, or a literal domain under a one-label placeholder) or from the login.
 */
function resolveUrl(
  template: string,
  env: Readonly<Record<string, string>>,
): { readonly url: string; readonly hostFromPreset: boolean } | ProviderProbeRefusal {
  const names = templatePlaceholders(template);
  for (const name of names) {
    if (plainValue(env, name) === undefined) return refusal('not_testable', `Fill in ${name} first, then Test.`);
  }
  const whole = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/u.exec(template);
  if (whole !== null) {
    const base = (plainValue(env, whole[1] as string) as string).replace(/\/+$/u, '');
    if (!isCredentialSafeUrl(base) || new URL(base).username !== '' || new URL(base).password !== '') {
      return refusal('refused', `${whole[1]} must be an https:// address (plain http only on this machine) to Test.`);
    }
    const rest = template.slice(whole[0].length);
    if (templatePlaceholders(rest).length > 0) return refusal('refused', 'This preset’s Test address cannot be built.');
    return { url: `${base}${rest}`, hostFromPreset: false };
  }
  for (const name of names) {
    if (!DNS_LABEL.test(plainValue(env, name) as string)) {
      return refusal('refused', `${name} must be a plain name — letters, digits and dashes — to Test.`);
    }
  }
  return {
    url: template.replace(PLACEHOLDER, (_, name: string) => plainValue(env, name) as string),
    hostFromPreset: true,
  };
}

/** A body template filled with the login's values, each JSON-escaped. */
function resolveBody(template: string, env: Readonly<Record<string, string>>): string | ProviderProbeRefusal {
  for (const name of templatePlaceholders(template)) {
    if (plainValue(env, name) === undefined) return refusal('not_testable', `Fill in ${name} first, then Test.`);
  }
  return template.replace(PLACEHOLDER, (_, name: string) =>
    JSON.stringify(plainValue(env, name) as string).slice(1, -1),
  );
}

const isRefusal = (value: unknown): value is ProviderProbeRefusal =>
  typeof value === 'object' && value !== null && 'code' in value && 'reason' in value;

/** The one request a Test of this login sends, or why it sends none. */
export function planProviderProbe(
  preset: ProviderPreset,
  credential: Credential,
): ProviderProbePlan | ProviderProbeRefusal {
  const test: PresetTest = preset.test;
  const env = credential.env ?? {};
  if (test.kind === 'none') return refusal('not_testable', test.reason);
  if (test.kind === 'local') {
    const parsed = new URL(test.url);
    if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname)) {
      return refusal('refused', 'A test without a key may only read a server on this machine.');
    }
    return {
      kind: 'local',
      spends: 'nothing',
      request: {
        method: 'GET',
        url: test.url,
        headers: { accept: 'application/json' },
        timeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
        maxResponseBytes: PROVIDER_PROBE_MAX_BYTES,
      },
    };
  }
  const reference = env[test.keyVariable];
  const whole = reference === undefined ? null : WHOLE_REFERENCE.exec(reference);
  if (whole === null) {
    return refusal(
      'not_testable',
      reference === undefined
        ? `This login has no ${test.keyVariable}, so there is no key to Test.`
        : `${test.keyVariable} is not a single \${secret:NAME}, so the Test cannot tell which key it is.`,
    );
  }
  const url = resolveUrl(test.url, env);
  if (isRefusal(url)) return url;
  const host = new URL(url.url).host.toLowerCase();
  const allowed = loginHosts(env).has(host) || (url.hostFromPreset && preset.origin === 'built-in');
  if (!allowed) {
    return refusal(
      'refused',
      `This Test would send the key to ${host}, which is not where this login sends it. Only a built-in preset may name another address.`,
    );
  }
  const body = test.kind === 'inference' ? resolveBody(test.body, env) : undefined;
  if (isRefusal(body)) return body;
  return {
    kind: 'authorized',
    secretName: whole[1] as SecretName,
    hosts: [host],
    spends: test.kind === 'inference' ? 'one-token' : 'nothing',
    placement: { header: test.header, ...(test.scheme === '' ? {} : { scheme: test.scheme }) },
    request: {
      method: test.kind === 'inference' ? 'POST' : 'GET',
      url: url.url,
      headers: { accept: 'application/json', ...test.headers },
      ...(body === undefined ? {} : { body }),
      timeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
      maxResponseBytes: PROVIDER_PROBE_MAX_BYTES,
    },
  };
}
