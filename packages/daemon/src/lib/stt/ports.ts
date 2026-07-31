import type { EnhancementOutcome } from './enhancement.ts';

/** One outbound chat-completion call, fully described so the adapter decides nothing. */
export interface EnhancementHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}

/**
 * The only network capability the enhancer has. The adapter classifies transport
 * facts (timed out, unreachable, unreadable body, non-2xx status) and never
 * decides what they mean.
 */
export interface EnhancementTransport {
  send(request: EnhancementHttpRequest): Promise<EnhancementOutcome>;
}

/** Reads daemon-process secrets by name. Never populated from request data. */
export interface SttSecretReader {
  read(name: string): string | undefined;
}

/** Monotonic milliseconds, used for latency only — never for wall-clock stamps. */
export interface MonotonicClockPort {
  monotonicMs(): number;
}
