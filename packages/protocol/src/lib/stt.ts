import { z } from 'zod';
import { NonNegativeFiniteSchema } from './common.ts';

/**
 * Dictation enhancement, and nothing else.
 *
 * Recognition happens in the browser, so the wire shapes it used to need — audio limits, model
 * catalogues, install progress, worker traffic and a transcript envelope — are gone with it. What
 * remains is the one exchange a browser cannot perform itself: a repaired transcript from a hosted
 * chat model, spoken to a daemon because only the daemon holds the provider credential.
 *
 * The request carries a provider ID and an optional model ID and NEVER a credential; the daemon reads
 * that from its own environment. Every bound below is the contract the daemon enforces again on
 * arrival, so a client can refuse an over-long transcript before spending a round trip on it.
 */

export const SttEnhancementProviderSchema = z.literal('groq');
export type SttEnhancementProvider = z.infer<typeof SttEnhancementProviderSchema>;

/**
 * How many vocabulary entries one request may carry.
 *
 * Exported because it is the ONLY dictionary bound on this wire, and a client that guesses a larger
 * one loses every correction rather than a few terms: the daemon re-parses with this same schema and
 * refuses the whole request. A reader's own dictionary may be longer — a client is expected to send
 * the first entries up to this limit rather than refuse the transcript.
 */
export const MAX_STT_DICTIONARY_ENTRIES = 128;

export const SttEnhancementRequestSchema = z.strictObject({
  text: z.string().max(8_000),
  provider: SttEnhancementProviderSchema,
  model: z.string().trim().min(1).max(128).optional(),
  context: z.array(z.string()).max(10).optional(),
  userContext: z.string().max(2_000).optional(),
  dictionary: z
    .array(
      z.strictObject({
        term: z.string().trim().min(1).max(64),
        aliases: z.array(z.string().trim().min(1).max(64)).optional(),
      }),
    )
    .max(MAX_STT_DICTIONARY_ENTRIES)
    .optional(),
});
export type SttEnhancementRequest = z.infer<typeof SttEnhancementRequestSchema>;

export const SttEnhancementResultSchema = z.object({
  text: z.string().max(16_000),
  provider: SttEnhancementProviderSchema,
  model: z.string().min(1),
  latencyMs: NonNegativeFiniteSchema,
});
export type SttEnhancementResult = z.infer<typeof SttEnhancementResultSchema>;

export const SttEnhancementErrorCodeSchema = z.enum([
  'bad_request',
  'too_long',
  'provider_unknown',
  'bad_model',
  'secret_missing',
  'secret_invalid',
  'rate_limited',
  'timeout',
  'provider_unreachable',
  'provider_error',
  'malformed_response',
]);
export type SttEnhancementErrorCode = z.infer<typeof SttEnhancementErrorCodeSchema>;

export const SttEnhancementErrorViewSchema = z.object({
  error: z.string().min(1),
  code: SttEnhancementErrorCodeSchema,
});
export type SttEnhancementErrorView = z.infer<typeof SttEnhancementErrorViewSchema>;
