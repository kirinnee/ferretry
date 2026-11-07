/**
 * Registering this daemon as a client with an MCP server's authorization server (RFC 7591), the way the
 * clients these servers are built for get registered. Pure: the metadata each attempt sends, what an
 * answer means, which attempt to make next, and the words a failure is said in (`docs/mcp-oauth.md`).
 *
 * ## The ladder
 *
 * The first attempt is what Claude Code sends — a public client (`token_endpoint_auth_method: none`)
 * with the code and refresh grants and, when the server named one, its scope. A provider that answers
 * a `4xx` is asked again, a few ways at most ({@link MAX_REGISTRATION_ATTEMPTS}), each changing one
 * thing ({@link nextRegistrationAttempt}): the client authentication method when the provider's error
 * talks about it, only the required fields when it talks about another field, and a `localhost` return
 * address when the PWA's was the one sent. A `5xx`, an unreadable answer or no answer is not retried.
 *
 * ## Why a refusal here may quote the provider, when `tokens.ts` never does
 *
 * A token endpoint's answer IS the credential, so nothing it says is repeated. A registration request
 * carries no credential — a name, a return address and the grants asked for — so the provider's
 * RFC 7591 §3.2.2 `error` and `error_description` cannot be echoing one back, and they are the only
 * thing that says why a provider will not take Ferretry. They are still bounded, stripped of control
 * characters, and anything shaped like a credential or a query string is masked ({@link providerText})
 * before anybody reads them: a provider may put anything in free text.
 */

import { z } from 'zod';
import type { McpOAuthTokenAuth } from './ports.ts';

/** Where the provider is asked to send the browser back: the PWA's callback page, or a loopback page. */
export type RegistrationRedirect = 'pwa' | 'loopback';

/** The client authentication asked for (RFC 7591 §2 `token_endpoint_auth_method`). */
export type RegistrationAuth = 'none' | McpOAuthTokenAuth;

export interface RegistrationAttempt {
  readonly redirect: RegistrationRedirect;
  readonly auth: RegistrationAuth;
  /** Only what RFC 7591 requires: the return address, a name, and an auth method other than the default. */
  readonly minimal: boolean;
}

/** At most this many registration requests per sign-in: the first, and a few changes to it. */
export const MAX_REGISTRATION_ATTEMPTS = 4;

/** The first attempt for a return address. */
export const firstRegistrationAttempt = (redirect: RegistrationRedirect): RegistrationAttempt => ({
  redirect,
  auth: 'none',
  minimal: false,
});

/**
 * The client metadata one attempt sends. The full form is Claude Code's own (`client_name`,
 * `redirect_uris`, the two grants, `response_types`, `token_endpoint_auth_method: none`, and `scope`
 * when known); the minimal form leaves out every optional field, and `token_endpoint_auth_method` too
 * when it would only have said `none`.
 */
export function registrationMetadata(
  attempt: RegistrationAttempt,
  redirectUri: string,
  clientName: string,
  scope: string | undefined,
): Record<string, unknown> {
  if (attempt.minimal)
    return {
      client_name: clientName,
      redirect_uris: [redirectUri],
      ...(attempt.auth === 'none' ? {} : { token_endpoint_auth_method: attempt.auth }),
    };
  return {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: attempt.auth,
    ...(scope === undefined ? {} : { scope }),
  };
}

// ── Answers ──────────────────────────────────────────────────────────────────────────────────────

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch {
    return undefined;
  }
};

/**
 * What providers really answer, read as leniently as the MCP SDK's own client does: a client id that is
 * a string or a number, a secret that is absent, `null` or `""` for a public client, an authentication
 * method that is `null` or not text (taken as unsaid), and every other field ignored. Only the client id
 * and a secret that is present but not text are refusals.
 */
const RegistrationSchema = z.looseObject({
  client_id: z.union([z.string(), z.number().finite()]).transform(String).pipe(z.string().min(1).max(512)),
  client_secret: z
    .string()
    .max(4096)
    .nullish()
    .transform(value => (value === null || value === undefined || value === '' ? undefined : value)),
  token_endpoint_auth_method: z
    .string()
    .max(64)
    .nullish()
    .catch(undefined)
    .transform(value => value ?? undefined),
});

/** The JSON type of a value, the only thing about a provider's answer that a refusal may repeat. */
const jsonType = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a JSON array';
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    default:
      return 'a JSON object';
  }
};

/** Which field of an unusable success was wrong and how: field names and JSON types, never values. */
function registrationProblem(body: unknown, issuePath: readonly PropertyKey[], code: string): string {
  if (body === undefined) return 'its answer was not JSON';
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return `its answer was ${jsonType(body)}, not a JSON object`;
  const field = String(issuePath[0] ?? 'client_id');
  const value = (body as Record<string, unknown>)[field];
  if (value === undefined) return `its ${field} was missing`;
  if (code === 'too_big') return `its ${field} was too long`;
  if (code === 'too_small') return `its ${field} was empty`;
  return `its ${field} was ${jsonType(value)}`;
}

