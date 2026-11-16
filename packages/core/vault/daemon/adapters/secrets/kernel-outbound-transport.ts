import type { Clock, FetchPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { OutboundHttpRequest } from '../../../contract/index.ts';
import type { OutboundOutcome, OutboundTransport } from '../../lib/secrets/authorizer.ts';

/** The narrow slice of a byte stream this transport consumes. */
interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

/**
 * The outbound HTTPS transport behind `authorizeFetch` (today's `FetchEnhancementTransport`, copied): it owns the
 * abort budget, the reply size ceiling and the body handling, and reports facts only. The request goes through the
 * kernel's fetch port and the timer through the kernel's clock; nothing else changed.
 */
export class KernelOutboundTransport implements OutboundTransport {
  constructor(
    private readonly fetchPort: FetchPort,
    private readonly clock: Clock,
  ) {}

  async send(request: OutboundHttpRequest): Promise<OutboundOutcome> {
    const controller = new AbortController();
    const cancel = this.clock.after(milliseconds(request.timeoutMs), () => controller.abort());
    try {
      return await this.exchange(request, controller);
    } finally {
      cancel();
    }
  }

  private async exchange(request: OutboundHttpRequest, controller: AbortController): Promise<OutboundOutcome> {
    let response: Response;
    try {
      response = await this.fetchPort.request(request.url, {
        method: request.method,
        headers: { ...request.headers },
        ...(request.body === undefined ? {} : { body: request.body }),
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
  ): Promise<{ kind: 'text'; value: string } | OutboundOutcome> {
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
