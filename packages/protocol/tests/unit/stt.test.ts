import { describe, it } from 'bun:test';
import should from 'should';
import type {
  SttCostView,
  SttEnhancementErrorView,
  SttEnhancementRequest,
  SttEnhancementResult,
  SttErrorView,
  SttInstallStatus,
  SttModelListResponse,
  SttModelStatus,
  SttStatus,
  SttTranscript,
  SttWorkerModel,
  SttWorkerRequest,
  SttWorkerResponse,
  SttWorkerStatus,
} from '../../src/lib/index.ts';
import * as stt from '../../src/lib/stt.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const DAEMON_MODEL_ID = 'parakeet-tdt-0.6b-v3';
const BROWSER_MODEL_ID = 'whisper-tiny-en';
const SHA256 = 'a'.repeat(64);

const costs = {
  downloadBytes: 74_000_000,
  diskBytes: 80_000_000,
  ramBytesApprox: 320_000_000,
  summary: '74 MB download · 80 MB disk · ~320 MB RAM',
} satisfies SttCostView;

/** Progress fields shared by every install phase. */
const progress = { modelId: DAEMON_MODEL_ID, receivedBytes: 74_000_000, totalBytes: 74_000_000 };
const startedProgress = { modelId: DAEMON_MODEL_ID, receivedBytes: 12_000_000, totalBytes: 74_000_000 };

const idleInstall = { ...startedProgress, receivedBytes: 0, phase: 'idle' } satisfies SttInstallStatus;
const downloadingInstall = { ...startedProgress, phase: 'downloading', startedAt: INSTANT } satisfies SttInstallStatus;
const extractingInstall = { ...progress, phase: 'extracting', startedAt: INSTANT } satisfies SttInstallStatus;
const verifyingInstall = { ...progress, phase: 'verifying', startedAt: INSTANT } satisfies SttInstallStatus;
const readyInstall = {
  ...progress,
  phase: 'ready',
  startedAt: INSTANT,
  finishedAt: LATER_INSTANT,
} satisfies SttInstallStatus;
/** A ready install whose start was not recorded — the resumed-download case. */
const adoptedReadyInstall = { ...progress, phase: 'ready', finishedAt: LATER_INSTANT } satisfies SttInstallStatus;
const failedInstall = {
  ...startedProgress,
  phase: 'failed',
  startedAt: INSTANT,
  finishedAt: LATER_INSTANT,
  message: 'sha256 mismatch on encoder.onnx',
  code: 'install_failed',
} satisfies SttInstallStatus;

const daemonBase = {
  id: DAEMON_MODEL_ID,
  kind: 'daemon' as const,
  label: 'Parakeet TDT 0.6B v3',
  languages: ['en'],
  costs,
};

const notInstalledDaemon = { ...daemonBase, state: 'not-installed', install: idleInstall } satisfies SttModelStatus;
const installingDaemon = { ...daemonBase, state: 'installing', install: downloadingInstall } satisfies SttModelStatus;
const readyDaemon = {
  ...daemonBase,
  state: 'ready',
  installedAt: LATER_INSTANT,
  files: [
    { name: 'encoder.onnx', bytes: 60_000_000, sha256: SHA256 },
    { name: 'tokens.txt', bytes: 12_000, sha256: 'b'.repeat(64) },
  ],
  install: readyInstall,
} satisfies SttModelStatus;
const erroredDaemon = { ...daemonBase, state: 'error', install: failedInstall } satisfies SttModelStatus;

const browserModel = {
  id: BROWSER_MODEL_ID,
  kind: 'browser' as const,
  label: 'Whisper Tiny (in-browser)',
  languages: ['en'],
  costs: { ...costs, summary: '39 MB download · 39 MB disk · ~120 MB RAM' },
  state: 'not-installed',
  install: { modelId: BROWSER_MODEL_ID, receivedBytes: 0, totalBytes: 39_000_000, phase: 'idle' },
} satisfies SttModelStatus;

const modelList = { models: { daemon: readyDaemon, browser: browserModel } } satisfies SttModelListResponse;

