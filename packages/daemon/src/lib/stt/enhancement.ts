import {
  DEFAULT_VOICE_CLEANUP_PROMPTS,
  type SecretName,
  type SttEnhancementErrorCode,
  type SttEnhancementErrorView,
  type SttEnhancementProvider,
  type SttEnhancementRequest,
  SttEnhancementRequestSchema,
  type SttEnhancementResult,
  type VoiceConfig,
} from '@ferretry/protocol';
import { CEREBRAS_HOST, GROQ_HOST, SPEEDUP_CATALOG } from '../speedups/catalog.ts';
import type { AuthorizedOutcome } from '../speedups/ports.ts';
import {
  buildCleanupSystemPrompt,
  CLEANUP_VIOLATION_REASONS,
  cleanupViolation,
  neutralizeCleanupTags,
} from './cleanup-guard.ts';
import { conversationReference, estimateTokens } from './context.ts';
import { SttEnhancementError } from './errors.ts';

/**
 * Post-dictation enhancement: after the local recognizer returns raw text, a
 * hosted chat model repairs recognition mistakes without rewriting the speaker.
 *
 * Everything in this module is a decision. The network call and the clock live
 * behind ports and the credential stays with the outbound holder; what they
 * observe comes back here to be classified. The invariants this file is responsible for:
 *
 * - The provider credential is never part of a request, a result, or an error.
 * - Text, context, dictionary and model id are bounded before a request is built.
 * - Each failure mode maps to one stable code and one fixed message; no message
 *   ever embeds the transcript, the provider body, or the credential.
 * - There is no fallback to another provider. A reply that fails the cleanup guard (see
 *   `cleanup-guard.ts`) is not an error: the transcript comes back untouched, marked `kept: 'raw'`.
 */

/**
 * Character caps applied before any request body is built.
 *
 * `maxTextChars` restates the transcript cap the wire schema enforces, so the
 * daemon documents its own limit; a unit test pins the two together and fails if
 * the schema ever moves without this constant.
 */
export const ENHANCEMENT_LIMITS = {
  maxTextChars: 8_000,
  maxUserContextChars: 2_000,
  maxDictionaryChars: 4_000,
  maxModelIdChars: 128,
  /** Hard byte ceiling for a provider reply: the output cap in worst-case UTF-8 plus a JSON envelope. */
  maxResponseBytes: 16_000 * 4 + 4_096,
  /** Guards against a runaway provider reply; not a promise of shape. */
  maxOutputChars: 16_000,
} as const;

