import type { VoiceCleanupStyle, VoiceConfig } from './config-files.ts';
import { DEFAULT_VOICE_CLEANUP_PROMPTS } from './config-files.ts';
import type { SttEnhancementProvider } from './stt.ts';
import { conversationReference, estimateTokens } from './stt-cleanup-context.ts';
import {
  buildCleanupSystemPrompt,
  CLEANUP_VIOLATION_REASONS,
  cleanupViolation,
  neutralizeCleanupTags,
} from './stt-cleanup-guard.ts';

/**
 * Dictation cleanup as decisions, shared by the two places that run it: the daemon, spending a key
 * from its secret store, and the browser, spending a key this device holds (`docs/secrets.md`,
 * "Device-held speed-up keys"). Whoever sends the request, it is built here, bounded here, and its
 * reply is judged here, so a browser call and a daemon call cannot drift apart in what they send or
 * what they accept.
 *
 * Nothing here performs IO or touches a credential. The caller owns the network, the clock and the
 * key; what came back is handed in to be read.
 */

/**
 * The hosted cleanup providers, as data. Every one speaks the OpenAI-compatible chat completions
 * contract, so only the host, the two endpoints and the default model differ. The host is the WHOLE
 * set a provider key may be sent to — the daemon's outbound holder and the browser's key vault both
 * compare against it exactly, and the PWA's `connect-src` names exactly these hosts.
 */
export interface CleanupProviderDefinition {
  readonly id: SttEnhancementProvider;
  readonly label: string;
  readonly host: string;
  readonly endpoint: string;
  /** A free, authenticated read of the models a key can use: what a key's Test calls. */
  readonly modelsUrl: string;
  readonly defaultModel: string;
  /** Extra body fields that keep a reasoning model's thinking out of the reply (gpt-oss only). */
  readonly hideReasoning: Readonly<Record<string, unknown>>;
}

/** Each URL spells its host out, and a test pins every URL to its `host`, so the two cannot part. */
export const CLEANUP_PROVIDERS: Readonly<Record<SttEnhancementProvider, CleanupProviderDefinition>> = Object.freeze({
  groq: Object.freeze({
    id: 'groq',
    label: 'Groq',
    host: 'api.groq.com',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    defaultModel: 'openai/gpt-oss-120b',
    hideReasoning: Object.freeze({ include_reasoning: false }),
  }),
  cerebras: Object.freeze({
    id: 'cerebras',
    label: 'Cerebras',
    host: 'api.cerebras.ai',
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    modelsUrl: 'https://api.cerebras.ai/v1/models',
    defaultModel: 'gpt-oss-120b',
    hideReasoning: Object.freeze({}),
  }),
});

/**
 * Character caps applied before any request body is built.
 *
 * `maxTextChars` restates the transcript cap the wire schema enforces; a unit test pins the two
 * together and fails if the schema ever moves without this constant.
 */
export const CLEANUP_LIMITS = {
  maxTextChars: 8_000,
  maxUserContextChars: 2_000,
  maxDictionaryChars: 4_000,
  maxModelIdChars: 128,
  /** Hard byte ceiling for a provider reply: the output cap in worst-case UTF-8 plus a JSON envelope. */
  maxResponseBytes: 16_000 * 4 + 4_096,
  /** Guards against a runaway provider reply; not a promise of shape. */
  maxOutputChars: 16_000,
} as const;

/** One attempt's deadline. Long enough for a gpt-oss round trip, short enough that Stop never feels stuck. */
export const DEFAULT_CLEANUP_TIMEOUT_MS = 4_000;

/** The cleanup half of `voice.yaml`: the style, the editable prompts and how much conversation goes along. */
export type CleanupSettings = Pick<
  VoiceConfig['postProcessing'],
  'style' | 'prompts' | 'useConversation' | 'conversationMessages'
>;

export interface CleanupDictionaryEntry {
  readonly term: string;
  readonly aliases?: readonly string[] | undefined;
}

/** Every request a cleanup will act on, bounded and stripped of empties. */
export interface CleanupRequest {
  readonly model: string;
  readonly text: string;
  readonly context: readonly string[];
  readonly userContext?: string;
  readonly dictionary: readonly string[];
  readonly style: Exclude<VoiceCleanupStyle, 'off'>;
  /** The style prompt: the person's own wording, or the shipped default. Always wrapped by the guard. */
  readonly instruction: string;
}

/** Why a cleanup was not attempted at all. */
export type CleanupRefusal = 'empty' | 'off' | 'bad_model';

const MODEL_ID = /^[A-Za-z0-9._:/-]+$/u;

/** Whether a model id is one this cleanup will put in a request body. */
export function isCleanupModelId(model: string): boolean {
  return model.length <= CLEANUP_LIMITS.maxModelIdChars && MODEL_ID.test(model);
}

/** The vocabulary block, one entry per line, inside the dictionary budget. */
export function cleanupDictionaryLines(dictionary: readonly CleanupDictionaryEntry[] | undefined): readonly string[] {
  const lines: string[] = [];
  let used = 0;
  for (const entry of dictionary ?? []) {
    const aliases = (entry.aliases ?? []).map(alias => alias.trim()).filter(alias => alias.length > 0);
    const line = aliases.length === 0 ? entry.term.trim() : `${aliases.join(', ')} -> ${entry.term.trim()}`;
    if (used + line.length > CLEANUP_LIMITS.maxDictionaryChars) break;
    used += line.length + 1;
    lines.push(line);
  }
  return lines;
}

