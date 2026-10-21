import { z } from 'zod';
import { NonNegativeFiniteSchema, NonNegativeIntegerSchema } from './common.ts';
import { type ChatCompletionBody, type CleanupRequest, readCleanupReply, withoutReasoning } from './stt-cleanup.ts';

/**
 * What a dictation cleanup call looked like, as a record a person can read when it did not do what
 * they expected: the request exactly as sent, the provider's reply exactly as it came back, and each
 * step the shared cleanup took between that reply and the words that were kept.
 *
 * It is built by the same decisions on both paths — the browser holding its own key and the daemon
 * spending one — so the two show the same fields in the same words. It is evidence about ONE call,
 * held only where the person asked for it: the browser keeps it in memory, and the daemon echoes it
 * back to the caller that asked and never records it.
 *
 * A record holds dictated text, so it is as sensitive as the dictation. It NEVER holds a credential:
 * request headers are recorded with every secret-bearing value replaced by `TRACE_REDACTED`, built
 * from the header NAME alone, so the real value is never read on the way to the record.
 */

/** The only thing a secret-bearing header is ever shown as. */
export const TRACE_REDACTED = '[redacted]';

const SECRET_HEADER = /authori[sz]ation|api[-_]?key|cookie|token|secret/iu;

/** Every header a request sent, with the value of each secret-bearing one replaced. */
export function redactTraceHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, SECRET_HEADER.test(name) ? TRACE_REDACTED : value]),
  );
}

/** A provider reply or a prompt can be long; this only stops a corrupt record from being unbounded. */
const TEXT = z.string().max(200_000);

export const CleanupTraceStepSchema = z.strictObject({
  step: z.enum(['reasoning_stripped', 'guard_passed', 'guard_rejected', 'kept_raw', 'unusable']),
  detail: z.string().max(400).optional(),
});
export type CleanupTraceStep = z.infer<typeof CleanupTraceStepSchema>;

export const CleanupTraceUsageSchema = z.strictObject({
  promptTokens: NonNegativeIntegerSchema.optional(),
  completionTokens: NonNegativeIntegerSchema.optional(),
  totalTokens: NonNegativeIntegerSchema.optional(),
  reasoningTokens: NonNegativeIntegerSchema.optional(),
});
export type CleanupTraceUsage = z.infer<typeof CleanupTraceUsageSchema>;

export const CleanupTraceRequestSchema = z.strictObject({
  host: z.string().min(1).max(253),
  path: z.string().max(512),
  headers: z.record(z.string().max(128), z.string().max(512)),
  /** Every body field except the messages: model, temperature, reply cap, reasoning switches. */
  params: z.record(z.string().max(64), z.unknown()),
  messages: z.array(z.strictObject({ role: z.enum(['system', 'user']), content: TEXT })).max(8),
});
export type CleanupTraceRequest = z.infer<typeof CleanupTraceRequestSchema>;

export const CleanupTraceResponseSchema = z.strictObject({
  /** The provider's JSON as received (pretty-printed when only the parsed value reached the recorder). */
  raw: TEXT,
  /** The assistant message before any stripping. */
  content: TEXT.optional(),
  /** The model's thinking, when the provider sent it in its own field. */
  reasoning: TEXT.optional(),
  finishReason: z.string().max(64).optional(),
  usage: CleanupTraceUsageSchema.optional(),
  steps: z.array(CleanupTraceStepSchema).max(8),
  verdict: z.enum(['cleaned', 'kept_raw', 'unusable']),
  /** The guard's sentence, or why the reply was unusable. */
  reason: z.string().max(400).optional(),
});
export type CleanupTraceResponse = z.infer<typeof CleanupTraceResponseSchema>;

export const CleanupTraceTimingsSchema = z.strictObject({
  /** Wall-clock start, epoch milliseconds. Absent where the recorder has only a monotonic clock. */
  startedAt: z.number().int().nonnegative().optional(),
  /** When the response headers arrived, from the start of the attempt. Absent where unobservable. */
  firstByteMs: NonNegativeFiniteSchema.optional(),
  totalMs: NonNegativeFiniteSchema,
});
export type CleanupTraceTimings = z.infer<typeof CleanupTraceTimingsSchema>;

