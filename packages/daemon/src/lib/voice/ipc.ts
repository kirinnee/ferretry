import { z } from 'zod';

/** Internal process boundary. Advanced IPC preserves the typed array, never JSON audio. */
export const VOICE_WORKER_THREADS_ENV = 'FY_VOICE_WORKER_THREADS';
export const VOICE_IPC_VERSION = 1;
export const VOICE_SAMPLE_RATE = 16_000;
export const VoiceRecognizerDescriptionSchema = z.object({
  modelId: z.string().min(1).max(128),
  modelBytes: z.number().int().nonnegative(),
  peakResidentBytes: z.number().int().nonnegative(),
  streaming: z.boolean(),
  threads: z.number().int().min(1).max(4),
});
export type VoiceRecognizerDescription = z.infer<typeof VoiceRecognizerDescriptionSchema>;
export const VoiceRecognizerSetSchema = z
  .array(VoiceRecognizerDescriptionSchema)
  .min(1)
  .max(2)
  .refine(
    models =>
      new Set(models.map(model => model.streaming)).size === models.length &&
      new Set(models.map(model => model.modelId)).size === models.length,
    'Load at most one batch and one streaming recognizer.',
  )
  .readonly();
export type VoiceRecognizerSet = z.infer<typeof VoiceRecognizerSetSchema>;
const VoiceFailureCodeSchema = z.enum([
  'voice_not_installed',
  'voice_busy',
  'voice_no_memory',
  'engine_behind',
  'engine_timeout',
  'worker_crashed',
  'worker_memory',
  'worker_protocol',
  'voice_cancelled',
]);
export type VoiceFailureCode = z.infer<typeof VoiceFailureCodeSchema>;
const envelope = { version: z.literal(VOICE_IPC_VERSION), requestId: z.string().min(1).max(128) };
const stream = { ...envelope, streaming: z.boolean(), streamId: z.string().min(1).max(128) };
export const VoiceWorkerRequestSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('load'), recognizers: VoiceRecognizerSetSchema }),
  z.object({
    ...stream,
    type: z.literal('audio'),
    samples: z
      .instanceof(Float32Array)
      .refine(samples => samples.length <= 2 * VOICE_SAMPLE_RATE && samples.every(Number.isFinite), 'invalid audio'),
  }),
  z.object({ ...stream, type: z.literal('finish') }),
  z.object({ ...stream, type: z.literal('cancel') }),
]);
export type VoiceWorkerRequest = z.infer<typeof VoiceWorkerRequestSchema>;
export const VoiceWorkerResponseSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('health'), state: z.enum(['ready', 'loaded']) }),
  z.object({ ...stream, type: z.literal('result'), text: z.string().max(128_000), final: z.boolean() }),
  z.object({
    ...envelope,
    type: z.literal('error'),
    streamId: z.string().optional(),
    code: VoiceFailureCodeSchema,
    message: z.string().max(2_000),
  }),
]);
export type VoiceWorkerResponse = z.infer<typeof VoiceWorkerResponseSchema>;