const coldWorker = { phase: 'cold' } satisfies SttWorkerStatus;
const loadingWorker = { phase: 'loading', pid: 4_242, modelId: DAEMON_MODEL_ID } satisfies SttWorkerStatus;
/** The worker is spawning; the pid and model are not known yet. */
const bareLoadingWorker = { phase: 'loading' } satisfies SttWorkerStatus;
const readyWorker = {
  phase: 'ready',
  pid: 4_242,
  modelId: DAEMON_MODEL_ID,
  loadedAt: LATER_INSTANT,
} satisfies SttWorkerStatus;
const busyWorker = { ...readyWorker, phase: 'busy' } satisfies SttWorkerStatus;
const erroredWorker = {
  phase: 'error',
  pid: 4_242,
  modelId: DAEMON_MODEL_ID,
  lastError: { code: 'worker_crashed', message: 'worker exited with signal SIGSEGV', at: LATER_INSTANT },
} satisfies SttWorkerStatus;
/** A load that failed before the worker process existed. */
const bareErroredWorker = {
  phase: 'error',
  lastError: { code: 'native_missing', message: 'sherpa-onnx native module is missing', at: INSTANT },
} satisfies SttWorkerStatus;
const closedWorker = { phase: 'closed' } satisfies SttWorkerStatus;

const limits = {
  sampleRate: stt.STT_SAMPLE_RATE,
  channels: stt.STT_CHANNELS,
  bitsPerSample: stt.STT_BITS_PER_SAMPLE,
  maxDurationSeconds: stt.STT_MAX_DURATION_SECONDS,
  maxPcmBytes: stt.STT_MAX_PCM_BYTES,
} as const;

const statusBase = {
  streaming: false,
  mode: 'batch',
  language: 'en',
  languages: ['en'],
  limits,
} satisfies Omit<SttStatus, 'available' | 'models' | 'worker'>;

const availableStatus = {
  ...statusBase,
  available: true,
  worker: readyWorker,
  models: { daemon: readyDaemon, browser: browserModel },
} satisfies SttStatus;
const unavailableStatus = {
  ...statusBase,
  available: false,
  worker: coldWorker,
  models: { daemon: notInstalledDaemon, browser: browserModel },
} satisfies SttStatus;

const transcript = {
  text: 'ship the protocol package',
  audioMs: 1_480,
  decodeMs: 296,
  rtf: 0.2,
  modelId: DAEMON_MODEL_ID,
  language: 'en',
  mode: 'batch',
  streaming: false,
} satisfies SttTranscript;

const enhancementRequest = {
  text: 'ship the protocol package',
  provider: 'groq',
  model: 'moonshotai/kimi-k2-instruct',
  context: ['previous turn', 'current turn'],
  userContext: 'The speaker is dictating commit messages.',
  dictionary: [{ term: 'ferretry', aliases: ['ferret tree', 'ferretree'] }, { term: 'kteam' }],
} satisfies SttEnhancementRequest;
const minimalEnhancementRequest = { text: '', provider: 'groq' } satisfies SttEnhancementRequest;

const enhancementResult = {
  text: 'Ship the protocol package.',
  provider: 'groq',
  model: 'moonshotai/kimi-k2-instruct',
  latencyMs: 412,
} satisfies SttEnhancementResult;

const errorView = { error: 'audio exceeds the maximum duration', code: 'too_long' } satisfies SttErrorView;
const enhancementErrorView = {
  error: 'GROQ_API_KEY is not configured',
  code: 'secret_missing',
} satisfies SttEnhancementErrorView;

const workerModel = {
  id: DAEMON_MODEL_ID,
  directory: '/state/models/parakeet-tdt-0.6b-v3',
  encoder: 'encoder.onnx',
  decoder: 'decoder.onnx',
  joiner: 'joiner.onnx',
  tokens: 'tokens.txt',
} satisfies SttWorkerModel;

const loadRequest = {
  type: 'load',
  requestId: 'request-1',
  model: workerModel,
  threads: 4,
} satisfies SttWorkerRequest;
const transcribeRequest = {
  type: 'transcribe',
  requestId: 'request-2',
  sampleRate: stt.STT_SAMPLE_RATE,
  audio: new Float32Array([0, 0.5, -0.5]),
} satisfies SttWorkerRequest;
const shutdownRequest = { type: 'shutdown' } satisfies SttWorkerRequest;

const readyResponse = {
  type: 'ready',
  requestId: 'request-1',
  modelId: DAEMON_MODEL_ID,
  loadMs: 812,
} satisfies SttWorkerResponse;
const resultResponse = {
  type: 'result',
  requestId: 'request-2',
  modelId: DAEMON_MODEL_ID,
  text: 'ship the protocol package',
  audioMs: 1_480,
  decodeMs: 296,
} satisfies SttWorkerResponse;
const errorResponse = {
  type: 'error',
  requestId: 'request-2',
  code: 'decode_failed',
  message: 'decoder returned no tokens',
} satisfies SttWorkerResponse;
const byeResponse = { type: 'bye' } satisfies SttWorkerResponse;
/** Silence still transcribes; the worker reports an empty transcript rather than an error. */
const silentResultResponse = { ...resultResponse, text: '' } satisfies SttWorkerResponse;

