import type { SttEnhancementResult } from '@ferretry/protocol';
import {
  buildEnhancementBody,
  classifyEnhancementOutcome,
  DEFAULT_ENHANCEMENT_PROVIDERS,
  DEFAULT_ENHANCEMENT_TIMEOUT_MS,
  type EnhancementProviderTable,
  type EnhancementProviderView,
  enhancementHeaders,
  enhancementProviderViews,
  parseEnhancementRequest,
  requireEnhancementSecret,
} from './enhancement.ts';
import type { EnhancementTransport, MonotonicClockPort, SttSecretReader } from './ports.ts';

export interface SttEnhancementServiceOptions {
  readonly providers?: EnhancementProviderTable;
  readonly timeoutMs?: number;
}

/**
 * Orchestrates one enhancement call. Every decision is delegated to the pure
 * helpers in `enhancement.ts`; every capability arrives through a port, so this
 * class performs no IO of its own and holds no mutable state.
 */
export class SttEnhancementService {
  private readonly providers: EnhancementProviderTable;
  private readonly timeoutMs: number;

  constructor(
    private readonly transport: EnhancementTransport,
    private readonly secrets: SttSecretReader,
    private readonly clock: MonotonicClockPort,
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
    const secret = requireEnhancementSecret(this.secrets.read(request.provider.secretName));

    const startedAt = this.clock.monotonicMs();
    const outcome = await this.transport.send({
      url: request.provider.endpoint,
      headers: enhancementHeaders(secret),
      body: JSON.stringify(buildEnhancementBody(request)),
      timeoutMs: this.timeoutMs,
    });

    return classifyEnhancementOutcome(outcome, request, Math.max(0, this.clock.monotonicMs() - startedAt));
  }
}
