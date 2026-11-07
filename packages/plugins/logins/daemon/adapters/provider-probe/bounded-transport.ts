import type { AuthorizedOutcome, OutboundHttpRequest } from '@ferretry/core-vault/contract';
import type { Clock, FetchPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';

/** What a plain request to this machine can come back as: a keyless read, so no secret branch. */
export type LocalOutcome = Extract<
  AuthorizedOutcome,
  { kind: 'completion' | 'oversized' | 'unreadable' | 'status' | 'timeout' | 'unreachable' }
>;

/** Sends one keyless request through the kernel's fetch port. */
export interface OutboundTransport {
  send(request: OutboundHttpRequest): Promise<LocalOutcome>;
}

interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

/**
 * The bounded transport behind a keyless local read (Ollama on this machine): it owns the abort budget, the reply
 * size ceiling and the body handling, and reports facts only. Today's `FetchEnhancementTransport`, over the kernel's
 * fetch and clock ports instead of the globals.
 */
export class BoundedTransport implements OutboundTransport {
  constructor(
    private readonly fetchPort: FetchPort,
    private readonly clock: Pick<Clock, 'after'>,
  ) {}

  async send(request: OutboundHttpRequest): Promise<LocalOutcome> {
    const controller = new AbortController();
    const cancel = this.clock.after(milliseconds(request.timeoutMs), () => {
      controller.abort();
    });
    try {
      return await this.exchange(request, controller);
    } finally {
      cancel();
    }
  }

  private async exchange(request: OutboundHttpRequest, controller: AbortController): Promise<LocalOutcome> {
    let response: Response;
    try {
      response = await this.fetchPort.request(request.url, {
        method: request.method,
        headers: { ...request.headers },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
      });
    } catch {
      return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'unreachable' };
    }
    if (!response.ok) {
      // The body is not needed to classify the failure, so it is released rather than read.
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

  /** Read the reply through a byte counter and stop at the ceiling. */
  private async readBounded(
    response: Response,
    maxResponseBytes: number,
    controller: AbortController,
  ): Promise<{ kind: 'text'; value: string } | LocalOutcome> {
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
        release(reader);
        return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'unreadable' };
      }
      if (chunk.done) break;
      const bytes = chunk.value;
      if (bytes === undefined) continue;
      received += bytes.byteLength;
      if (received > maxResponseBytes) {
        controller.abort();
        release(reader);
        return { kind: 'oversized' };
      }
      value += decoder.decode(bytes, { stream: true });
    }
    return { kind: 'text', value: value + decoder.decode() };
  }
}

function release(reader: ChunkReader): void {
  try {
    // Best-effort: a hostile stream may never settle its cancel promise, so it must not hold the request open.
    void reader.cancel().catch(() => undefined);
  } catch {
    // A reader that cannot be cancelled is already released.
  }
}

async function discard(response: Response): Promise<void> {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A body that cannot be cancelled is already released.
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