const sttCases: SchemaCase[] = [
  { name: 'error code', schema: stt.SttErrorCodeSchema, value: 'busy' },
  { name: 'error view', schema: stt.SttErrorViewSchema, value: errorView },
  { name: 'model kind', schema: stt.SttModelKindSchema, value: 'daemon' },
  { name: 'cost view', schema: stt.SttCostViewSchema, value: costs },
  { name: 'install status', schema: stt.SttInstallStatusSchema, value: downloadingInstall },
  { name: 'model status', schema: stt.SttModelStatusSchema, value: readyDaemon },
  { name: 'model list response', schema: stt.SttModelListResponseSchema, value: modelList },
  { name: 'worker status', schema: stt.SttWorkerStatusSchema, value: readyWorker },
  { name: 'status', schema: stt.SttStatusSchema, value: availableStatus },
  { name: 'transcript', schema: stt.SttTranscriptSchema, value: transcript },
  { name: 'enhancement provider', schema: stt.SttEnhancementProviderSchema, value: 'groq' },
  { name: 'enhancement request', schema: stt.SttEnhancementRequestSchema, value: enhancementRequest },
  { name: 'enhancement result', schema: stt.SttEnhancementResultSchema, value: enhancementResult },
  { name: 'enhancement error code', schema: stt.SttEnhancementErrorCodeSchema, value: 'rate_limited' },
  { name: 'enhancement error view', schema: stt.SttEnhancementErrorViewSchema, value: enhancementErrorView },
  { name: 'worker model', schema: stt.SttWorkerModelSchema, value: workerModel },
  { name: 'worker request', schema: stt.SttWorkerRequestSchema, value: loadRequest },
  { name: 'worker response', schema: stt.SttWorkerResponseSchema, value: resultResponse },
];

