import {
  CLEANUP_LIMITS,
  type CleanupTrace,
  type CleanupTraceAttempt,
  isContextSizedStatus,
  type SttEnhancementErrorCode,
  type SttEnhancementResult,
} from '@ferretry/protocol';
import {
  buildEnhancementBody,
  type CleanupSettings,
  classifyEnhancementOutcome,
  DEFAULT_CLEANUP_SETTINGS,
  DEFAULT_ENHANCEMENT_PROVIDERS,
  DEFAULT_ENHANCEMENT_TIMEOUT_MS,
  describeEnhancementAttempt,
  ENHANCEMENT_HEADERS,
  type EnhancementProviderTable,
  type EnhancementProviderView,
  enhancementProviderViews,
  type NormalizedEnhancement,
  parseEnhancementRequest,
} from './enhancement.ts';
import { SttEnhancementError } from './errors.ts';
import type { EnhancementAuthorizer, SttMonotonicClockPort } from './ports.ts';

/**
 * One enhancement call, as a log line. It carries sizes, codes and the guard's reason and NEVER the
 * dictation, the conversation, the provider's reply or any credential.
 */
export interface EnhancementReport {
  readonly outcome: 'cleaned' | 'kept_raw' | 'failed';
  readonly provider: string;
  readonly model: string;
  readonly textChars: number;
  readonly contextMessages: number;
  /** The context was dropped and the call repeated because the provider found the request too big. */
  readonly retriedWithoutContext: boolean;
  readonly code?: SttEnhancementErrorCode;
  readonly providerStatus?: number;
  readonly reason?: string;
  readonly latencyMs: number;
}

/** A failure that more reference text caused and less can cure: the provider says the request is too big or invalid. */
const isContextSized = (error: SttEnhancementError): boolean => isContextSizedStatus(error.providerStatus);

export interface SttEnhancementServiceOptions {
  /** Told once per call how it ended, for the daemon's log. */
  readonly report?: (report: EnhancementReport) => void;
  readonly providers?: EnhancementProviderTable;
  readonly timeoutMs?: number;
  /** The machine's cleanup settings (`voice.yaml`), read per call so an edit takes effect at once. */
  readonly cleanup?: () => CleanupSettings;
}

/**
 * Orchestrates one enhancement call. Every decision is delegated to the pure
 * helpers in `enhancement.ts`; every capability arrives through a port, so this
 * class performs no IO of its own and holds no mutable state.
 *
 * It names the provider's secret and never holds it: the outbound holder reads
 * the key from the secret store, sends it only to that provider's hosts, and
 * hands back the reply.
 */
export class SttEnhancementService {
  private readonly providers: EnhancementProviderTable;
  private readonly timeoutMs: number;
  private readonly cleanup: () => CleanupSettings;
  private readonly report: (report: EnhancementReport) => void;

  constructor(
    private readonly authorizer: EnhancementAuthorizer,
    private readonly clock: SttMonotonicClockPort,
    options: SttEnhancementServiceOptions = {},
  ) {
    this.providers = options.providers ?? DEFAULT_ENHANCEMENT_PROVIDERS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ENHANCEMENT_TIMEOUT_MS;
    this.cleanup = options.cleanup ?? (() => DEFAULT_CLEANUP_SETTINGS);
    this.report = options.report ?? (() => undefined);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive, finite number');
    }
  }

  /** Providers this instance can serve, in a form safe to expose publicly. */
  availableProviders(): readonly EnhancementProviderView[] {
    return enhancementProviderViews(this.providers);
  }

  async enhance(input: unknown): Promise<SttEnhancementResult> {
    const request = parseEnhancementRequest(input, this.providers, this.cleanup());
    const startedAt = this.clock.monotonicMs();
    const elapsed = (): number => Math.max(0, this.clock.monotonicMs() - startedAt);
    const note = (
      retried: boolean,
      latencyMs: number,
      rest: Pick<EnhancementReport, 'outcome'> & Partial<EnhancementReport>,
    ): void =>
      this.report({
        provider: request.provider.id,
        model: request.model,
        textChars: request.text.length,
        contextMessages: request.context.length,
        retriedWithoutContext: retried,
        latencyMs,
        ...rest,
      });

    const attempts: CleanupTraceAttempt[] = [];
    const trace = (
      rest: Pick<CleanupTrace, 'outcome' | 'totalMs'> & Partial<CleanupTrace>,
    ): CleanupTrace | undefined => {
      const first = attempts[0];
      if (!request.debug || first === undefined) return undefined;
      return {
        via: 'daemon',
        provider: request.provider.id,
        model: request.model,
        host: first.request.host,
        attempts,
        ...rest,
      };
    };

    let retried = false;
    let result: SttEnhancementResult;
    try {
      try {
        result = await this.attempt(request, attempts);
      } catch (error) {
        if (!(error instanceof SttEnhancementError) || !isContextSized(error) || request.context.length === 0) {
          throw error;
        }
        // The reference is a nicety: when the provider finds the request too big, the dictation alone still fits.
        retried = true;
        result = await this.attempt({ ...request, context: [] }, attempts);
      }
    } catch (error) {
      if (error instanceof SttEnhancementError) {
        const failed = trace({
          outcome: 'failed',
          totalMs: elapsed(),
          failure: { code: error.code, message: error.message },
        });
        if (failed !== undefined) error.trace = failed;
        note(retried, elapsed(), {
          outcome: 'failed',
          code: error.code,
          ...(error.providerStatus === undefined ? {} : { providerStatus: error.providerStatus }),
          reason: error.message,
        });
      }
      throw error;
    }
    const latencyMs = elapsed();
    note(retried, latencyMs, {
      outcome: result.kept === 'raw' ? 'kept_raw' : 'cleaned',
      ...(result.keptReason === undefined ? {} : { reason: result.keptReason }),
    });
    const debug = trace({
      outcome: result.kept === 'raw' ? 'kept_raw' : 'cleaned',
      totalMs: latencyMs,
      finalText: result.text,
    });
    return { ...result, latencyMs, ...(debug === undefined ? {} : { debug }) };
  }

  private async attempt(
    request: NormalizedEnhancement,
    attempts: CleanupTraceAttempt[],
  ): Promise<SttEnhancementResult> {
    const body = buildEnhancementBody(request);
    const sentAt = request.debug ? this.clock.monotonicMs() : 0;
    const outcome = await this.authorizer.send(request.provider.secretName, request.provider.hosts, {
      method: 'POST',
      url: request.provider.endpoint,
      headers: ENHANCEMENT_HEADERS,
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
      maxResponseBytes: CLEANUP_LIMITS.maxResponseBytes,
    });
    const totalMs = request.debug ? Math.max(0, this.clock.monotonicMs() - sentAt) : 0;
    const record = (failure: string | undefined): void => {
      if (request.debug) attempts.push(describeEnhancementAttempt(request, body, outcome, totalMs, failure));
    };
    try {
      const result = classifyEnhancementOutcome(outcome, request, 0);
      record(undefined);
      return result;
    } catch (error) {
      // classification throws nothing but its own refusals, each with a fixed sentence
      record((error as SttEnhancementError).message);
      throw error;
    }
  }
}
