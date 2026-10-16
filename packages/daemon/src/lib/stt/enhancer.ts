import type { SttEnhancementResult } from '@ferretry/protocol';
import {
  buildEnhancementBody,
  classifyEnhancementOutcome,
  DEFAULT_ENHANCEMENT_PROVIDERS,
  DEFAULT_ENHANCEMENT_TIMEOUT_MS,
  ENHANCEMENT_HEADERS,
  ENHANCEMENT_LIMITS,
  type EnhancementProviderTable,
  type EnhancementProviderView,
  enhancementProviderViews,
  parseEnhancementRequest,
} from './enhancement.ts';
import type { EnhancementAuthorizer, SttMonotonicClockPort } from './ports.ts';

export interface SttEnhancementServiceOptions {
  readonly providers?: EnhancementProviderTable;
  readonly timeoutMs?: number;
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

  constructor(
    private readonly authorizer: EnhancementAuthorizer,
    private readonly clock: SttMonotonicClockPort,
    options: SttEnhancementServiceOptions = {},
  ) {
    this.providers = options.providers ?? DEFAULT_ENHANCEMENT_PROVIDERS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ENHANCEMENT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive, finite number');
    }
  }

  /** Providers this instance can serve, in a form safe to expose publicly. */
  availableProviders(): readonly EnhancementProviderView[] {
    return enhancementProviderViews(this.providers);
  }

  async enhance(input: unknown): Promise<SttEnhancementResult> {
    const request = parseEnhancementRequest(input, this.providers);

    const startedAt = this.clock.monotonicMs();
    const outcome = await this.authorizer.send(request.provider.secretName, request.provider.hosts, {
      method: 'POST',
      url: request.provider.endpoint,
      headers: ENHANCEMENT_HEADERS,
      body: JSON.stringify(buildEnhancementBody(request)),
      timeoutMs: this.timeoutMs,
      maxResponseBytes: ENHANCEMENT_LIMITS.maxResponseBytes,
    });

    return classifyEnhancementOutcome(outcome, request, Math.max(0, this.clock.monotonicMs() - startedAt));
  }
}