describe('stt schemas', () => {
  it('should round-trip every public STT schema', () => {
    // Arrange
    const cases = sttCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(stt, cases);
  });

  it('should derive the PCM budget from the sample rate, duration, and bit depth', () => {
    // Arrange
    const bytesPerSample = stt.STT_BITS_PER_SAMPLE / 8;

    // Act
    const parsed = stt.SttStatusSchema.parse(availableStatus);

    // Assert
    should(stt.STT_MAX_SAMPLES).equal(stt.STT_SAMPLE_RATE * stt.STT_MAX_DURATION_SECONDS);
    should(stt.STT_MAX_PCM_BYTES).equal(stt.STT_MAX_SAMPLES * bytesPerSample);
    should(stt.STT_CHANNELS).equal(1);
    should(parsed.limits).deepEqual(limits);
  });

  it('should resolve every error, enhancement-error, model-kind, and provider member', () => {
    // Arrange
    const enums = [
      {
        schema: stt.SttErrorCodeSchema,
        members: [
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
        ],
      },
      {
        schema: stt.SttEnhancementErrorCodeSchema,
        members: [
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
        ],
      },
      { schema: stt.SttModelKindSchema, members: ['daemon', 'browser'] },
      { schema: stt.SttEnhancementProviderSchema, members: ['groq'] },
    ];

    // Act + Assert
    for (const entry of enums) {
      for (const member of entry.members) should(entry.schema.parse(member)).equal(member);
      should(entry.schema.safeParse('nonesuch').success).be.false();
    }
    should(stt.SttErrorCodeSchema.options).have.length(17);
    should(stt.SttEnhancementErrorCodeSchema.options).have.length(11);
  });

  it('should resolve every install phase with the timestamps that phase requires', () => {
    // Arrange
    const statuses = [
      idleInstall,
      downloadingInstall,
      extractingInstall,
      verifyingInstall,
      readyInstall,
      adoptedReadyInstall,
      failedInstall,
    ];

    // Act
    const parsed = statuses.map(value => stt.SttInstallStatusSchema.parse(value));

    // Assert
    should(parsed).deepEqual(statuses);
    should(parsed.map(entry => entry.phase)).deepEqual([
      'idle',
      'downloading',
      'extracting',
      'verifying',
      'ready',
      'ready',
      'failed',
    ]);
    should(stt.SttInstallStatusSchema.safeParse({ ...failedInstall, startedAt: undefined }).success).be.true();
  });

  it('should reject install statuses that omit or contradict their phase fields', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'unknown phase', schema: stt.SttInstallStatusSchema, value: { ...progress, phase: 'paused' } },
      { name: 'no phase at all', schema: stt.SttInstallStatusSchema, value: progress },
      {
        name: 'downloading without a start',
        schema: stt.SttInstallStatusSchema,
        value: { ...progress, phase: 'downloading' },
      },
      {
        name: 'extracting without a start',
        schema: stt.SttInstallStatusSchema,
        value: { ...progress, phase: 'extracting' },
      },
      {
        name: 'verifying without a start',
        schema: stt.SttInstallStatusSchema,
        value: { ...progress, phase: 'verifying' },
      },
      { name: 'ready without a finish', schema: stt.SttInstallStatusSchema, value: { ...progress, phase: 'ready' } },
      {
        name: 'failed without a message',
        schema: stt.SttInstallStatusSchema,
        value: { ...progress, phase: 'failed', finishedAt: LATER_INSTANT, code: 'install_failed' },
      },
      {
        name: 'failed with an empty message',
        schema: stt.SttInstallStatusSchema,
        value: { ...failedInstall, message: '' },
      },
      {
        name: 'failed without a code',
        schema: stt.SttInstallStatusSchema,
        value: { ...progress, phase: 'failed', finishedAt: LATER_INSTANT, message: 'boom' },
      },
      {
        name: 'failed with an unknown code',
        schema: stt.SttInstallStatusSchema,
        value: { ...failedInstall, code: 'disk_full' },
      },
      {
        name: 'idle with an empty model id',
        schema: stt.SttInstallStatusSchema,
        value: { ...idleInstall, modelId: '' },
      },
      {
        name: 'negative received bytes',
        schema: stt.SttInstallStatusSchema,
        value: { ...downloadingInstall, receivedBytes: -1 },
      },
      {
        name: 'fractional total bytes',
        schema: stt.SttInstallStatusSchema,
        value: { ...downloadingInstall, totalBytes: 1.5 },
      },
      {
        name: 'unanchored start instant',
        schema: stt.SttInstallStatusSchema,
        value: { ...downloadingInstall, startedAt: '2026-07-30T12:00:00' },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should pair every model state with only the install phases that state allows', () => {
    // Arrange
    const allowed = [
      { state: 'not-installed', installs: [idleInstall, failedInstall] },
      { state: 'installing', installs: [downloadingInstall, extractingInstall, verifyingInstall] },
      { state: 'ready', installs: [readyInstall, adoptedReadyInstall] },
      { state: 'error', installs: [failedInstall] },
    ];
    const extras: Readonly<Record<string, unknown>> = {
      ready: { installedAt: LATER_INSTANT, files: readyDaemon.files },
    };

    // Act
    const parsed = allowed.flatMap(entry =>
      entry.installs.map(install =>
        stt.SttModelStatusSchema.parse({ ...daemonBase, ...(extras[entry.state] ?? {}), state: entry.state, install }),
      ),
    );

    // Assert
    should(parsed.map(entry => entry.state)).deepEqual([
      'not-installed',
      'not-installed',
      'installing',
      'installing',
      'installing',
      'ready',
      'ready',
      'error',
    ]);
    should(parsed.map(entry => entry.install.phase)).deepEqual([
      'idle',
      'failed',
      'downloading',
      'extracting',
      'verifying',
      'ready',
      'ready',
      'failed',
    ]);
    for (const value of [notInstalledDaemon, installingDaemon, readyDaemon, erroredDaemon, browserModel]) {
      should(stt.SttModelStatusSchema.safeParse(value).success).be.true();
    }
  });

  it('should reject model states whose install phase or file list disagrees', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'not-installed while downloading',
        schema: stt.SttModelStatusSchema,
        value: { ...notInstalledDaemon, install: downloadingInstall },
      },
      {
        name: 'not-installed while ready',
        schema: stt.SttModelStatusSchema,
        value: { ...notInstalledDaemon, install: readyInstall },
      },
      {
        name: 'installing while idle',
        schema: stt.SttModelStatusSchema,
        value: { ...installingDaemon, install: idleInstall },
      },
      {
        name: 'installing while failed',
        schema: stt.SttModelStatusSchema,
        value: { ...installingDaemon, install: failedInstall },
      },
      {
        name: 'ready with a failed install',
        schema: stt.SttModelStatusSchema,
        value: { ...readyDaemon, install: failedInstall },
      },
      {
        name: 'ready without an installed instant',
        schema: stt.SttModelStatusSchema,
        value: { ...daemonBase, state: 'ready', files: readyDaemon.files, install: readyInstall },
      },
      {
        name: 'ready without a file list',
        schema: stt.SttModelStatusSchema,
        value: { ...daemonBase, state: 'ready', installedAt: LATER_INSTANT, install: readyInstall },
      },
      {
        name: 'ready with an uppercase digest',
        schema: stt.SttModelStatusSchema,
        value: { ...readyDaemon, files: [{ name: 'encoder.onnx', bytes: 1, sha256: SHA256.toUpperCase() }] },
      },
      {
        name: 'ready with a truncated digest',
        schema: stt.SttModelStatusSchema,
        value: { ...readyDaemon, files: [{ name: 'encoder.onnx', bytes: 1, sha256: 'a'.repeat(63) }] },
      },
      {
        name: 'error with an idle install',
        schema: stt.SttModelStatusSchema,
        value: { ...erroredDaemon, install: idleInstall },
      },
      { name: 'unknown state', schema: stt.SttModelStatusSchema, value: { ...notInstalledDaemon, state: 'stale' } },
      { name: 'unknown kind', schema: stt.SttModelStatusSchema, value: { ...notInstalledDaemon, kind: 'remote' } },
      { name: 'empty label', schema: stt.SttModelStatusSchema, value: { ...notInstalledDaemon, label: '' } },
      { name: 'no languages', schema: stt.SttModelStatusSchema, value: { ...notInstalledDaemon, languages: [] } },
      {
        name: 'blank language tag',
        schema: stt.SttModelStatusSchema,
        value: { ...notInstalledDaemon, languages: [''] },
      },
      {
        name: 'costs missing a summary',
        schema: stt.SttCostViewSchema,
        value: { downloadBytes: 1, diskBytes: 1, ramBytesApprox: 1 },
      },
      { name: 'negative disk cost', schema: stt.SttCostViewSchema, value: { ...costs, diskBytes: -1 } },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should require the model list to carry both the daemon and the browser model', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'no browser model', schema: stt.SttModelListResponseSchema, value: { models: { daemon: readyDaemon } } },
      {
        name: 'no daemon model',
        schema: stt.SttModelListResponseSchema,
        value: { models: { browser: browserModel } },
      },
      { name: 'no wrapper', schema: stt.SttModelListResponseSchema, value: { daemon: readyDaemon } },
      {
        name: 'invalid nested model',
        schema: stt.SttModelListResponseSchema,
        value: { models: { daemon: { ...readyDaemon, install: idleInstall }, browser: browserModel } },
      },
    ];

    // Act
    const parsed = stt.SttModelListResponseSchema.parse(modelList);

    // Assert
    should(Object.keys(parsed.models).sort()).deepEqual(['browser', 'daemon']);
    should(parsed.models.daemon.kind).equal('daemon');
    should(parsed.models.browser.kind).equal('browser');
    assertRejects(cases);
  });

  it('should resolve every worker phase and honour its optional pid and model id', () => {
    // Arrange
    const statuses = [
      coldWorker,
      loadingWorker,
      bareLoadingWorker,
      readyWorker,
      busyWorker,
      erroredWorker,
      bareErroredWorker,
      closedWorker,
    ];

    // Act
    const parsed = statuses.map(value => stt.SttWorkerStatusSchema.parse(value));

    // Assert
    should(parsed).deepEqual(statuses);
    should(new Set(parsed.map(entry => entry.phase)).size).equal(6);
  });

  it('should reject worker statuses that omit the fields their phase requires', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'unknown phase', schema: stt.SttWorkerStatusSchema, value: { phase: 'draining' } },
      { name: 'ready without a pid', schema: stt.SttWorkerStatusSchema, value: { ...readyWorker, pid: undefined } },
      {
        name: 'ready without a load instant',
        schema: stt.SttWorkerStatusSchema,
        value: { phase: 'ready', pid: 1, modelId: DAEMON_MODEL_ID },
      },
      { name: 'busy without a model', schema: stt.SttWorkerStatusSchema, value: { ...busyWorker, modelId: '' } },
      { name: 'zero pid', schema: stt.SttWorkerStatusSchema, value: { ...readyWorker, pid: 0 } },
      { name: 'fractional pid', schema: stt.SttWorkerStatusSchema, value: { ...loadingWorker, pid: 1.5 } },
      { name: 'error without a failure', schema: stt.SttWorkerStatusSchema, value: { phase: 'error', pid: 1 } },
      {
        name: 'error whose failure has an unknown code',
        schema: stt.SttWorkerStatusSchema,
        value: { ...erroredWorker, lastError: { ...erroredWorker.lastError, code: 'oom' } },
      },
      {
        name: 'error whose failure has no instant',
        schema: stt.SttWorkerStatusSchema,
        value: { phase: 'error', lastError: { code: 'load_failed', message: 'boom' } },
      },
      {
        name: 'error whose failure message is empty',
        schema: stt.SttWorkerStatusSchema,
        value: { ...erroredWorker, lastError: { ...erroredWorker.lastError, message: '' } },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should correlate availability with the daemon model state and worker phase', () => {
    // Arrange
    const daemons = [notInstalledDaemon, installingDaemon, readyDaemon, erroredDaemon];
    const workers = [coldWorker, loadingWorker, readyWorker, busyWorker, erroredWorker, closedWorker];

    // Act + Assert
    for (const daemon of daemons) {
      for (const worker of workers) {
        const expected = daemon.state === 'ready' && worker.phase !== 'closed' && worker.phase !== 'error';
        const base = { ...statusBase, worker, models: { daemon, browser: browserModel } };
        should(stt.SttStatusSchema.safeParse({ ...base, available: expected }).success).be.true();
        should(stt.SttStatusSchema.safeParse({ ...base, available: !expected }).success).be.false();
      }
    }
    should(stt.SttStatusSchema.parse(availableStatus)).deepEqual(availableStatus);
    should(stt.SttStatusSchema.parse(unavailableStatus)).deepEqual(unavailableStatus);
  });

  it('should pin the status envelope to batch English transcription', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'streaming enabled', schema: stt.SttStatusSchema, value: { ...availableStatus, streaming: true } },
      { name: 'streaming mode', schema: stt.SttStatusSchema, value: { ...availableStatus, mode: 'streaming' } },
      { name: 'other language', schema: stt.SttStatusSchema, value: { ...availableStatus, language: 'de' } },
      {
        name: 'extra language offered',
        schema: stt.SttStatusSchema,
        value: { ...availableStatus, languages: ['en', 'de'] },
      },
      { name: 'no languages offered', schema: stt.SttStatusSchema, value: { ...availableStatus, languages: [] } },
      {
        name: 'sample rate other than 16 kHz',
        schema: stt.SttStatusSchema,
        value: { ...availableStatus, limits: { ...limits, sampleRate: 44_100 } },
      },
      {
        name: 'stereo audio',
        schema: stt.SttStatusSchema,
        value: { ...availableStatus, limits: { ...limits, channels: 2 } },
      },
      {
        name: 'other bit depth',
        schema: stt.SttStatusSchema,
        value: { ...availableStatus, limits: { ...limits, bitsPerSample: 24 } },
      },
      {
        name: 'zero maximum duration',
        schema: stt.SttStatusSchema,
        value: { ...availableStatus, limits: { ...limits, maxDurationSeconds: 0 } },
      },
      {
        name: 'zero PCM budget',
        schema: stt.SttStatusSchema,
        value: { ...availableStatus, limits: { ...limits, maxPcmBytes: 0 } },
      },
      { name: 'no worker at all', schema: stt.SttStatusSchema, value: { ...statusBase, available: false } },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should resolve transcripts and reject impossible timings or a non-batch envelope', () => {
    // Arrange
    const silence = { ...transcript, text: '', audioMs: 0, decodeMs: 0, rtf: 0 };
    const cases: SchemaCase[] = [
      { name: 'negative audio length', schema: stt.SttTranscriptSchema, value: { ...transcript, audioMs: -1 } },
      { name: 'negative decode time', schema: stt.SttTranscriptSchema, value: { ...transcript, decodeMs: -1 } },
      {
        name: 'non-finite real-time factor',
        schema: stt.SttTranscriptSchema,
        value: { ...transcript, rtf: Number.NaN },
      },
      {
        name: 'infinite real-time factor',
        schema: stt.SttTranscriptSchema,
        value: { ...transcript, rtf: Number.POSITIVE_INFINITY },
      },
      { name: 'empty model id', schema: stt.SttTranscriptSchema, value: { ...transcript, modelId: '' } },
      { name: 'streaming transcript', schema: stt.SttTranscriptSchema, value: { ...transcript, streaming: true } },
      { name: 'non-batch mode', schema: stt.SttTranscriptSchema, value: { ...transcript, mode: 'stream' } },
      { name: 'other language', schema: stt.SttTranscriptSchema, value: { ...transcript, language: 'fr' } },
      { name: 'text omitted', schema: stt.SttTranscriptSchema, value: { ...transcript, text: undefined } },
    ];

    // Act
    const parsed = stt.SttTranscriptSchema.parse(silence);

    // Assert
    should(parsed).deepEqual(silence);
    assertRejects(cases);
  });

  it('should accept minimal and fully populated enhancement requests within their bounds', () => {
    // Arrange
    const maxima = {
      text: 'a'.repeat(8_000),
      provider: 'groq',
      model: 'm'.repeat(128),
      context: Array.from({ length: 10 }, (_unused, index) => `turn-${index}`),
      userContext: 'u'.repeat(2_000),
      dictionary: Array.from({ length: 128 }, (_unused, index) => ({ term: `term-${index}` })),
    };

    // Act
    const parsed = [minimalEnhancementRequest, enhancementRequest, maxima].map(value =>
      stt.SttEnhancementRequestSchema.parse(value),
    );

    // Assert
    should(parsed[0]).deepEqual(minimalEnhancementRequest);
    should(parsed[1]).deepEqual(enhancementRequest);
    should(parsed[2]?.dictionary).have.length(128);
    should(stt.SttEnhancementRequestSchema.parse({ text: 'x', provider: 'groq', model: '  kimi  ' }).model).equal(
      'kimi',
    );
    should(
      stt.SttEnhancementRequestSchema.parse({
        text: 'x',
        provider: 'groq',
        dictionary: [{ term: '  ferretry  ', aliases: ['  ferret tree  '] }],
      }).dictionary,
    ).deepEqual([{ term: 'ferretry', aliases: ['ferret tree'] }]);
  });

  it('should reject enhancement requests that break strictness or exceed their limits', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'unknown key',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, temperature: 0.2 },
      },
      { name: 'no text', schema: stt.SttEnhancementRequestSchema, value: { provider: 'groq' } },
      { name: 'no provider', schema: stt.SttEnhancementRequestSchema, value: { text: 'x' } },
      {
        name: 'unknown provider',
        schema: stt.SttEnhancementRequestSchema,
        value: { text: 'x', provider: 'openai' },
      },
      {
        name: 'text above the maximum',
        schema: stt.SttEnhancementRequestSchema,
        value: { text: 'a'.repeat(8_001), provider: 'groq' },
      },
      {
        name: 'blank model',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, model: '   ' },
      },
      {
        name: 'model above the maximum',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, model: 'm'.repeat(129) },
      },
      {
        name: 'too many context turns',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, context: Array.from({ length: 11 }, () => 'turn') },
      },
      {
        name: 'user context above the maximum',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, userContext: 'u'.repeat(2_001) },
      },
      {
        name: 'too many dictionary entries',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, dictionary: Array.from({ length: 129 }, () => ({ term: 'term' })) },
      },
      {
        name: 'blank dictionary term',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, dictionary: [{ term: '   ' }] },
      },
      {
        name: 'dictionary term above the maximum',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, dictionary: [{ term: 't'.repeat(65) }] },
      },
      {
        name: 'dictionary alias above the maximum',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, dictionary: [{ term: 'ferretry', aliases: ['a'.repeat(65)] }] },
      },
      {
        name: 'unknown dictionary key',
        schema: stt.SttEnhancementRequestSchema,
        value: { ...minimalEnhancementRequest, dictionary: [{ term: 'ferretry', weight: 2 }] },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should resolve enhancement results and error views and reject malformed ones', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'result text above the maximum',
        schema: stt.SttEnhancementResultSchema,
        value: { ...enhancementResult, text: 'a'.repeat(16_001) },
      },
      {
        name: 'result without a model',
        schema: stt.SttEnhancementResultSchema,
        value: { ...enhancementResult, model: '' },
      },
      {
        name: 'result with a negative latency',
        schema: stt.SttEnhancementResultSchema,
        value: { ...enhancementResult, latencyMs: -1 },
      },
      {
        name: 'result with an unknown provider',
        schema: stt.SttEnhancementResultSchema,
        value: { ...enhancementResult, provider: 'anthropic' },
      },
      { name: 'error view without a message', schema: stt.SttErrorViewSchema, value: { ...errorView, error: '' } },
      {
        name: 'error view with an unknown code',
        schema: stt.SttErrorViewSchema,
        value: { ...errorView, code: 'oops' },
      },
      {
        name: 'enhancement error view borrowing a transcription code',
        schema: stt.SttEnhancementErrorViewSchema,
        value: { ...enhancementErrorView, code: 'bad_audio' },
      },
      {
        name: 'enhancement error view without a message',
        schema: stt.SttEnhancementErrorViewSchema,
        value: { ...enhancementErrorView, error: '' },
      },
    ];

    // Act
    const parsed = stt.SttEnhancementResultSchema.parse({ ...enhancementResult, text: '', latencyMs: 0 });

    // Assert
    should(parsed.text).equal('');
    should(stt.SttEnhancementErrorViewSchema.parse(enhancementErrorView)).deepEqual(enhancementErrorView);
    should(stt.SttErrorViewSchema.parse(errorView)).deepEqual(errorView);
    assertRejects(cases);
  });

  it('should resolve every worker request and response union member', () => {
    // Arrange
    const requests = [loadRequest, transcribeRequest, shutdownRequest];
    const responses = [readyResponse, resultResponse, errorResponse, byeResponse];

    // Act
    const parsedRequests = requests.map(value => stt.SttWorkerRequestSchema.parse(value));
    const parsedResponses = responses.map(value => stt.SttWorkerResponseSchema.parse(value));

    // Assert
    should(parsedRequests.map(entry => entry.type)).deepEqual(['load', 'transcribe', 'shutdown']);
    should(parsedResponses.map(entry => entry.type)).deepEqual(['ready', 'result', 'error', 'bye']);
    should(
      stt.SttWorkerResponseSchema.safeParse({ type: 'error', code: 'bad_audio', message: 'boom' }).success,
    ).be.true();
    should(stt.SttWorkerResponseSchema.parse(silentResultResponse)).deepEqual(silentResultResponse);
  });

  it('should reject worker traffic that breaks the transport contract', () => {
    // Arrange
    const workerOnlyCodes = [
      'bad_request',
      'bad_audio',
      'too_long',
      'model_missing',
      'native_missing',
      'load_failed',
      'decode_failed',
    ];
    const cases: SchemaCase[] = [
      { name: 'unknown request type', schema: stt.SttWorkerRequestSchema, value: { type: 'cancel' } },
      { name: 'load without a model', schema: stt.SttWorkerRequestSchema, value: { ...loadRequest, model: undefined } },
      { name: 'load without threads', schema: stt.SttWorkerRequestSchema, value: { ...loadRequest, threads: 0 } },
      {
        name: 'load with a fractional thread count',
        schema: stt.SttWorkerRequestSchema,
        value: { ...loadRequest, threads: 2.5 },
      },
      {
        name: 'load without a request id',
        schema: stt.SttWorkerRequestSchema,
        value: { ...loadRequest, requestId: '' },
      },
      {
        name: 'load whose model omits the joiner',
        schema: stt.SttWorkerRequestSchema,
        value: { ...loadRequest, model: { ...workerModel, joiner: '' } },
      },
      {
        name: 'transcribe at the wrong sample rate',
        schema: stt.SttWorkerRequestSchema,
        value: { ...transcribeRequest, sampleRate: 44_100 },
      },
      {
        name: 'transcribe with plain-array audio',
        schema: stt.SttWorkerRequestSchema,
        value: { ...transcribeRequest, audio: [0, 1] },
      },
      {
        name: 'transcribe with the wrong typed array',
        schema: stt.SttWorkerRequestSchema,
        value: { ...transcribeRequest, audio: new Int16Array([0, 1]) },
      },
      { name: 'unknown response type', schema: stt.SttWorkerResponseSchema, value: { type: 'partial', text: 'hi' } },
      {
        name: 'ready without a load time',
        schema: stt.SttWorkerResponseSchema,
        value: { ...readyResponse, loadMs: undefined },
      },
      {
        name: 'ready with a negative load time',
        schema: stt.SttWorkerResponseSchema,
        value: { ...readyResponse, loadMs: -1 },
      },
      {
        name: 'ready without a request id',
        schema: stt.SttWorkerResponseSchema,
        value: { ...readyResponse, requestId: undefined },
      },
      {
        name: 'result with a negative decode time',
        schema: stt.SttWorkerResponseSchema,
        value: { ...resultResponse, decodeMs: -1 },
      },
      {
        name: 'error without a message',
        schema: stt.SttWorkerResponseSchema,
        value: { ...errorResponse, message: '' },
      },
      {
        name: 'error using a service-only code',
        schema: stt.SttWorkerResponseSchema,
        value: { ...errorResponse, code: 'busy' },
      },
      {
        name: 'error using another service-only code',
        schema: stt.SttWorkerResponseSchema,
        value: { ...errorResponse, code: 'worker_crashed' },
      },
    ];

    // Act + Assert
    for (const code of workerOnlyCodes) {
      should(stt.SttWorkerResponseSchema.safeParse({ ...errorResponse, code }).success).be.true();
      should(stt.SttErrorCodeSchema.safeParse(code).success).be.true();
    }
    assertRejects(cases);
  });
});
