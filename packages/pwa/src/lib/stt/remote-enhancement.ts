/**
 * Optional POST-dictation correction through a paired daemon.
 *
 * The browser owns only two non-secrets: provider id and model id. The provider
 * credential is intentionally impossible to pass through this API — the daemon
 * spends it from its own secret store and never returns it. Nothing here logs a request
 * or response body, because both contain dictated text.
 *
 * WHAT CHANGED — survey row #34. kteam posted to the relative path
 * `/v1/stt/enhance` with a module-level `TOKEN`/`HAS_TOKEN` captured from the
 * page it was served by (`ui/src/lib/stt/remote-enhancement.ts:11,69-70,93-136`).
 * A static public bundle has no such origin and no such token, and with several
 * pairings alive "the daemon" is not a thing that exists — so the connection is
 * a parameter. Every request is built by `daemonRequest`, which pins it to that
 * daemon's origin and carries that daemon's device token, and dictated text can
 * therefore never be posted to a daemon the reader did not choose.
 */

import {
  type CleanupTrace,
  CleanupTraceSchema,
  MAX_STT_DICTIONARY_ENTRIES,
  MAX_STT_USER_CONTEXT_CHARS,
} from '@ferretry/protocol';
import type { DaemonConnection } from '../daemon-connection.ts';
import { daemonRequest } from '../daemon-transport.ts';
import type { CleanupCallDetail } from './dictation-timeline.ts';
import type { DictionaryEntry } from './enhancement.ts';
import type { RemoteEnhancementProviderId } from './stt-settings.ts';

export const STT_ENHANCE_PATH = '/v1/stt/enhance';
export const REMOTE_ENHANCEMENT_TIMEOUT_MS = 4_500;
export const MAX_REMOTE_ENHANCEMENT_TEXT_CHARS = 8_000;
/** One conversation message on the wire. The daemon reduces and re-bounds it; this only keeps a huge reply off the network. */
export const MAX_REMOTE_CONTEXT_MESSAGE_CHARS = 4_000;

export type RemoteEnhancementErrorCode =
  | 'unauthorized'
  | 'unavailable'
  | 'not-configured'
  | 'provider-auth'
  | 'rate-limit'
  | 'bad-request'
  | 'too-long'
  | 'bad-model'
  | 'timeout'
  | 'provider-unreachable'
  | 'provider'
  | 'invalid-response'
  | 'network'
  | 'aborted';

export class RemoteEnhancementError extends Error {
  readonly code: RemoteEnhancementErrorCode;
  readonly status: number;
  /** The call's debug record, when one was asked for and the call got far enough to have one. */
  trace?: CleanupTrace;
  /** How long this browser's own call took, set on a failure too: a call that failed still took its time. */
  timing?: CleanupCallDetail;

  constructor(code: RemoteEnhancementErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'RemoteEnhancementError';
    this.code = code;
    this.status = status;
  }
}

export type RemoteEnhancementFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface RemoteEnhancementInput {
  readonly provider: RemoteEnhancementProviderId;
  readonly model: string;
  readonly text: string;
  readonly dictionary: readonly DictionaryEntry[];
  readonly context: readonly string[];
  readonly userContext: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Ask the daemon to echo this one call's debug record back; it keeps nothing. */
  readonly debug?: boolean;
  /** The carrier router's fetch: this is a daemon request and must reach a relay-only daemon. */
  readonly fetchImpl: RemoteEnhancementFetch;
}

export interface RemoteEnhancementResult {
  readonly text: string;
  readonly provider?: string;
  readonly model?: string;
  readonly latencyMs?: number;
  /** Set when the daemon refused the model's reply and sent the raw words back; `keptReason` says why. */
  readonly kept?: 'raw';
  readonly keptReason?: string;
  /** This call's debug record: present only when it was asked for. */
  readonly trace?: CleanupTrace;
  /** How long the call took, when this browser made it with its own key. */
  readonly timing?: CleanupCallDetail;
}

const errorCode = (status: number, code: unknown): RemoteEnhancementErrorCode => {
  if (code === 'secret_missing') return 'not-configured';
  if (code === 'secret_invalid') return 'provider-auth';
  if (code === 'rate_limited') return 'rate-limit';
  if (code === 'bad_request' || code === 'provider_unknown') return 'bad-request';
  if (code === 'too_long') return 'too-long';
  if (code === 'bad_model') return 'bad-model';
  if (code === 'timeout') return 'timeout';
  if (code === 'provider_unreachable') return 'provider-unreachable';
  if (code === 'malformed_response') return 'invalid-response';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'unavailable';
  if (status === 429) return 'rate-limit';
  return 'provider';
};