const ErrorSchema = z.looseObject({ error: z.unknown().optional(), error_description: z.unknown().optional() });

/** A registration endpoint's answer (RFC 7591 §3.2.1, §3.2.2), or that there was none. */
export type RegistrationAnswer =
  | {
      readonly kind: 'registered';
      readonly clientId: string;
      readonly clientSecret?: string;
      /** How to send `clientSecret`; absent means `client_secret_post`. */
      readonly tokenAuth?: McpOAuthTokenAuth;
    }
  /** Any answer that is not a success, with the provider's reason when it gave one. */
  | { readonly kind: 'rejected'; readonly status: number; readonly error?: string; readonly description?: string }
  /** A success with no usable client in it; `problem` says which field was wrong, never its value. */
  | { readonly kind: 'unreadable'; readonly status: number; readonly problem?: string }
  /** No HTTP answer: `reason` is the transport's code (`ENOTFOUND`, `TIMEOUT`, a certificate error). */
  | { readonly kind: 'unreachable'; readonly reason: string };

/** RFC 6749 §5.2's `error` alphabet: printable ASCII but `"` and `\`. Anything else is not an error code. */
const ERROR_CODE = /^[\x20\x21\x23-\x5b\x5d-\x7e]{1,64}$/u;

/** The longest provider description a refusal repeats. */
const DESCRIPTION_LIMIT = 300;

/**
 * How a client secret is sent, from what was asked and what the provider says it registered: the
 * provider's word when it gave one, else the method asked for, else — when the field was left out —
 * RFC 7591's default, `client_secret_basic`. A secret registered for `none` (the provider ignored it)
 * keeps the `client_secret_post` every earlier sign-in used.
 */
function tokenAuthOf(echoed: string | undefined, sent: RegistrationAuth | undefined): McpOAuthTokenAuth | undefined {
  if (echoed === 'client_secret_basic' || echoed === 'client_secret_post') return echoed;
  if (sent === 'client_secret_basic' || sent === 'client_secret_post') return sent;
  return sent === undefined ? 'client_secret_basic' : undefined;
}

/**
 * What a registration endpoint answered. `sent` is the `token_endpoint_auth_method` the request carried
 * (`undefined` when it carried none), which decides how a returned client secret is sent later.
 */
export function registrationAnswer(
  status: number,
  text: string,
  sent: RegistrationAuth | undefined,
): RegistrationAnswer {
  const body = parseJson(text);
  if (status === 200 || status === 201) {
    const parsed = RegistrationSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        kind: 'unreadable',
        status,
        problem: registrationProblem(body, issue?.path ?? [], issue?.code ?? 'invalid_type'),
      };
    }
    const secret = parsed.data.client_secret;
    const tokenAuth = secret === undefined ? undefined : tokenAuthOf(parsed.data.token_endpoint_auth_method, sent);
    return {
      kind: 'registered',
      clientId: parsed.data.client_id,
      ...(secret === undefined ? {} : { clientSecret: secret }),
      ...(tokenAuth === undefined || tokenAuth === 'client_secret_post' ? {} : { tokenAuth }),
    };
  }
  const reason = ErrorSchema.safeParse(body);
  const error = reason.success && typeof reason.data.error === 'string' ? reason.data.error.trim() : '';
  const description =
    reason.success && typeof reason.data.error_description === 'string'
      ? providerText(reason.data.error_description, DESCRIPTION_LIMIT)
      : undefined;
  return {
    kind: 'rejected',
    status,
    ...(ERROR_CODE.test(error) ? { error } : {}),
    ...(description === undefined ? {} : { description }),
  };
}

// ── The next attempt ─────────────────────────────────────────────────────────────────────────────

/** The provider's reason talks about how a client authenticates. */
const ABOUT_AUTH =
  /token_endpoint_auth|auth(?:entication)?[\s_-]*method|client[\s_-]*secret|public client|confidential/iu;
/** …about an optional metadata field the minimal form leaves out. */
const ABOUT_OPTIONAL_FIELD = /\bscopes?\b|grant[\s_-]*types?|response[\s_-]*types?/iu;

const NEXT_AUTH: Readonly<Record<RegistrationAuth, RegistrationAuth | undefined>> = {
  none: 'client_secret_post',
  client_secret_post: 'client_secret_basic',
  client_secret_basic: undefined,
};

/**
 * The attempt to make after a refusal, or `undefined` to stop. Only a `4xx` is retried — a `5xx` is the
 * provider failing, which asking differently will not fix — and each step changes one thing, in order:
 *
 * 1. the reason is about client authentication → the next method (`none` → `client_secret_post` →
 *    `client_secret_basic`), the variants providers that refuse public clients commonly require;
 * 2. the reason is about an optional field (a scope, a grant or response type) → only the required fields;
 * 3. the PWA's address was sent → a `localhost` return address, which is what every provider that
 *    admits desktop clients accepts (RFC 8252 §7.3);
 * 4. a plain `400` → only the required fields, once.
 */
