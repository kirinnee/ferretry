/** An account's Unix signing socket. No export operation, TCP listener, private packet or key-file path. */
import type { Clock } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';

export interface GpgListener {
  stop(): Promise<void>;
}
export type GpgListen = (
  socket: string,
  sign: (payload: Uint8Array) => Promise<string>,
  clock: Pick<Clock, 'after'>,
) => Promise<GpgListener>;
const MAX_PAYLOAD = 1024 * 1024;

/** A peer cannot hold the one signing slot indefinitely or buffer an unbounded chunked request. */
async function payloadOf(request: Request, clock: Pick<Clock, 'after'>): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  let expired = false;
  const cancel = clock.after(milliseconds(10_000), () => {
    expired = true;
    void reader.cancel().catch(() => undefined);
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (expired) throw new Error('signing request expired');
      if (done) break;
      size += value.length;
      if (size > MAX_PAYLOAD) {
        await reader.cancel();
        throw new Error('signing request too large');
      }
      chunks.push(value);
    }
    const payload = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(chunk, offset);
      offset += chunk.length;
    }
    return payload;
  } finally {
    cancel();
    reader.releaseLock();
  }
}

export const listenGpg: GpgListen = async (unix, sign, clock) => {
  let live = true;
  let busy = false;
  const server = Bun.serve({
    unix,
    maxRequestBodySize: MAX_PAYLOAD,
    async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/sign')
        return new Response(null, { status: 404 });
      if (!live || busy) return new Response(null, { status: 503 });
      busy = true;
      try {
        const bytes = await payloadOf(request, clock);
        if (bytes.length > MAX_PAYLOAD) return new Response(null, { status: 413 });
        if (!live) return new Response(null, { status: 503 });
        const signature = await sign(bytes);
        return live
          ? new Response(signature, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
          : new Response(null, { status: 503 });
      } catch {
        return new Response(null, { status: 503 });
      } finally {
        busy = false;
      }
    },
  });
  return {
    async stop() {
      live = false;
      await server.stop(true);
    },
  };
};