const boundedMessage = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 400) : fallback;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const readTrace = (value: unknown): CleanupTrace | undefined => {
  const parsed = CleanupTraceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * A failure that arrived while the clock or the caller had already given up.
 * Both outrank whatever the transport says, because the transport's complaint
 * is a consequence of the abort rather than a reason of its own.
 */
const abortReason = (timedOut: boolean, timeoutMs: number, signal: AbortSignal | undefined): Error | null => {
  if (timedOut) {
    return new RemoteEnhancementError('timeout', `Enhancement exceeded ${timeoutMs} ms; raw dictation was kept.`);
  }
  if (signal?.aborted === true) return new RemoteEnhancementError('aborted', 'Enhancement was cancelled.');
  return null;
};

/**
 * Ask ONE paired daemon to correct a transcript.
 *
 * Every refusal keeps the reader's raw dictation: the caller is expected to
 * treat a throw as "use the text you already have", never as a lost utterance.
 */
export async function requestRemoteEnhancement(
  daemon: DaemonConnection,
  input: RemoteEnhancementInput,
): Promise<RemoteEnhancementResult> {
  if (input.text.trim() === '') return { text: input.text };
  if (input.text.length > MAX_REMOTE_ENHANCEMENT_TEXT_CHARS) {
    throw new RemoteEnhancementError('invalid-response', 'The transcript is too long for remote enhancement.');
  }
  if (input.signal?.aborted === true) throw new RemoteEnhancementError('aborted', 'Enhancement was cancelled.');

  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = Math.max(1, input.timeoutMs ?? REMOTE_ENHANCEMENT_TIMEOUT_MS);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => controller.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });

  const request = daemonRequest(daemon, STT_ENHANCE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: input.provider,
      model: input.model,
      text: input.text,
      // The reader's dictionary is allowed to be longer than this wire accepts
      // — local deterministic correction uses all of it. The daemon re-parses
      // with the protocol schema and refuses the WHOLE request over the bound,
      // so sending an over-long list would silently cost a reader with a large
      // vocabulary every remote correction instead of a few terms.
      dictionary: input.dictionary.slice(0, MAX_STT_DICTIONARY_ENTRIES),
      context: input.context.map(message => message.slice(-MAX_REMOTE_CONTEXT_MESSAGE_CHARS)),
      // Same contract, same reason: the settings field accepts a longer context
      // than this wire does because local correction reads all of it. A stored
      // value the UI called valid must never be the thing that makes every
      // remote correction fail, so the tail of the prose is dropped instead.
      userContext: input.userContext.slice(0, MAX_STT_USER_CONTEXT_CHARS),
      ...(input.debug === true ? { debug: true } : {}),
    }),
    signal: controller.signal,
  });
  const send = input.fetchImpl;

  try {
    let response: Response;
    try {
      response = await send(request.url, request.init);
    } catch {
      throw (
        abortReason(timedOut, timeoutMs, input.signal) ??
        new RemoteEnhancementError('network', 'The daemon could not be reached for enhancement.')
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw (
        abortReason(timedOut, timeoutMs, input.signal) ??
        new RemoteEnhancementError(
          response.ok ? 'invalid-response' : errorCode(response.status, undefined),
          response.ok
            ? 'The enhancement provider returned an unreadable response; raw dictation was kept.'
            : `Enhancement failed (HTTP ${response.status}); raw dictation was kept.`,
          response.status,
        )
      );
    }

    const record = asRecord(body);
    if (!response.ok) {
      const code = errorCode(response.status, record.code);
      const fallback =
        code === 'unavailable'
          ? 'This daemon does not support remote enhancement yet; raw dictation was kept.'
          : `Enhancement failed (HTTP ${response.status}); raw dictation was kept.`;
      const refusal = new RemoteEnhancementError(code, boundedMessage(record.error, fallback), response.status);
      const failedTrace = input.debug === true ? readTrace(record.debug) : undefined;
      if (failedTrace !== undefined) refusal.trace = failedTrace;
      throw refusal;
    }

    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (text === '' || text.length > MAX_REMOTE_ENHANCEMENT_TEXT_CHARS) {
      throw new RemoteEnhancementError(
        'invalid-response',
        'The enhancement provider returned no usable text; raw dictation was kept.',
        response.status,
      );
    }
    const trace = input.debug === true ? readTrace(record.debug) : undefined;
    return {
      text,
      ...(trace === undefined ? {} : { trace }),
      ...(record.kept === 'raw' ? { kept: 'raw' as const } : {}),
      ...(record.kept === 'raw'
        ? { keptReason: boundedMessage(record.keptReason, 'The cleanup reply did not read as your words corrected.') }
        : {}),
      provider: optionalString(record.provider),
      model: optionalString(record.model),
      latencyMs:
        typeof record.latencyMs === 'number' && Number.isFinite(record.latencyMs) ? record.latencyMs : undefined,
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }
}