export function nextRegistrationAttempt(
  attempt: RegistrationAttempt,
  answer: Extract<RegistrationAnswer, { readonly kind: 'rejected' }>,
): RegistrationAttempt | undefined {
  if (answer.status < 400 || answer.status >= 500) return undefined;
  const said = `${answer.error ?? ''} ${answer.description ?? ''}`;
  const nextAuth = NEXT_AUTH[attempt.auth];
  if (ABOUT_AUTH.test(said) && nextAuth !== undefined) return { ...attempt, auth: nextAuth };
  if (ABOUT_OPTIONAL_FIELD.test(said) && !attempt.minimal) return { ...attempt, minimal: true };
  if (attempt.redirect === 'pwa') return { ...attempt, redirect: 'loopback' };
  if (answer.status === 400 && !attempt.minimal) return { ...attempt, minimal: true };
  return undefined;
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

/** A word long enough to be a token, key or code, with a digit in it. Ordinary words have none. */
const OPAQUE_WORD = /^[A-Za-z0-9+/_\-.~=]{24,}$/u;
/** `client_secret=…`, `token: …`: a named value the name says is secret. */
const NAMED_SECRET =
  /\b([\w-]*(?:secret|token|password|passwd|api[_-]?key|assertion|code)[\w-]*)(\s*[:=]\s*)("?)[^\s",;&]+\3/giu;

/**
 * Free text from a provider, made safe to show: one line, at most `max` characters, a web address
 * without its query or fragment, and every value that looks like a credential masked.
 */
export function providerText(value: string, max: number): string | undefined {
  const line = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const masked = line
    .replace(NAMED_SECRET, '$1$2[redacted]')
    .split(' ')
    .map(word => {
      if (/^https?:\/\//iu.test(word) && URL.canParse(word)) {
        const url = new URL(word);
        return `${url.origin}${url.pathname}`;
      }
      return OPAQUE_WORD.test(word) && /\d/u.test(word) && /[A-Za-z]/u.test(word) ? '[redacted]' : word;
    })
    .join(' ');
  if (masked === '') return undefined;
  return masked.length <= max ? masked : `${masked.slice(0, max - 1)}…`;
}

/** A transport code that is about a certificate: this machine does not trust what the provider presented. */
const CERTIFICATE = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ISSUER/u;

/** The words for a request that got no answer, naming the host and the kind of failure, and what to do. */
export function unreachableSentence(host: string, reason: string, doing: string): string {
  const what = CERTIFICATE.test(reason.toUpperCase())
    ? 'its certificate is not one the daemon trusts'
    : 'no answer came back';
  return (
    `Ferretry’s daemon couldn’t reach ${host} to ${doing} — ${what} (network error: ${reason}). ` +
    'If this machine needs a proxy or a company certificate, the daemon needs them too: see ' +
    '“When the daemon can’t reach the provider” in docs/mcp-oauth.md.'
  );
}

const ATTEMPT_WORDS = (attempt: RegistrationAttempt): string =>
  [
    attempt.redirect === 'pwa' ? 'the Ferretry page' : 'a localhost address',
    attempt.auth === 'none' ? undefined : attempt.auth,
    attempt.minimal ? 'required fields only' : undefined,
  ]
    .filter(part => part !== undefined)
    .join(', ');

/**
 * Why no client could be registered, in a plain line and then the facts behind it: the endpoint's host,
 * the HTTP status, the provider's `error` and `error_description`, and every way it was asked.
 */
export function registrationRefusal(
  host: string,
  answer: Exclude<RegistrationAnswer, { readonly kind: 'registered' }>,
  tried: readonly RegistrationAttempt[],
): string {
  if (answer.kind === 'unreachable') return unreachableSentence(host, answer.reason, 'register Ferretry');
  const ways = tried.length <= 1 ? '' : ` Tried ${String(tried.length)} ways: ${tried.map(ATTEMPT_WORDS).join('; ')}.`;
  if (answer.kind === 'unreadable')
    return answer.problem === undefined
      ? `The sign-in provider at ${host} answered the registration (HTTP ${String(answer.status)}) without a client id Ferretry can use, so the sign-in could not start.${ways}`
      : `The sign-in provider at ${host} answered the registration (HTTP ${String(answer.status)}) but ${answer.problem}, so the sign-in could not start.${ways}`;
  const reason =
    answer.error === undefined
      ? 'no reason given'
      : `${answer.error}${answer.description === undefined ? '' : ` — ${answer.description}`}`;
  if (answer.status >= 500)
    return `The sign-in provider failed while registering Ferretry: ${reason}. ${host} answered HTTP ${String(answer.status)}; try again later.${ways}`;
  return (
    `The sign-in provider refused new apps: ${reason}. ${host} answered HTTP ${String(answer.status)} to Ferretry’s registration.${ways} ` +
    'If it only accepts apps registered by hand, register one there and give its client id to this server’s “oauth” settings (docs/mcp-oauth.md).'
  );
}
