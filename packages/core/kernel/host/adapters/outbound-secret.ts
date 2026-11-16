/**
 * The transport under `kernel.secrets.send` (today's `FetchEnhancementTransport`, as the Vault's
 * `KernelOutboundTransport` copied it): it owns the abort budget, the reply size ceiling and the body handling, and
 * reports facts only. The request goes through the plugin's OWN `kernel.fetch` guard (its declared hosts, no followed
 * redirect) and the timer through the kernel's clock. Only `host/secrets.ts` hands it a request with a credential on
 * it; nothing it answers carries the request, an error or its message.
 */
import { milliseconds } from '@ferretry/std';
import type { Clock, FetchPort } from '../../contract/ports.ts';
import type { OutboundSecretOutcome, OutboundSecretRequest } from '../../contract/secrets.ts';

/** What the transport can observe: every outcome but the refusals and `vault_damaged`, which are decided before it. */
type OutboundTransportOutcome = Exclude<OutboundSecretOutcome, { readonly kind: 'refused' | 'vault_damaged' }>;

/** The network capability with a credential in it. Its only caller is `ownSecretsPort`. */
export interface OutboundSecretTransport {
  send(request: OutboundSecretRequest): Promise<OutboundTransportOutcome>;
}

/** The narrow slice of a byte stream this transport consumes. */
interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

export function outboundSecretTransport(fetchPort: FetchPort, clock: Clock): OutboundSecretTransport {
  return Object.freeze({
    send: async (request: OutboundSecretRequest): Promise<OutboundTransportOutcome> => {
      const controller = new AbortController();
      const cancel = clock.after(milliseconds(request.timeoutMs), () => controller.abort());
      try {
        return await exchange(fetchPort, request, controller);
      } finally {
        cancel();
      }
    },
  });
}

async function exchange(
  fetchPort: FetchPort,
  request: OutboundSecretRequest,
  controller: AbortController,
): Promise<OutboundTransportOutcome> {
  let response: Response;
  try {
    response = await fetchPort.request(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      // A declared host could bounce the request anywhere: the key is never re-sent to where a redirect points.
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch {
    // The error is dropped, not carried: a fetch error's message may quote the request.
    return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'network' };
  }
  if (!response.ok) {
    // The body could echo what was sent and is not needed to classify the failure, so it is released rather than
    // read — but it must be released, or the connection leaks for the rest of the process's life.
    discard(response);
    const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
    return retryAfterSeconds === undefined
      ? { kind: 'status', status: response.status }
      : { kind: 'status', status: response.status, retryAfterSeconds };
  }
  const text = await readBounded(response, request.maxResponseBytes, controller);
  if (text.kind !== 'text') return text;
  try {
    return { kind: 'completion', status: response.status, payload: JSON.parse(text.value) };
  } catch {
    return { kind: 'unreadable' };
  }
}

/**
 * Read the reply through a byte counter and stop at the ceiling. A declared length over the ceiling is refused without
 * reading at all, and an undeclared one is cut off the moment it crosses it.
 */
async function readBounded(
  response: Response,
  maxResponseBytes: number,
  controller: AbortController,
): Promise<{ readonly kind: 'text'; readonly value: string } | OutboundTransportOutcome> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    discard(response);
    return { kind: 'too_large' };
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
      return { kind: 'too_large' };
    }
    value += decoder.decode(bytes, { stream: true });
  }
  return { kind: 'text', value: value + decoder.decode() };
}

/** Best-effort release: a hostile stream may never settle its cancel promise, so it is not waited on. */
function release(reader: ChunkReader): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // A reader that cannot be cancelled is already released.
  }
}

function discard(response: Response): void {
  try {
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
