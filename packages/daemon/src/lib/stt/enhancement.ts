import {
  buildCleanupBody,
  type ChatCompletionBody,
  CLEANUP_PROVIDERS,
  type CleanupRequest,
  type CleanupTraceAttempt,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  describeCleanupReply,
  describeCleanupRequest,
  prepareCleanup,
  readCleanupReply,
  type SecretName,
  type SttEnhancementErrorCode,
  type SttEnhancementErrorView,
  type SttEnhancementProvider,
  SttEnhancementRequestSchema,
  type SttEnhancementResult,
  TRACE_REDACTED,
  type VoiceConfig,
} from '@ferretry/protocol';
import { SPEEDUP_CATALOG } from '../speedups/catalog.ts';
import type { AuthorizedOutcome } from '../speedups/ports.ts';
import { SttEnhancementError } from './errors.ts';

/**
 * Post-dictation enhancement through the daemon: after the browser's recognizer returns raw text, a
 * hosted chat model repairs recognition mistakes without rewriting the speaker, spending the key
 * from this machine's secret store.
 *
 * What the request holds and how a reply is judged are `@ferretry/protocol`'s `stt-cleanup` — the
 * SAME decisions a browser makes when it spends a key it holds itself. What is left here is the
 * daemon's own part: the wire request, the error vocabulary, and the key's holder. The invariants
 * this file is responsible for:
 *
 * - The provider credential is never part of a request, a result, or an error.
 * - Each failure mode maps to one stable code and one fixed message; no message
 *   ever embeds the transcript, the provider body, or the credential.
 * - There is no fallback to another provider. A reply that fails the cleanup guard is not an error:
 *   the transcript comes back untouched, marked `kept: 'raw'`.
 */

export const DEFAULT_ENHANCEMENT_TIMEOUT_MS = DEFAULT_CLEANUP_TIMEOUT_MS;

const ENHANCEMENT_ERROR_STATUS: Readonly<Record<SttEnhancementErrorCode, number>> = {
  bad_request: 400,
  too_long: 413,
  provider_unknown: 400,
  bad_model: 400,
  secret_missing: 503,
  secret_invalid: 502,
  rate_limited: 429,
  timeout: 504,
  provider_unreachable: 502,
  provider_error: 502,
  malformed_response: 502,
};

export function enhancementErrorStatus(code: SttEnhancementErrorCode): number {
  return ENHANCEMENT_ERROR_STATUS[code];
}

export function enhancementErrorView(error: SttEnhancementError): SttEnhancementErrorView {
  return { error: error.message, code: error.code, ...(error.trace === undefined ? {} : { debug: error.trace }) };
}

/**
 * One provider entry. Every provider speaks the OpenAI-compatible chat
 * completions contract, so only the endpoint, secret name, allowed hosts and
 * default model vary; a new provider is one frozen entry plus a member on the
 * protocol union.
 */
export interface EnhancementProviderDefinition {
  readonly id: SttEnhancementProvider;
  readonly label: string;
  /** Name of the secret-store entry holding the API key. The value is never read here. */
  readonly secretName: SecretName;
  /** The only hosts that key may be sent to. */
  readonly hosts: readonly string[];
  readonly endpoint: string;
  readonly defaultModel: string;
  /** Extra body fields that keep a reasoning model's thinking out of the reply (gpt-oss only). */
  readonly hideReasoning?: Readonly<Record<string, unknown>>;
}

/** The machine's cleanup settings, as `voice.yaml` holds them. */
export type CleanupSettings = VoiceConfig['postProcessing'];

export const DEFAULT_CLEANUP_SETTINGS: CleanupSettings = {
  provider: 'off',
  style: 'fix',
  prompts: {},
  useConversation: false,
  conversationMessages: 8,
};

export type EnhancementProviderTable = Readonly<Record<string, EnhancementProviderDefinition>>;

export const DEFAULT_ENHANCEMENT_PROVIDERS: EnhancementProviderTable = Object.freeze({
  groq: Object.freeze({
    id: 'groq',
    label: CLEANUP_PROVIDERS.groq.label,
    secretName: SPEEDUP_CATALOG.groq.secretName,
    hosts: SPEEDUP_CATALOG.groq.hosts,
    endpoint: CLEANUP_PROVIDERS.groq.endpoint,
    defaultModel: CLEANUP_PROVIDERS.groq.defaultModel,
    hideReasoning: CLEANUP_PROVIDERS.groq.hideReasoning,
  }),
  cerebras: Object.freeze({
    id: 'cerebras',
    label: CLEANUP_PROVIDERS.cerebras.label,
    secretName: SPEEDUP_CATALOG.cerebras.secretName,
    hosts: SPEEDUP_CATALOG.cerebras.hosts,
    endpoint: CLEANUP_PROVIDERS.cerebras.endpoint,
    defaultModel: CLEANUP_PROVIDERS.cerebras.defaultModel,
    hideReasoning: CLEANUP_PROVIDERS.cerebras.hideReasoning,
  }),
});

