/**
 * The two addresses a sign-in turns on: the redirect the PWA asks for, and the address the browser came
 * back to. Pure.
 *
 * ## THE CALLBACK ADDRESS IS A CREDENTIAL, AND IT PASSES THROUGH
 *
 * It carries an authorization code. {@link checkCallback} reads it, checks it STRICTLY against the flow
 * it claims to finish, and answers the code alone — and no refusal it answers with names any part of
 * it. This is `fleet-login/codex-link.ts`'s rule, for the same reason.
 */

import { isLoopbackHost, MCP_OAUTH_CALLBACK_PATH } from '@ferretry/protocol';
import { sameText } from './pkce.ts';

/**
 * The PWA's callback address, normalised, or `undefined` when it is not one.
 *
 * HTTPS on any host — the hosted PWA, a self-hosted one — or plain HTTP on this machine for a PWA
 * served locally; always exactly {@link MCP_OAUTH_CALLBACK_PATH}, with no query, fragment or
 * credentials. The caller chose it, and the caller already holds `fleet.configure`: the code it
 * receives is useless without the verifier, which never leaves the daemon.
 */
export function pwaRedirectUri(raw: string): string | undefined {
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
  if (!secure || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined;
  if (url.pathname !== MCP_OAUTH_CALLBACK_PATH) return undefined;
  return `${url.origin}${url.pathname}`;
}

/** What the callback is checked against: fields of the flow it claims to finish. */
export interface CallbackExpectation {
  readonly redirectUri: string;
  readonly state: string;
  readonly issuer: string;
  /** The provider advertised `authorization_response_iss_parameter_supported`: `iss` must be present. */
  readonly requireIss: boolean;
}

/** What became of a callback address: the code to redeem, or why not — never the address. */
export type CallbackCheck =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'refused'; readonly reason: string };

const refused = (reason: string): CallbackCheck => ({ kind: 'refused', reason });

/** The keys a provider's redirect may carry. `iss` is RFC 9207; `session_state` is OpenID's. */
const CALLBACK_KEYS: ReadonlySet<string> = new Set(['code', 'state', 'iss', 'scope', 'session_state']);
const ERROR_KEYS: ReadonlySet<string> = new Set(['error', 'error_description', 'error_uri', 'state', 'iss']);

/** An OAuth `code` or `state` is printable ASCII with no spaces. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,2048}$/u;

/** The provider's error codes this flow says something specific about (RFC 6749 §4.1.2.1). */
const PROVIDER_ERRORS: Readonly<Record<string, string>> = {
  access_denied: 'The sign-in was declined at the provider. Start again if that was a mistake.',
  invalid_scope: 'The provider would not grant the access this server asks for.',
  unauthorized_client: 'The provider does not let Ferretry sign in this way.',
};

/**
 * Check a pasted or delivered address against the flow, and answer the code.
 *
 * The address must have the redirect's exact origin and path, no credentials and no fragment; its query
 * may hold only what a provider's redirect holds, each once; `state` must be this flow's; `iss`, when a
 * provider sends it, must be this flow's issuer (RFC 9207's mix-up defence).
 */
export function checkCallback(pasted: string, expected: CallbackExpectation): CallbackCheck {
  const value = pasted.trim();
  if (!URL.canParse(value)) {
    return refused('That is not a web address. Copy the whole address from the browser’s address bar.');
  }
  const url = new URL(value);
  const redirect = new URL(expected.redirectUri);
  if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) {
    return refused(`That address is not the one this sign-in is waiting for. It starts with ${expected.redirectUri}.`);
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    return refused('That address has parts a sign-in never has. Copy it again, exactly as the browser shows it.');
  }
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) {
    return refused('That address has parts a sign-in never has. Copy it again, exactly as the browser shows it.');
  }
  const state = url.searchParams.get('state');
  if (state === null || !sameText(state, expected.state)) {
    return refused(
      'That address belongs to a different sign-in attempt. Use the link on this screen, then paste the address it leads to.',
    );
  }
  const error = url.searchParams.get('error');
  if (error !== null) {
    if (!keys.every(key => ERROR_KEYS.has(key)))
      return refused('That address has parts a sign-in never has. Copy it again, exactly as the browser shows it.');
    return refused(PROVIDER_ERRORS[error] ?? 'The provider says that sign-in did not finish. Start again.');
  }
  if (!keys.every(key => CALLBACK_KEYS.has(key))) {
    return refused('That address has parts a sign-in never has. Copy it again, exactly as the browser shows it.');
  }
  const issuer = url.searchParams.get('iss');
  if (issuer === null && expected.requireIss) {
    return refused('That address does not say which sign-in provider sent it, so it cannot be trusted. Start again.');
  }
  if (issuer !== null && issuer.replace(/\/+$/u, '') !== expected.issuer.replace(/\/+$/u, '')) {
    return refused('That address came back from a different sign-in provider. Start again.');
  }
  const code = url.searchParams.get('code');
  if (code === null || !TOKEN_SHAPE.test(code)) {
    return refused(
      'That address has no sign-in code in it. Copy the whole address, including everything after the “?”.',
    );
  }
  return { kind: 'code', code };
}
