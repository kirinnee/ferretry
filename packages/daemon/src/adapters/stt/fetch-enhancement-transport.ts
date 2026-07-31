import type {
  EnhancementHttpRequest,
  EnhancementOutcome,
  EnhancementTransport,
  MonotonicClockPort,
  SttSecretReader,
} from '../../lib/index.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The chat-completions transport. It owns the abort budget and the body
 * handling and reports facts only — the domain decides what each fact means.
 */
export class FetchEnhancementTransport implements EnhancementTransport {
  constructor(private readonly fetchImplementation: FetchLike = (input, init) => fetch(input, init)) {}

  async send(request: EnhancementHttpRequest): Promise<EnhancementOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      return await this.exchange(request, controller);
    } finally {
      clearTimeout(timer);
    }
  }

  private async exchange(request: EnhancementHttpRequest, controller: AbortController): Promise<EnhancementOutcome> {
    let response: Response;
    try {
      response = await this.fetchImplementation(request.url, {
        method: 'POST',
        headers: { ...request.headers },
        body: request.body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'timeout' };
      return { kind: 'unreachable', cause: error };
    }

    if (!response.ok) {
      // The body could echo the transcript and is not needed to classify the
      // failure, so it is discarded rather than read — but it must be released,
      // or the connection leaks for the rest of the process's life.
      await discard(response);
      const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
      return retryAfterSeconds === undefined
        ? { kind: 'status', status: response.status }
        : { kind: 'status', status: response.status, retryAfterSeconds };
    }

    try {
      return { kind: 'completion', payload: await response.json() };
    } catch {
      return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'unreadable' };
    }
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that cannot be cancelled is already released; nothing to recover.
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Reads secrets from the daemon process environment, by name only. */
export class ProcessSecretReader implements SttSecretReader {
  constructor(private readonly environment: Readonly<Record<string, string | undefined>> = process.env) {}

  read(name: string): string | undefined {
    return this.environment[name];
  }
}

/** Monotonic milliseconds from the host's high-resolution timer. */
export class PerformanceStopwatch implements MonotonicClockPort {
  constructor(private readonly source: () => number = () => performance.now()) {}

  monotonicMs(): number {
    return this.source();
  }
}
