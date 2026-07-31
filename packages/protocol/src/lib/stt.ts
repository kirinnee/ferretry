import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

export const STT_SAMPLE_RATE = 16_000 as const;
export const STT_CHANNELS = 1 as const;
export const STT_BITS_PER_SAMPLE = 16 as const;
export const STT_MAX_DURATION_SECONDS = 120;
export const STT_MAX_SAMPLES = STT_SAMPLE_RATE * STT_MAX_DURATION_SECONDS;
export const STT_MAX_PCM_BYTES = STT_MAX_SAMPLES * (STT_BITS_PER_SAMPLE / 8);

export const SttErrorCodeSchema = z.enum([
  'bad_request',
  'bad_audio',
  'too_long',
  'unsupported_language',
  'busy',
  'model_missing',
  'model_not_found',
  'model_installing',
  'install_failed',
  'native_missing',
  'load_failed',
  'decode_failed',
  'worker_unavailable',
  'worker_crashed',
  'service_closed',
  'not_found',
  'method_not_allowed',
]);
export type SttErrorCode = z.infer<typeof SttErrorCodeSchema>;

export const SttErrorViewSchema = z.object({
  error: z.string().min(1),
  code: SttErrorCodeSchema,
});
export type SttErrorView = z.infer<typeof SttErrorViewSchema>;

export const SttModelKindSchema = z.enum(['daemon', 'browser']);
export type SttModelKind = z.infer<typeof SttModelKindSchema>;

export const SttCostViewSchema = z.object({
  downloadBytes: NonNegativeIntegerSchema,
  diskBytes: NonNegativeIntegerSchema,
  ramBytesApprox: NonNegativeIntegerSchema,
  summary: z.string(),
});
export type SttCostView = z.infer<typeof SttCostViewSchema>;

const InstallProgressShape = {
  modelId: z.string().min(1),
  receivedBytes: NonNegativeIntegerSchema,
  totalBytes: NonNegativeIntegerSchema,
};

const IdleInstallStatusSchema = z.object({ ...InstallProgressShape, phase: z.literal('idle') });
const FailedInstallStatusSchema = z.object({
  ...InstallProgressShape,
  phase: z.literal('failed'),
  startedAt: InstantSchema.optional(),
  finishedAt: InstantSchema,
  message: z.string().min(1),
  code: SttErrorCodeSchema,
});

export const SttInstallStatusSchema = z.discriminatedUnion('phase', [
  IdleInstallStatusSchema,
  z.object({ ...InstallProgressShape, phase: z.literal('downloading'), startedAt: InstantSchema }),
  z.object({ ...InstallProgressShape, phase: z.literal('extracting'), startedAt: InstantSchema }),
  z.object({ ...InstallProgressShape, phase: z.literal('verifying'), startedAt: InstantSchema }),
  z.object({
    ...InstallProgressShape,
    phase: z.literal('ready'),
    startedAt: InstantSchema.optional(),
    finishedAt: InstantSchema,
  }),
  FailedInstallStatusSchema,
]);
export type SttInstallStatus = z.infer<typeof SttInstallStatusSchema>;

const ModelBaseShape = {
  id: z.string().min(1),
  kind: SttModelKindSchema,
  label: z.string().min(1),
  languages: z.array(z.string().min(1)).min(1),
  costs: SttCostViewSchema,
};

export const SttModelStatusSchema = z.discriminatedUnion('state', [
  z.object({
    ...ModelBaseShape,
    state: z.literal('not-installed'),
    install: z.union([IdleInstallStatusSchema, FailedInstallStatusSchema]),
  }),
  z.object({
    ...ModelBaseShape,
    state: z.literal('installing'),
    install: z.union([
      z.object({ ...InstallProgressShape, phase: z.literal('downloading'), startedAt: InstantSchema }),
      z.object({ ...InstallProgressShape, phase: z.literal('extracting'), startedAt: InstantSchema }),
      z.object({ ...InstallProgressShape, phase: z.literal('verifying'), startedAt: InstantSchema }),
    ]),
  }),
  z.object({
    ...ModelBaseShape,
    state: z.literal('ready'),
    installedAt: InstantSchema,
    files: z.array(
      z.object({
        name: z.string().min(1),
        bytes: NonNegativeIntegerSchema,
        sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      }),
    ),
    install: z.object({
      ...InstallProgressShape,
      phase: z.literal('ready'),
      startedAt: InstantSchema.optional(),
      finishedAt: InstantSchema,
    }),
  }),
  z.object({
    ...ModelBaseShape,
    state: z.literal('error'),
    install: z.object({
      ...InstallProgressShape,
      phase: z.literal('failed'),
      startedAt: InstantSchema.optional(),
      finishedAt: InstantSchema,
      message: z.string().min(1),
      code: SttErrorCodeSchema,
    }),
  }),
]);
export type SttModelStatus = z.infer<typeof SttModelStatusSchema>;

