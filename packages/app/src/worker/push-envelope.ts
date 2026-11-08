import { type PushEnvelope, PushEnvelopeSchema } from '@ferretry/kernel/contract/push-envelope';

/**
 * THE PUSH ENVELOPE THE SHELL'S WORKER READS is declared once, in the kernel contract (`@ferretry/kernel/contract`:
 * `PushEnvelopeSchema`, its caps), because Access's push payload carries the same three fields and a cap that two programs
 * repeat can drift. The worker runs no plugin code and imports no plugin contract; it imports that one file by its own
 * subpath, so its signed graph holds the envelope and zod and not the contract barrel.
 */

/**
 * The envelope inside a push's JSON, or `null` when the push carries none. A real payload also names an event key, a
 * tag, a count and more, which are the plugin's to read and not the worker's: only `title`, `body` and `url` are
 * taken from it, by name, and the envelope is then parsed strictly. Total — it never throws.
 */
export const readPushEnvelope = (json: unknown): PushEnvelope | null => {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  const parsed = PushEnvelopeSchema.safeParse({ title: record.title, body: record.body, url: record.url });
  return parsed.success ? parsed.data : null;
};
