import type { Redaction, RouteHandler } from '@ferretry/kernel/contract';

/** Fields that hold bytes or a digest, not words: masking a run inside them would corrupt the file it names. */
const VERBATIM: ReadonlySet<string> = new Set(['base64', 'sha256']);

const masked = (value: unknown, text: (s: string) => string, key?: string): unknown => {
  if (typeof value === 'string') return key !== undefined && VERBATIM.has(key) ? value : text(value);
  if (Array.isArray(value)) return value.map(item => masked(item, text));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, masked(each, text, name)]));
  return value;
};

const isJson = (headers: ReadonlyMap<string, string>): boolean =>
  (headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');

/**
 * A `guard: 'secrets'` route whose body is built inside one `Redaction.read` (§7.3): the handler runs inside the read,
 * and every string its JSON answer carries is masked before it leaves — a queued message, a draft, a conversation's
 * first words or an attachment's name that holds a pasted secret is served masked. A redaction that cannot open fails
 * the route closed. An answer that is not plain JSON (a stream, a late body) passes as built.
 */
export function maskedBody(redaction: Pick<Redaction, 'read'>, handler: RouteHandler): RouteHandler {
  return async call =>
    await redaction.read(async scope => {
      const response = await handler(call);
      if (!isJson(response.headers) || response.late !== undefined || response.gzip !== undefined) return response;
      return { ...response, body: JSON.stringify(masked(JSON.parse(response.body), scope.text)) };
    });
}
