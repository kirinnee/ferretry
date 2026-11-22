import type { WorkerMessage, ReadRequest } from './durian-wire.ts';
import { readMessage } from './parse-message.ts';

/**
 * THE WORKER'S ONE JOB, as a function: read one message and say what came of it. Total: it never throws (a parse that
 * throws is "failed", which the page shows as text), and its answer is plain data (`durian-wire.ts`). `read` is the
 * reader the message goes through, which only a test replaces (the page's own is `readMessage`).
 *
 * THE DURIAN RULE HOLDS HERE BECAUSE IT HOLDS THERE: `readMessage` reads with no front matter, holds chart fences as code and
 * hands Durian our URL policy and caps. Nothing else in the product calls Durian's `parse`.
 */
export function answer(request: ReadRequest, read: typeof readMessage = readMessage): WorkerMessage {
  try {
    const result = read(request.source, request.idPrefix, request.arriving);
    return result === null
      ? { kind: 'text', id: request.id }
      : { kind: 'read', id: request.id, doc: result.doc, drawable: [...result.drawable] };
  } catch {
    return { kind: 'failed', id: request.id };
  }
}
