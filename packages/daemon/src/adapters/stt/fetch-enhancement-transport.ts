import type {
  EnhancementHttpRequest,
  EnhancementOutcome,
  EnhancementTransport,
  SttMonotonicClockPort,
  SttSecretReader,
} from '../../lib/index.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The narrow slice of a byte stream this transport consumes. */
interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

/**
 * The chat-completions transport. It owns the abort budget, the reply size
 * ceiling and the body handling, and reports facts only — the domain decides
 * what each fact means.
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
      // failure, so it is released rather than read — but it must be released,
      // or the connection leaks for the rest of the process's life.
      await discard(response);
      const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
      return retryAfterSeconds === undefined
        ? { kind: 'status', status: response.status }
        : { kind: 'status', status: response.status, retryAfterSeconds };
    }

    const text = await this.readBounded(response, request.maxResponseBytes, controller);
    if (text.kind !== 'text') return text;
    try {
      return { kind: 'completion', payload: JSON.parse(text.value) };
    } catch {
      return { kind: 'unreadable' };
    }
  }

  /**
   * Read the reply through a byte counter and stop at the ceiling.
   *
   * `response.json()` would materialize the whole body first, so a hostile or
   * hijacked provider host could exhaust the daemon's memory with one streamed
   * reply — the output cap was only applied after the bytes were already
   * resident. A declared length over the ceiling is refused without reading at
   * all, and an undeclared one is cut off the moment it crosses it.
   */
  private async readBounded(
    response: Response,
    maxResponseBytes: number,
    controller: AbortController,
  ): Promise<{ kind: 'text'; value: string } | EnhancementOutcome> {
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      await discard(response);
      return { kind: 'oversized' };
    }
    const body = response.body;
    if (body === null) return { kind: 'unreadable' };
    const reader: ChunkReader = body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let value = '';
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch {
        await release(reader);
        return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'unreadable' };
      }
      if (chunk.done) break;
      const bytes = chunk.value;
      if (bytes === undefined) continue;
      received += bytes.byteLength;
      if (received > maxResponseBytes) {
        controller.abort();
        await release(reader);
        return { kind: 'oversized' };
      }
      value += decoder.decode(bytes, { stream: true });
    }
    return { kind: 'text', value: value + decoder.decode() };
  }
}

async function release(reader: ChunkReader): Promise<void> {
  try {
    // Cancellation is a best-effort resource release. A hostile stream may
    // never settle its cancel promise, so it must not hold the request open.
    void reader.cancel().catch(() => undefined);
  } catch {
    // A reader that cannot be cancelled is already released.
  }
}

async function discard(response: Response): Promise<void> {
  try {
    // As above, start disposal but never wait on an untrusted body's promise.
    void response.body?.cancel().catch(() => undefined);
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
export class PerformanceStopwatch implements SttMonotonicClockPort {
  constructor(private readonly source: () => number = () => performance.now()) {}

  monotonicMs(): number {
    return this.source();
  }
}
