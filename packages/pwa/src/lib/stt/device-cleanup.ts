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
 */

import {
  buildCleanupBody,
  CLEANUP_LIMITS,
  CLEANUP_PROVIDERS,
  type CleanupRequest,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  isContextSizedStatus,
  prepareCleanup,
  readCleanupReply,
} from '@ferretry/protocol';
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

/** One attempt, bounded by its own deadline and by the caller's signal. */
async function attempt(
  keys: DeviceSpeedupKeys,
  provider: SpeedupKeyProvider,
  request: CleanupRequest,
  signal: AbortSignal | undefined,
  timeoutMs: number,
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
      if (!sent.response.ok) {
        throw deviceCleanupStatusError(provider, {
          status: sent.response.status,
          ...(retryAfter(sent.response) === undefined ? {} : { retryAfterSeconds: retryAfter(sent.response) }),
        });
      }
      body = await sent.response.text();
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
    } catch {
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
  try {
    return await attempt(keys, input.provider, prepared, input.signal, timeoutMs);
  } catch (failure) {
    const sized = failure instanceof RemoteEnhancementError && isContextSizedStatus(failure.status);
    if (!sized || prepared.context.length === 0) throw failure;
    return await attempt(keys, input.provider, { ...prepared, context: [] }, input.signal, timeoutMs);
  }
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
