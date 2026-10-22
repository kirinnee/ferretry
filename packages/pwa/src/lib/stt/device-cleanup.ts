/**
 * Dictation clean-up straight from this browser to Groq or Cerebras, with a key this device holds
 * (`speedup-keys.ts`). No daemon is on the path: the owner chose this because one more round trip
 * made clean-up slow.
 *
 * Every decision — the prompt and its fixed guard, how much conversation goes along, the request
 * body, reasoning stripping, how a reply is judged — is `@ferretry/protocol`'s `stt-cleanup`, the
 * same code the daemon runs, so the two paths cannot disagree about what is sent or what is kept.
 * What is here is only the browser's half: the deadline, the one retry without the conversation, and
 * sentences that name THIS device's key.
 *
 * Every failure keeps the raw words: the caller treats a throw as "use the text you already have".
 * Nothing here logs a request or a reply, because both hold dictated text.
 *
 * When the caller asks for it (`debug`), each call also builds a `CleanupTrace`: the request as sent
 * with the authorization header shown as redacted, the provider's raw reply, the steps the shared
 * cleanup took, and the timings. That record is handed back to the caller and nowhere else. This file
 * never reads the key — it shows a placeholder where the key goes — and with `debug` off it reads no
 * error body and builds nothing.
 */

import {
  buildCleanupBody,
  CLEANUP_LIMITS,
  CLEANUP_PROVIDERS,
  type CleanupRequest,
  type CleanupTrace,
  type CleanupTraceAttempt,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  describeCleanupReply,
  describeCleanupRequest,
  isContextSizedStatus,
  prepareCleanup,
  readCleanupReply,
  TRACE_REDACTED,
} from '@ferretry/protocol';
import { type CleanupCallDetail, tokensOf } from './dictation-timeline.ts';
import type { DictionaryEntry } from './enhancement.ts';
import { RemoteEnhancementError, type RemoteEnhancementResult } from './remote-enhancement.ts';
import type { DeviceSpeedupKeys, SpeedupKeyProvider, SpeedupKeySend } from './speedup-keys.ts';
import type { VoiceCleanup } from './voice-cleanup.ts';

/** Where a person fixes a key this device holds. */
export const DEVICE_KEYS_PLACE = 'Settings › This device › Speed-up keys';

export interface DeviceCleanupInput {
  readonly provider: SpeedupKeyProvider;
  readonly model: string;
  readonly text: string;
  readonly dictionary: readonly DictionaryEntry[];
  /** The conversation as the page already holds it, oldest first; reduced and bounded by the shared lib. */
  readonly context: readonly string[];
  readonly userContext: string;
  readonly cleanup: VoiceCleanup;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Build a debug record of this call and return it with the result (or on the error). */
  readonly debug?: boolean;
  /** Wall clock in epoch milliseconds, for the record's timings; a suite supplies its own. */
  readonly now?: () => number;
  /** Monotonic milliseconds, for how long the call took; `performance.now()` when omitted. */
  readonly monotonic?: () => number;
}

/** How one attempt went, measured on the monotonic clock whether or not a debug record was asked for. */
interface AttemptTimer {
  readonly startedAt: number;
  firstByteMs?: number;
  totalMs?: number;
  tokens?: ReturnType<typeof tokensOf>;
}

/** The attempts one call made, and the clock they are timed by. */
interface CallTimer {
  readonly now: () => number;
  readonly attempts: AttemptTimer[];
}

const monotonicNow = (): number => globalThis.performance.now();

/** The most of a provider's error body a record keeps. */
const ERROR_BODY_CAP = 8_000;

/** What one attempt saw, filled in as it goes so a record can be made however it ends. */
interface AttemptProbe {
  readonly now: () => number;
  readonly startedAt: number;
  status?: number;
  firstByteMs?: number;
  errorBody?: string;
  raw?: string;
  payload?: unknown;
}

/** Where a call's attempts are collected, and the clock they are timed by. */
interface TraceSink {
  readonly attempts: CleanupTraceAttempt[];
  readonly now: () => number;
}

/** The provider said this much; nothing of its body is kept. */
interface ProviderStatus {
  readonly status: number;
  readonly retryAfterSeconds?: number;
}

const label = (provider: SpeedupKeyProvider): string => CLEANUP_PROVIDERS[provider].label;