export interface CleanupInput {
  readonly text: string;
  /** The model asked for, or the provider's default when absent. */
  readonly model?: string | undefined;
  readonly defaultModel: string;
  /** Raw conversation records, oldest first; reduced and bounded here, and dropped unless the settings allow it. */
  readonly context?: readonly string[] | undefined;
  readonly userContext?: string | undefined;
  readonly dictionary?: readonly CleanupDictionaryEntry[] | undefined;
  readonly settings: CleanupSettings;
}

/**
 * The request a cleanup sends, or why it sends nothing. The settings decide whether the conversation
 * goes along and how much of it: a caller cannot widen it by sending more.
 */
export function prepareCleanup(input: CleanupInput): CleanupRequest | { readonly refused: CleanupRefusal } {
  const text = input.text.trim();
  if (text.length === 0) return { refused: 'empty' };
  const style = input.settings.style;
  if (style === 'off') return { refused: 'off' };
  const model = input.model ?? input.defaultModel;
  if (!isCleanupModelId(model)) return { refused: 'bad_model' };
  const context = input.settings.useConversation
    ? conversationReference(input.context, input.settings.conversationMessages)
    : [];
  const userContext = input.userContext?.trim();
  return {
    model,
    text,
    context,
    ...(userContext !== undefined && userContext.length > 0 ? { userContext } : {}),
    dictionary: cleanupDictionaryLines(input.dictionary),
    style,
    instruction: input.settings.prompts[style] ?? DEFAULT_VOICE_CLEANUP_PROMPTS[style],
  };
}

/**
 * Keep the tail of an over-long block instead of rejecting the request: the most recent context is
 * the most useful, and a caller cannot know the cap in advance.
 */
function boundedTail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

const block = (tag: string, body: string): string => `<${tag}>\n${neutralizeCleanupTags(body)}\n</${tag}>`;

/**
 * The user message: read-only references first, the dictation last, each in its own tagged block the
 * guard names. Anything inside a block has the wrapper's tags removed, so it cannot close its block.
 */
export function buildCleanupUserMessage(request: CleanupRequest): string {
  const sections: string[] = [];
  if (request.dictionary.length > 0) sections.push(block('dictionary', request.dictionary.join('\n')));
  if (request.context.length > 0) sections.push(block('reference', request.context.join('\n')));
  if (request.userContext !== undefined) {
    sections.push(block('hints', boundedTail(request.userContext, CLEANUP_LIMITS.maxUserContextChars)));
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
export function completionBudget(request: CleanupRequest): number {
  return Math.min(4_096, Math.max(1_024, estimateTokens(request.text) * 2 + 768));
}

export function buildCleanupBody(
  request: CleanupRequest,
  provider: Pick<CleanupProviderDefinition, 'hideReasoning'>,
): ChatCompletionBody {
  return {
    model: request.model,
    messages: [
      { role: 'system', content: buildCleanupSystemPrompt(request.instruction) },
      { role: 'user', content: buildCleanupUserMessage(request) },
    ],
    temperature: 0,
    stream: false,
    max_completion_tokens: completionBudget(request),
    ...(REASONING_MODEL.test(request.model) ? { reasoning_effort: 'low', ...provider.hideReasoning } : {}),
  };
}

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

/** What a provider's 2xx reply amounts to. `unusable` is a failure; `kept_raw` is the guard returning the words. */
export type CleanupReply =
  | { readonly kind: 'cleaned'; readonly text: string }
  | { readonly kind: 'kept_raw'; readonly reason: string }
  | { readonly kind: 'unusable'; readonly reason: string };

export const CLEANUP_REPLY_PROBLEMS = {
  unexpected: 'enhancement provider returned an unexpected response',
  outOfTokens: 'enhancement model used its whole reply budget thinking and returned no text',
  empty: 'enhancement model returned an empty reply',
  overLong: 'enhancement model returned an over-long reply',
} as const;

/**
 * Judge a provider's reply against the request that produced it: the text when it is still the
 * dictation, corrected; the raw words with the guard's reason when it is not; or why it is unusable.
 */
export function readCleanupReply(payload: unknown, request: CleanupRequest): CleanupReply {
  const content = parseChatCompletion(payload);
  if (content === undefined) return { kind: 'unusable', reason: CLEANUP_REPLY_PROBLEMS.unexpected };
  const text = content.trim();
  if (text.length === 0) {
    // Whether the model stopped because it hit the reply cap rather than because it finished.
    const outOfTokens = firstChoice(payload)?.finish_reason === 'length';
    return {
      kind: 'unusable',
      reason: outOfTokens ? CLEANUP_REPLY_PROBLEMS.outOfTokens : CLEANUP_REPLY_PROBLEMS.empty,
    };
  }
  if (text.length > CLEANUP_LIMITS.maxOutputChars) return { kind: 'unusable', reason: CLEANUP_REPLY_PROBLEMS.overLong };
  const violation = cleanupViolation({
    raw: request.text,
    output: text,
    style: request.style,
    reference: request.context,
  });
  return violation === undefined
    ? { kind: 'cleaned', text }
    : { kind: 'kept_raw', reason: CLEANUP_VIOLATION_REASONS[violation] };
}

/**
 * A provider status that more reference text caused and less can cure: the request is too big or
 * invalid. The conversation is a nicety, so such a failure is retried once with none.
 */
export function isContextSizedStatus(status: number | undefined): boolean {
  return status === 413 || status === 400;
}