export const CleanupTraceAttemptSchema = z.strictObject({
  /** The conversation went along on this attempt. */
  withContext: z.boolean(),
  request: CleanupTraceRequestSchema,
  /** The provider's HTTP status, when one came back. */
  status: z.number().int().min(100).max(599).optional(),
  response: CleanupTraceResponseSchema.optional(),
  /** The provider's body on a non-2xx status, or a 2xx body that was not JSON; capped, read only because a record was asked for. */
  errorBody: TEXT.optional(),
  /** Why the attempt produced no reply: a sentence, never a credential. */
  failure: z.string().max(400).optional(),
  timings: CleanupTraceTimingsSchema,
});
export type CleanupTraceAttempt = z.infer<typeof CleanupTraceAttemptSchema>;

export const CleanupTraceSchema = z.strictObject({
  /** Which path made the call: this browser with its own key, or a daemon with its. */
  via: z.enum(['device', 'daemon']),
  provider: z.string().min(1).max(32),
  model: z.string().min(1).max(128),
  host: z.string().min(1).max(253),
  startedAt: z.number().int().nonnegative().optional(),
  totalMs: NonNegativeFiniteSchema,
  outcome: z.enum(['cleaned', 'kept_raw', 'failed']),
  /** The words that were kept. Absent when the call failed before any reply could be judged. */
  finalText: TEXT.optional(),
  failure: z.strictObject({ code: z.string().max(64).optional(), message: z.string().max(400) }).optional(),
  attempts: z.array(CleanupTraceAttemptSchema).min(1).max(2),
});
export type CleanupTrace = z.infer<typeof CleanupTraceSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const counted = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

const words = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The request as a person reads it: where it went, what headers it carried (redacted), what it asked for. */
export function describeCleanupRequest(input: {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ChatCompletionBody;
}): CleanupTraceRequest {
  const url = new URL(input.endpoint);
  const { messages, ...params } = input.body;
  return {
    host: url.host,
    path: url.pathname,
    headers: redactTraceHeaders(input.headers),
    params,
    messages: messages.map(({ role, content }) => ({ role, content })),
  };
}

function describeUsage(payload: Record<string, unknown>): CleanupTraceUsage | undefined {
  const usage = payload.usage;
  if (!isRecord(usage)) return undefined;
  const details = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  const fields: CleanupTraceUsage = {
    ...(counted(usage.prompt_tokens) === undefined ? {} : { promptTokens: counted(usage.prompt_tokens) }),
    ...(counted(usage.completion_tokens) === undefined ? {} : { completionTokens: counted(usage.completion_tokens) }),
    ...(counted(usage.total_tokens) === undefined ? {} : { totalTokens: counted(usage.total_tokens) }),
    ...(counted(details.reasoning_tokens) === undefined ? {} : { reasoningTokens: counted(details.reasoning_tokens) }),
  };
  return Object.keys(fields).length === 0 ? undefined : fields;
}

/**
 * The provider's 2xx reply, taken apart the way the shared cleanup takes it apart: the message before
 * stripping, the thinking the provider sent separately, the usage, and the steps between the reply and
 * the words that were kept. `raw` is the provider's text when the caller has it, else the parsed value
 * printed back.
 */
export function describeCleanupReply(payload: unknown, request: CleanupRequest, raw?: string): CleanupTraceResponse {
  const first = isRecord(payload) && Array.isArray(payload.choices) ? (payload.choices as unknown[])[0] : undefined;
  const choice = isRecord(first) ? first : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content = words(message.content);
  const reasoning = words(message.reasoning) ?? words(message.reasoning_content);
  const usage = isRecord(payload) ? describeUsage(payload) : undefined;
  const reply = readCleanupReply(payload, request);

  const steps: CleanupTraceStep[] = [];
  if (content !== undefined) {
    const removed = content.length - withoutReasoning(content).length;
    if (removed > 0) {
      steps.push({
        step: 'reasoning_stripped',
        detail: `removed ${String(removed)} characters of thinking from the reply`,
      });
    }
  }
  if (reply.kind === 'cleaned') steps.push({ step: 'guard_passed' });
  if (reply.kind === 'kept_raw') {
    steps.push(
      { step: 'guard_rejected', detail: reply.reason },
      { step: 'kept_raw', detail: 'the dictation was kept as spoken' },
    );
  }
  if (reply.kind === 'unusable') steps.push({ step: 'unusable', detail: reply.reason });

  return {
    raw: raw ?? JSON.stringify(payload, null, 2),
    ...(content === undefined ? {} : { content }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(words(choice.finish_reason) === undefined ? {} : { finishReason: words(choice.finish_reason) }),
    ...(usage === undefined ? {} : { usage }),
    steps,
    verdict: reply.kind,
    ...(reply.kind === 'cleaned' ? {} : { reason: reply.reason }),
  };
}