/** A non-2xx status as one sentence naming the status and what to do. */
export function deviceCleanupStatusError(
  provider: SpeedupKeyProvider,
  outcome: ProviderStatus,
): RemoteEnhancementError {
  const { status } = outcome;
  const at = `HTTP ${String(status)}`;
  const name = label(provider);
  if (status === 401 || status === 403) {
    return new RemoteEnhancementError(
      'provider-auth',
      `${name} rejected the key saved on this device (${at}); check it in ${DEVICE_KEYS_PLACE}.`,
      status,
    );
  }
  if (status === 404) {
    return new RemoteEnhancementError(
      'bad-model',
      `${name} does not offer that model to this key (${at}); pick another model.`,
      status,
    );
  }
  if (status === 413) {
    return new RemoteEnhancementError(
      'too-long',
      `${name} says the request is too large for its limit (${at}).`,
      status,
    );
  }
  if (status === 429) {
    const wait =
      outcome.retryAfterSeconds === undefined
        ? ''
        : `; try again in ${String(Math.max(1, Math.ceil(outcome.retryAfterSeconds)))}s`;
    return new RemoteEnhancementError('rate-limit', `${name} is rate limiting this key (${at})${wait}.`, status);
  }
  if (status >= 500) return new RemoteEnhancementError('provider', `${name} returned an error (${at}).`, status);
  return new RemoteEnhancementError('provider', `${name} rejected the request (${at}).`, status);
}