/** The public view of a provider — never includes the secret name. */
export interface EnhancementProviderView {
  readonly id: SttEnhancementProvider;
  readonly label: string;
  readonly defaultModel: string;
}

export function enhancementProviderViews(table: EnhancementProviderTable): readonly EnhancementProviderView[] {
  return Object.values(table).map(({ id, label, defaultModel }) => ({ id, label, defaultModel }));
}

/**
 * A provider is looked up with `Object.hasOwn`. Indexing the table directly —
 * as the source did — resolves `constructor` or `toString` to an inherited
 * function, which passes a truthy check and then fails much later with the
 * wrong error code.
 */
export function findEnhancementProvider(
  table: EnhancementProviderTable,
  provider: string,
): EnhancementProviderDefinition {
  const definition = Object.hasOwn(table, provider) ? table[provider] : undefined;
  if (definition === undefined) throw new SttEnhancementError('provider_unknown', 'unknown enhancement provider');
  return definition;
}

/** Every request the enhancer will act on: the shared cleanup request, and the provider that runs it. */
export interface NormalizedEnhancement extends CleanupRequest {
  readonly provider: EnhancementProviderDefinition;
  /** The caller asked for this call's debug record back. */
  readonly debug: boolean;
}

const REFUSALS = {
  empty: () => new SttEnhancementError('bad_request', 'transcript is required'),
  off: () => new SttEnhancementError('bad_request', 'cleanup is switched off on this machine'),
  bad_model: () => new SttEnhancementError('bad_model', 'model id is invalid'),
} as const;

/**
 * Parse an untrusted request body against the wire schema, then apply the
 * shared cleanup caps. Schema failures become the code the route can forward
 * as-is rather than a generic 400.
 */
export function parseEnhancementRequest(
  input: unknown,
  table: EnhancementProviderTable,
  cleanup: CleanupSettings = DEFAULT_CLEANUP_SETTINGS,
): NormalizedEnhancement {
  const parsed = SttEnhancementRequestSchema.safeParse(input);
  if (!parsed.success) throw schemaFailure(parsed.error.issues);
  const request = parsed.data;

  const provider = findEnhancementProvider(table, request.provider);
  // The machine decides whether the conversation is shared and how much of it: a device cannot widen it.
  const prepared = prepareCleanup({
    text: request.text,
    model: request.model,
    defaultModel: provider.defaultModel,
    context: request.context,
    userContext: request.userContext,
    dictionary: request.dictionary,
    settings: cleanup,
  });
  if ('refused' in prepared) throw REFUSALS[prepared.refused]();
  return { ...prepared, provider, debug: request.debug === true };
}

interface SchemaIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
}

function schemaFailure(issues: readonly SchemaIssue[]): SttEnhancementError {
  const oversized = issues.find(issue => issue.code === 'too_big');
  if (oversized !== undefined) {
    return new SttEnhancementError('too_long', `${String(oversized.path[0] ?? 'request')} exceeds the maximum size`);
  }
  if (issues.some(issue => issue.path[0] === 'provider')) {
    return new SttEnhancementError('provider_unknown', 'unknown enhancement provider');
  }
  if (issues.some(issue => issue.path[0] === 'model')) {
    return new SttEnhancementError('bad_model', 'model id is invalid');
  }
  return new SttEnhancementError('bad_request', 'enhancement request is not valid');
}

export function buildEnhancementBody(request: NormalizedEnhancement): ChatCompletionBody {
  return buildCleanupBody(request, { hideReasoning: request.provider.hideReasoning ?? {} });
}

/** The request headers. There is no credential among them: the outbound holder adds it. */
export const ENHANCEMENT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json',
  accept: 'application/json',
});

/**
 * One attempt as a debug record. The request is shown with its credential header redacted — the
 * authorizer adds the real one, which this file never sees — and the reply is described by the same
 * shared decisions the browser path uses. The transport hands back the provider's parsed JSON, so the
 * raw reply is that value printed back, and a non-2xx status has no body to show.
 */