export const DEFAULT_ENHANCEMENT_TIMEOUT_MS = 4_000;

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
  return { error: error.message, code: error.code };
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
    label: 'Groq',
    secretName: SPEEDUP_CATALOG.groq.secretName,
    hosts: SPEEDUP_CATALOG.groq.hosts,
    endpoint: `https://${GROQ_HOST}/openai/v1/chat/completions`,
    defaultModel: 'openai/gpt-oss-120b',
    hideReasoning: Object.freeze({ include_reasoning: false }),
  }),
  cerebras: Object.freeze({
    id: 'cerebras',
    label: 'Cerebras',
    secretName: SPEEDUP_CATALOG.cerebras.secretName,
    hosts: SPEEDUP_CATALOG.cerebras.hosts,
    endpoint: `https://${CEREBRAS_HOST}/v1/chat/completions`,
    defaultModel: 'gpt-oss-120b',
    hideReasoning: Object.freeze({}),
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

const MODEL_ID = /^[A-Za-z0-9._:/-]+$/u;

/** Every request the enhancer will act on, bounded and stripped of empties. */
export interface NormalizedEnhancement {
  readonly provider: EnhancementProviderDefinition;
  readonly model: string;
  readonly text: string;
  readonly context: readonly string[];
  readonly userContext?: string;
  readonly dictionary: readonly string[];
  readonly style: 'fix' | 'polish';
  /** The style prompt: the person's own wording, or the shipped default. Always wrapped by the guard. */
  readonly instruction: string;
}

/**
 * Keep the tail of an over-long block instead of rejecting the request: the
 * most recent context is the most useful, and a caller cannot know the daemon's
 * cap in advance.
 */
function boundedTail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function normalizedDictionary(dictionary: SttEnhancementRequest['dictionary']): readonly string[] {
  const lines: string[] = [];
  let used = 0;
  for (const entry of dictionary ?? []) {
    const aliases = (entry.aliases ?? []).map(alias => alias.trim()).filter(alias => alias.length > 0);
    const line = aliases.length === 0 ? entry.term.trim() : `${aliases.join(', ')} -> ${entry.term.trim()}`;
    if (used + line.length > ENHANCEMENT_LIMITS.maxDictionaryChars) break;
    used += line.length + 1;
    lines.push(line);
  }
  return lines;
}

function normalizedModel(provider: EnhancementProviderDefinition, model: string | undefined): string {
  if (model === undefined) return provider.defaultModel;
  const invalid = model.length > ENHANCEMENT_LIMITS.maxModelIdChars || !MODEL_ID.test(model);
  if (invalid) throw new SttEnhancementError('bad_model', 'model id is invalid');
  return model;
}

/**
 * Parse an untrusted request body against the wire schema, then apply the
 * daemon's own caps. Schema failures become the code the route can forward
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
  const text = request.text.trim();
  if (text.length === 0) throw new SttEnhancementError('bad_request', 'transcript is required');

  if (cleanup.style === 'off') throw new SttEnhancementError('bad_request', 'cleanup is switched off on this machine');
  const style = cleanup.style;
  // The machine decides whether the conversation is shared and how much of it: a device cannot widen it.
  const context = cleanup.useConversation ? conversationReference(request.context, cleanup.conversationMessages) : [];

  const userContext = request.userContext?.trim();
  return {
    provider,
    model: normalizedModel(provider, request.model),
    text,
    context,
    ...(userContext !== undefined && userContext.length > 0 ? { userContext } : {}),
    dictionary: normalizedDictionary(request.dictionary),
    style,
    instruction: cleanup.prompts[style] ?? DEFAULT_VOICE_CLEANUP_PROMPTS[style],
  };
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

const block = (tag: string, body: string): string => `<${tag}>\n${neutralizeCleanupTags(body)}\n</${tag}>`;

/**
 * The user message: read-only references first, the dictation last, each in its own tagged block the
 * guard names. Anything inside a block has the wrapper's tags removed, so it cannot close its block.
 */
export function buildEnhancementUserMessage(request: NormalizedEnhancement): string {
  const sections: string[] = [];
  if (request.dictionary.length > 0) sections.push(block('dictionary', request.dictionary.join('\n')));
  if (request.context.length > 0) sections.push(block('reference', request.context.join('\n')));
  if (request.userContext !== undefined) {
    sections.push(block('hints', boundedTail(request.userContext, ENHANCEMENT_LIMITS.maxUserContextChars)));
  }
  sections.push(block('dictation', request.text));
  return sections.join('\n\n');
}

export interface ChatCompletionBody {
  readonly model: string;
  readonly messages: readonly { readonly role: 'system' | 'user'; readonly content: string }[];
  readonly temperature: 0;
  readonly stream: false;
  readonly max_completion_tokens: number;
  readonly reasoning_effort?: 'low';
  readonly include_reasoning?: boolean;
}

/** gpt-oss models think before they answer; dictation cleanup wants the least thinking and none of it back. */
const REASONING_MODEL = /gpt-oss/iu;

/**
 * The reply cap. It counts a reasoning model's thinking too, so it is the dictation's own size twice
 * over plus room to think: enough that a long dictation is never cut off, small enough that a model
 * which will not stop cannot hold the request for minutes.
 */
export function completionBudget(request: NormalizedEnhancement): number {
  return Math.min(4_096, Math.max(1_024, estimateTokens(request.text) * 2 + 768));
}

export function buildEnhancementBody(request: NormalizedEnhancement): ChatCompletionBody {
  return {
    model: request.model,
    messages: [
      { role: 'system', content: buildCleanupSystemPrompt(request.instruction) },
      { role: 'user', content: buildEnhancementUserMessage(request) },
    ],
    temperature: 0,
    stream: false,
    max_completion_tokens: completionBudget(request),
    ...(REASONING_MODEL.test(request.model) ? { reasoning_effort: 'low', ...request.provider.hideReasoning } : {}),
  };
}

/** The request headers. There is no credential among them: the outbound holder adds it. */
export const ENHANCEMENT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json',
  accept: 'application/json',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CLOSED_THINKING = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/giu;
const OPEN_THINKING = /<think(?:ing)?>[\s\S]*$/iu;
const STRAY_CLOSE = /^[\s\S]*<\/think(?:ing)?>/iu;
/** gpt-oss's own channel markup, which some gateways leave in `content` instead of splitting out. */
const FINAL_CHANNEL = /^[\s\S]*(?:<\|channel\|>\s*final\s*<\|message\|>|assistantfinal)/u;
const CHANNEL_TOKENS = /<\|[a-z_]+\|>/gu;

/**
 * The reply with every trace of the model's thinking removed: a closed `<think>` block, one that was
 * cut off before it closed (everything after it is thinking), a closing tag with no opener (the
 * thinking sits before it), and gpt-oss channel markup, where the answer is whatever follows the
 * final-channel marker.
 */
export function withoutReasoning(content: string): string {
  return content
    .replace(CLOSED_THINKING, '')
    .replace(OPEN_THINKING, '')
    .replace(STRAY_CLOSE, '')
    .replace(FINAL_CHANNEL, '')
    .replace(CHANNEL_TOKENS, '');
}

function firstChoice(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first: unknown = choices[0];
  return isRecord(first) ? first : undefined;
}

/** Extract assistant text from an OpenAI-compatible chat completion payload. */
export function parseChatCompletion(payload: unknown): string | undefined {
  const message = firstChoice(payload)?.message;
  if (!isRecord(message)) return undefined;
  const content = message.content;
  // Reasoning travels in its own field and is never read; a model that inlines it is stripped here.
  return typeof content === 'string' ? withoutReasoning(content) : undefined;
}

const OUT_OF_TOKENS = 'enhancement model used its whole reply budget thinking and returned no text';
const EMPTY_REPLY = 'enhancement model returned an empty reply';

/** Whether the model stopped because it hit the reply cap rather than because it finished. */
function ranOutOfTokens(payload: unknown): boolean {
  return firstChoice(payload)?.finish_reason === 'length';
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

  const content = parseChatCompletion(outcome.payload);
  if (content === undefined) {
    throw new SttEnhancementError('malformed_response', 'enhancement provider returned an unexpected response');
  }
  const text = content.trim();
  if (text.length === 0) {
    const reason = ranOutOfTokens(outcome.payload) ? OUT_OF_TOKENS : EMPTY_REPLY;
    throw new SttEnhancementError('malformed_response', reason);
  }
  if (text.length > ENHANCEMENT_LIMITS.maxOutputChars) {
    throw new SttEnhancementError('malformed_response', 'enhancement model returned an over-long reply');
  }
  const violation = cleanupViolation({
    raw: request.text,
    output: text,
    style: request.style,
    reference: request.context,
  });
  if (violation !== undefined) {
    return {
      text: request.text,
      provider: request.provider.id,
      model: request.model,
      latencyMs,
      kept: 'raw',
      keptReason: CLEANUP_VIOLATION_REASONS[violation],
    };
  }
  return { text, provider: request.provider.id, model: request.model, latencyMs };
}