const retryAfter = (response: Response): number | undefined => {
  const value = Number(response.headers.get('retry-after') ?? Number.NaN);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

/** One attempt, and the record of it when the caller asked for one. */
async function attempt(
  keys: DeviceSpeedupKeys,
  provider: SpeedupKeyProvider,
  request: CleanupRequest,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  sink: TraceSink | undefined,
  calls: CallTimer,
): Promise<RemoteEnhancementResult | undefined> {
  const probe: AttemptProbe | undefined = sink && { now: sink.now, startedAt: sink.now() };
  const timer: AttemptTimer = { startedAt: calls.now() };
  calls.attempts.push(timer);
  try {
    const result = await run(keys, provider, request, signal, timeoutMs, probe, calls.now, timer);
    if (sink && probe && result !== undefined) record(sink, provider, request, probe);
    return result;
  } catch (failure) {
    if (sink && probe) record(sink, provider, request, probe, (failure as Error).message);
    throw failure;
  } finally {
    timer.totalMs = Math.max(0, calls.now() - timer.startedAt);
  }
}

const record = (
  sink: TraceSink,
  provider: SpeedupKeyProvider,
  request: CleanupRequest,
  probe: AttemptProbe,
  failure?: string,
): void => {
  const config = CLEANUP_PROVIDERS[provider];
  const body = buildCleanupBody(request, config);
  sink.attempts.push({
    withContext: request.context.length > 0,
    request: describeCleanupRequest({
      endpoint: config.endpoint,
      headers: { authorization: TRACE_REDACTED, 'content-type': 'application/json' },
      body,
    }),
    ...(probe.status === undefined ? {} : { status: probe.status }),
    ...(probe.payload === undefined ? {} : { response: describeCleanupReply(probe.payload, request, probe.raw) }),
    ...(probe.errorBody === undefined ? {} : { errorBody: probe.errorBody }),
    ...(failure === undefined ? {} : { failure: failure.slice(0, 400) }),
    timings: {
      startedAt: probe.startedAt,
      ...(probe.firstByteMs === undefined ? {} : { firstByteMs: probe.firstByteMs }),
      totalMs: Math.max(0, probe.now() - probe.startedAt),
    },
  });
};

/** One attempt, bounded by its own deadline and by the caller's signal. */
async function run(
  keys: DeviceSpeedupKeys,
  provider: SpeedupKeyProvider,
  request: CleanupRequest,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  probe: AttemptProbe | undefined,
  now: () => number,
  clock: AttemptTimer,
): Promise<RemoteEnhancementResult | undefined> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const stopped = (): RemoteEnhancementError | undefined => {
    if (timedOut) {
      return new RemoteEnhancementError(
        'timeout',
        `Clean-up took longer than ${String(timeoutMs / 1_000)}s; raw dictation was kept.`,
      );
    }
    return signal?.aborted === true ? new RemoteEnhancementError('aborted', 'Enhancement was cancelled.') : undefined;
  };
  try {
    let sent: SpeedupKeySend;
    let body: string;
    try {
      sent = await keys.send(provider, {
        endpoint: 'chat',
        body: JSON.stringify(buildCleanupBody(request, CLEANUP_PROVIDERS[provider])),
        signal: controller.signal,
      });
      if (sent.kind !== 'response') return sent.kind === 'missing' ? undefined : unreadableKey(provider);
      clock.firstByteMs = Math.max(0, now() - clock.startedAt);
      if (probe) {
        probe.firstByteMs = Math.max(0, probe.now() - probe.startedAt);
        probe.status = sent.response.status;
      }
      if (!sent.response.ok) {
        if (probe) probe.errorBody = await readErrorBody(sent.response);
        throw deviceCleanupStatusError(provider, {
          status: sent.response.status,
          ...(retryAfter(sent.response) === undefined ? {} : { retryAfterSeconds: retryAfter(sent.response) }),
        });
      }
      body = await sent.response.text();
      if (probe) probe.raw = body;
    } catch (failure) {
      if (failure instanceof RemoteEnhancementError) throw failure;
      throw (
        stopped() ??
        new RemoteEnhancementError(
          'network',
          `${label(provider)} could not be reached from this browser; raw dictation was kept.`,
        )
      );
    }
    let payload: unknown;
    try {
      if (body.length > CLEANUP_LIMITS.maxResponseBytes) throw new Error('oversized');
      payload = JSON.parse(body);
      clock.tokens = tokensOf(payload);
      if (probe) probe.payload = payload;
    } catch {
      if (probe) probe.errorBody = body.slice(0, ERROR_BODY_CAP);
      throw new RemoteEnhancementError(
        'invalid-response',
        `${label(provider)} returned an unreadable response; raw dictation was kept.`,
      );
    }
    const reply = readCleanupReply(payload, request);
    if (reply.kind === 'unusable') throw new RemoteEnhancementError('invalid-response', reply.reason);
    if (reply.kind === 'kept_raw') {
      return { text: request.text, provider, model: request.model, kept: 'raw', keptReason: reply.reason };
    }
    return { text: reply.text, provider, model: request.model };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** What the provider said with a non-2xx status, capped; an unreadable body is simply absent. */
const readErrorBody = async (response: Response): Promise<string | undefined> => {
  try {
    return (await response.text()).slice(0, ERROR_BODY_CAP);
  } catch {
    return undefined;
  }
};

const unreadableKey = (provider: SpeedupKeyProvider): never => {
  throw new RemoteEnhancementError(
    'provider-auth',
    `The ${label(provider)} key saved on this device can no longer be read; save it again in ${DEVICE_KEYS_PLACE}.`,
  );
};

/**
 * Clean up a transcript with this device's key, or `undefined` when this device holds none for the
 * provider — the caller then asks the daemon. A request the provider finds too big is sent again once
 * without the conversation, which is a nicety the dictation alone does not need.
 */
export async function requestDeviceCleanup(
  keys: DeviceSpeedupKeys,
  input: DeviceCleanupInput,
): Promise<RemoteEnhancementResult | undefined> {
  if (input.signal?.aborted === true) throw new RemoteEnhancementError('aborted', 'Enhancement was cancelled.');
  const prepared = prepareCleanup({
    text: input.text,
    model: input.model,
    defaultModel: CLEANUP_PROVIDERS[input.provider].defaultModel,
    context: input.context,
    userContext: input.userContext,
    dictionary: input.dictionary,
    settings: input.cleanup,
  });
  if ('refused' in prepared) {
    if (prepared.refused === 'bad_model') {
      throw new RemoteEnhancementError('bad-model', 'That model id is not valid; pick another model.');
    }
    return { text: input.text };
  }
  const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
  const sink: TraceSink | undefined = input.debug === true ? { attempts: [], now: input.now ?? Date.now } : undefined;
  const startedAt = sink?.now() ?? 0;
  const calls: CallTimer = { now: input.monotonic ?? monotonicNow, attempts: [] };
  const callStartedAt = calls.now();
  try {
    const result = await attemptWithRetry(keys, input.provider, prepared, input.signal, timeoutMs, sink, calls);
    if (result === undefined) return result;
    const timed = { ...result, timing: timingOf(calls, callStartedAt) };
    if (sink === undefined) return timed;
    return { ...timed, trace: traceOf(sink, input.provider, prepared.model, startedAt, result) };
  } catch (failure) {
    if (failure instanceof RemoteEnhancementError) {
      failure.timing = timingOf(calls, callStartedAt);
      if (sink !== undefined && sink.attempts.length > 0) {
        failure.trace = traceOf(sink, input.provider, prepared.model, startedAt, failure);
      }
    }
    throw failure;
  }
}

/** The call as a whole: how long, when the last attempt's first byte came, how many attempts, the tokens. */
function timingOf(calls: CallTimer, startedAt: number): CleanupCallDetail {
  const last = calls.attempts.at(-1);
  const retried = calls.attempts.length > 1;
  return {
    totalMs: Math.max(0, calls.now() - startedAt),
    ...(last?.firstByteMs === undefined ? {} : { firstByteMs: last.firstByteMs }),
    attempts: Math.min(2, Math.max(1, calls.attempts.length)),
    ...(retried ? { retried: 'without-context' as const } : {}),
    ...(last?.tokens ?? {}),
  };
}

/** The first attempt, and — when the provider found the request too big — one more without the conversation. */
async function attemptWithRetry(
  keys: DeviceSpeedupKeys,
  provider: SpeedupKeyProvider,
  prepared: CleanupRequest,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  sink: TraceSink | undefined,
  calls: CallTimer,
): Promise<RemoteEnhancementResult | undefined> {
  try {
    return await attempt(keys, provider, prepared, signal, timeoutMs, sink, calls);
  } catch (failure) {
    const sized = failure instanceof RemoteEnhancementError && isContextSizedStatus(failure.status);
    if (!sized || prepared.context.length === 0) throw failure;
    return await attempt(keys, provider, { ...prepared, context: [] }, signal, timeoutMs, sink, calls);
  }
}

/** The whole call as one record, from the attempts it made and how it ended. */
function traceOf(
  sink: TraceSink,
  provider: SpeedupKeyProvider,
  model: string,
  startedAt: number,
  ending: RemoteEnhancementResult | RemoteEnhancementError,
): CleanupTrace {
  const failed = ending instanceof RemoteEnhancementError;
  const outcome = failed ? 'failed' : ending.kept === 'raw' ? 'kept_raw' : 'cleaned';
  return {
    via: 'device',
    provider,
    model,
    host: new URL(CLEANUP_PROVIDERS[provider].endpoint).host,
    startedAt,
    totalMs: Math.max(0, sink.now() - startedAt),
    outcome,
    ...(failed
      ? { failure: { code: ending.code, message: ending.message.slice(0, 400) } }
      : { finalText: ending.text }),
    attempts: sink.attempts,
  };
}

/** What a key's Test found: how many models it can use, or why it cannot. */
export type DeviceKeyTest =
  | { readonly ok: true; readonly models: number }
  | { readonly ok: false; readonly message: string };

/**
 * List the models a saved key can use. It is free and runs no model, so it proves the key works
 * without spending anything.
 */
export async function testDeviceKey(
  keys: DeviceSpeedupKeys,
  provider: SpeedupKeyProvider,
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
): Promise<DeviceKeyTest> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const sent = await keys.send(provider, { endpoint: 'models', signal: controller.signal });
    if (sent.kind === 'missing') return { ok: false, message: 'No key is saved on this device.' };
    if (sent.kind === 'unreadable') {
      return { ok: false, message: `This browser can no longer read the saved ${label(provider)} key; save it again.` };
    }
    if (!sent.response.ok) {
      return { ok: false, message: deviceCleanupStatusError(provider, { status: sent.response.status }).message };
    }
    const payload = (await sent.response.json()) as { data?: unknown };
    const models = Array.isArray(payload.data) ? payload.data.length : 0;
    return { ok: true, models };
  } catch {
    return {
      ok: false,
      message: controller.signal.aborted
        ? `${label(provider)} did not answer within ${String(timeoutMs / 1_000)}s.`
        : `${label(provider)} could not be reached from this browser, or sent back something unreadable.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