export function describeEnhancementAttempt(
  request: NormalizedEnhancement,
  body: ChatCompletionBody,
  outcome: AuthorizedOutcome,
  totalMs: number,
  failure: string | undefined,
): CleanupTraceAttempt {
  return {
    withContext: request.context.length > 0,
    request: describeCleanupRequest({
      endpoint: request.provider.endpoint,
      headers: { ...ENHANCEMENT_HEADERS, authorization: TRACE_REDACTED },
      body,
    }),
    ...(outcome.kind === 'status' ? { status: outcome.status } : {}),
    ...(outcome.kind === 'completion' ? { response: describeCleanupReply(outcome.payload, request) } : {}),
    ...(failure === undefined ? {} : { failure }),
    timings: { totalMs },
  };
}

/** A non-2xx status maps to a distinct, body-free error that names the status and the next step. */
export function enhancementErrorForStatus(status: number, retryAfterSeconds?: number): SttEnhancementError {
  const at = `HTTP ${String(status)}`;
  if (status === 401 || status === 403) {
    return new SttEnhancementError(
      'secret_invalid',
      `enhancement provider rejected the daemon credentials (${at}); check the provider key`,
      undefined,
      undefined,
      status,
    );
  }
  if (status === 404) {
    return new SttEnhancementError(
      'bad_model',
      `enhancement model is not available (${at}); pick another model`,
      undefined,
      undefined,
      status,
    );
  }
  if (status === 413) {
    return new SttEnhancementError(
      'too_long',
      `enhancement provider says the request is too large for its limit (${at})`,
      undefined,
      undefined,
      status,
    );
  }
  if (status === 429) {
    const retryAfterMs =
      retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? Math.round(retryAfterSeconds * 1_000)
        : undefined;
    const wait =
      retryAfterMs === undefined ? '' : `; try again in ${String(Math.max(1, Math.ceil(retryAfterMs / 1_000)))}s`;
    return new SttEnhancementError(
      'rate_limited',
      `enhancement provider is rate limiting requests (${at})${wait}`,
      retryAfterMs,
      undefined,
      status,
    );
  }
  if (status >= 500) {
    return new SttEnhancementError(
      'provider_error',
      `enhancement provider returned an error (${at})`,
      undefined,
      undefined,
      status,
    );
  }
  return new SttEnhancementError(
    'provider_error',
    `enhancement provider rejected the request (${at})`,
    undefined,
    undefined,
    status,
  );
}

/** Turn a transport outcome into the result, or into the one error that fits it. */
export function classifyEnhancementOutcome(
  outcome: AuthorizedOutcome,
  request: NormalizedEnhancement,
  latencyMs: number,
): SttEnhancementResult {
  if (outcome.kind === 'secret_missing') {
    throw new SttEnhancementError('secret_missing', 'enhancement provider is not configured');
  }
  if (outcome.kind === 'vault_damaged') {
    throw new SttEnhancementError('secret_missing', 'the secret store holding the enhancement key cannot be read');
  }
  if (outcome.kind === 'refused') {
    throw new SttEnhancementError('provider_error', 'enhancement provider endpoint is not allowed for its key');
  }
  if (outcome.kind === 'timeout') throw new SttEnhancementError('timeout', 'enhancement request timed out');
  if (outcome.kind === 'unreachable') {
    throw new SttEnhancementError('provider_unreachable', 'enhancement provider is unreachable', undefined, {
      cause: outcome.cause,
    });
  }
  if (outcome.kind === 'oversized') {
    throw new SttEnhancementError('malformed_response', 'enhancement provider returned an oversized response');
  }
  if (outcome.kind === 'unreadable') {
    throw new SttEnhancementError('malformed_response', 'enhancement provider returned an unreadable response');
  }
  if (outcome.kind === 'status') throw enhancementErrorForStatus(outcome.status, outcome.retryAfterSeconds);

  const reply = readCleanupReply(outcome.payload, request);
  if (reply.kind === 'unusable') throw new SttEnhancementError('malformed_response', reply.reason);
  if (reply.kind === 'kept_raw') {
    return {
      text: request.text,
      provider: request.provider.id,
      model: request.model,
      latencyMs,
      kept: 'raw',
      keptReason: reply.reason,
    };
  }
  return { text: reply.text, provider: request.provider.id, model: request.model, latencyMs };
}