export const SttModelListResponseSchema = z.object({
  models: z.object({ daemon: SttModelStatusSchema, browser: SttModelStatusSchema }),
});
export type SttModelListResponse = z.infer<typeof SttModelListResponseSchema>;

const WorkerFailureSchema = z.object({
  code: SttErrorCodeSchema,
  message: z.string().min(1),
  at: InstantSchema,
});

export const SttWorkerStatusSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('cold') }),
  z.object({
    phase: z.literal('loading'),
    pid: PositiveIntegerSchema.optional(),
    modelId: z.string().min(1).optional(),
  }),
  z.object({
    phase: z.literal('ready'),
    pid: PositiveIntegerSchema,
    modelId: z.string().min(1),
    loadedAt: InstantSchema,
  }),
  z.object({
    phase: z.literal('busy'),
    pid: PositiveIntegerSchema,
    modelId: z.string().min(1),
    loadedAt: InstantSchema,
  }),
  z.object({
    phase: z.literal('error'),
    pid: PositiveIntegerSchema.optional(),
    modelId: z.string().optional(),
    lastError: WorkerFailureSchema,
  }),
  z.object({ phase: z.literal('closed') }),
]);
export type SttWorkerStatus = z.infer<typeof SttWorkerStatusSchema>;

export const SttStatusSchema = z
  .object({
    available: z.boolean(),
    streaming: z.literal(false),
    mode: z.literal('batch'),
    language: z.literal('en'),
    languages: z.tuple([z.literal('en')]),
    worker: SttWorkerStatusSchema,
    models: z.object({
      daemon: SttModelStatusSchema,
      browser: SttModelStatusSchema,
    }),
    limits: z.object({
      sampleRate: z.literal(STT_SAMPLE_RATE),
      channels: z.literal(STT_CHANNELS),
      bitsPerSample: z.literal(STT_BITS_PER_SAMPLE),
      maxDurationSeconds: PositiveIntegerSchema,
      maxPcmBytes: PositiveIntegerSchema,
    }),
  })
  .superRefine((value, context) => {
    const expected =
      value.models.daemon.state === 'ready' && value.worker.phase !== 'closed' && value.worker.phase !== 'error';
    if (value.available !== expected) {
      context.addIssue({ code: 'custom', message: 'available must reflect the daemon model and worker state' });
    }
  });
export type SttStatus = z.infer<typeof SttStatusSchema>;

export const SttTranscriptSchema = z.object({
  text: z.string(),
  audioMs: NonNegativeFiniteSchema,
  decodeMs: NonNegativeFiniteSchema,
  rtf: NonNegativeFiniteSchema,
  modelId: z.string().min(1),
  language: z.literal('en'),
  mode: z.literal('batch'),
  streaming: z.literal(false),
});
export type SttTranscript = z.infer<typeof SttTranscriptSchema>;

export const SttEnhancementProviderSchema = z.literal('groq');
export type SttEnhancementProvider = z.infer<typeof SttEnhancementProviderSchema>;

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
    .max(128)
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

export const SttWorkerModelSchema = z.object({
  id: z.string().min(1),
  directory: z.string().min(1),
  encoder: z.string().min(1),
  decoder: z.string().min(1),
  joiner: z.string().min(1),
  tokens: z.string().min(1),
});
export type SttWorkerModel = z.infer<typeof SttWorkerModelSchema>;

export const SttWorkerRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('load'),
    requestId: z.string().min(1),
    model: SttWorkerModelSchema,
    threads: PositiveIntegerSchema,
  }),
  z.object({
    type: z.literal('transcribe'),
    requestId: z.string().min(1),
    sampleRate: z.literal(STT_SAMPLE_RATE),
    audio: z.instanceof(Float32Array),
  }),
  z.object({ type: z.literal('shutdown') }),
]);
export type SttWorkerRequest = z.infer<typeof SttWorkerRequestSchema>;

export const SttWorkerResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    requestId: z.string().min(1),
    modelId: z.string().min(1),
    loadMs: NonNegativeFiniteSchema,
  }),
  z.object({
    type: z.literal('result'),
    requestId: z.string().min(1),
    modelId: z.string().min(1),
    text: z.string(),
    audioMs: NonNegativeFiniteSchema,
    decodeMs: NonNegativeFiniteSchema,
  }),
  z.object({
    type: z.literal('error'),
    requestId: z.string().min(1).optional(),
    code: z.enum([
      'bad_request',
      'bad_audio',
      'too_long',
      'model_missing',
      'native_missing',
      'load_failed',
      'decode_failed',
    ]),
    message: z.string().min(1),
  }),
  z.object({ type: z.literal('bye') }),
]);
export type SttWorkerResponse = z.infer<typeof SttWorkerResponseSchema>;
