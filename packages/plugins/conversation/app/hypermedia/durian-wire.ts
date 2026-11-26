import type { Document } from 'durian-markdown';

/**
 * WHAT CROSSES BETWEEN THE PAGE AND THE DURIAN WORKER: plain data, nothing else (structured-clone safe, which
 * `tests/unit/app/hypermedia/durian-worker.test.ts` proves on real documents). The page asks for one message to be read; the
 * worker answers with the document, or with "show it as text", or with "it failed". Neither side sends a function, a
 * class instance or a React node. This file imports no Durian code (a type only), so the page can import it.
 */

/** Asks the worker to read one message. `id` ties the answer to the ask. */
export interface ReadRequest {
  readonly kind: 'read';
  readonly id: number;
  readonly source: string;
  readonly idPrefix: string;
  readonly arriving: boolean;
}

/** The bodies of `fy-render` fences the code slot may draw, as `[key, bodies]` pairs (a `Map` is rebuilt on the page). */
export type DrawableEntries = readonly (readonly [string, readonly string[]])[];

/** What the worker sends: it is loaded and listening, or the answer to one ask. */
export type WorkerMessage =
  | { readonly kind: 'ready' }
  | { readonly kind: 'read'; readonly id: number; readonly doc: Document; readonly drawable: DrawableEntries }
  /** The message is to be shown as the text it is (over a cap, or the document made of it is out of proportion). */
  | { readonly kind: 'text'; readonly id: number }
  /** The parse threw. */
  | { readonly kind: 'failed'; readonly id: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Whether `value` is a well-formed {@link ReadRequest}: what the worker reads, so it trusts nothing else. */
export const isReadRequest = (value: unknown): value is ReadRequest =>
  isRecord(value) &&
  value.kind === 'read' &&
  typeof value.id === 'number' &&
  typeof value.source === 'string' &&
  typeof value.idPrefix === 'string' &&
  typeof value.arriving === 'boolean';

/** Whether `value` is a well-formed {@link WorkerMessage}: what the page reads, so it trusts nothing else. */
export function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!isRecord(value)) return false;
  if (value.kind === 'ready') return true;
  if (typeof value.id !== 'number') return false;
  if (value.kind === 'text' || value.kind === 'failed') return true;
  return value.kind === 'read' && isRecord(value.doc) && Array.isArray(value.drawable);
}
