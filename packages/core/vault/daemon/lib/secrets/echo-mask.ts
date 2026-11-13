import { MINTED_DEFAULT_BODY_BYTES, MINTED_REPLY_HEADERS, type MintedBody } from '../../../contract/index.ts';

/**
 * Sanitizing a stranger's reply to a request that carried a credential, INSIDE the Vault, the one holder of what was
 * sent. A reply that echoes the credential is a leak whatever carries it, and a literal search finds only one spelling,
 * so this masks the value AS SENT in every spelling a server can reasonably give it:
 *
 *   literal · JSON-escaped (quotes, `\/`, `\uXXXX`) · URL-encoded · base64 and base64url at any alignment · hex
 *
 * and, because a JSON body can spell it in a mix of escapes no list covers, a body that parses as JSON is masked AGAIN
 * after the parse, string by string (names included). The text is masked whole, never chunk by chunk, so a value split
 * across chunks is found. Where it cannot be sure (binary, compressed or undecodable bytes, a body that is not text, one
 * past its bound) it FAILS CLOSED: the body is dropped and the reason is a sentence.
 */

/** A mask for the credential's every spelling, longest first so a longer spelling is not left half-masked. */
export interface EchoMask {
  readonly forms: readonly string[];
  readonly mask: string;
}

const MIN_FORM_LENGTH = 4;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** `\uXXXX` for every UTF-16 unit, in the case of the hex digits the caller wants. */
const unicodeEscaped = (text: string, upper: boolean): string =>
  Array.from({ length: text.length }, (_, index) => {
    const digits = text.charCodeAt(index).toString(16).padStart(4, '0');
    return `\\u${upper ? digits.toUpperCase() : digits}`;
  }).join('');

/** `%XX` for every byte. */
const percentAll = (bytes: Uint8Array, upper: boolean): string =>
  [...bytes]
    .map(byte => {
      const digits = byte.toString(16).padStart(2, '0');
      return `%${upper ? digits.toUpperCase() : digits}`;
    })
    .join('');

/**
 * The base64 of `bytes` as it would read INSIDE a longer base64 text: the encoding depends on where the bytes start
 * (0, 1 or 2 bytes into a group), and only the characters made wholly of these bytes are the same everywhere.
 */
function base64Alignments(bytes: Uint8Array): readonly string[] {
  const forms: string[] = [];
  for (const lead of [0, 1, 2]) {
    const padded = new Uint8Array(lead + bytes.length);
    padded.set(bytes, lead);
    const text = Buffer.from(padded).toString('base64').replaceAll('=', '');
    const from = Math.ceil((lead * 8) / 6);
    const to = Math.floor((padded.length * 8) / 6);
    forms.push(text.slice(from, to));
  }
  return forms;
}

const toBase64Url = (text: string): string => text.replaceAll('+', '-').replaceAll('/', '_');

/** Every spelling of one string worth masking (see the file comment). */
function spellings(text: string): string[] {
  const bytes = utf8(text);
  const json = JSON.stringify(text).slice(1, -1);
  const standard = base64Alignments(bytes);
  const percent = encodeURIComponent(text);
  return [
    text,
    json,
    text.replaceAll('/', '\\/'),
    json.replaceAll('/', '\\/'),
    unicodeEscaped(text, false),
    unicodeEscaped(text, true),
    percent,
    percent.replace(/%[0-9A-F]{2}/gu, match => match.toLowerCase()),
    percent.replaceAll('%20', '+'),
    percentAll(bytes, false),
    percentAll(bytes, true),
    ...standard,
    ...standard.map(toBase64Url),
    hex(bytes),
    hex(bytes).toUpperCase(),
  ];
}

/**
 * The spellings of everything that was SENT: the value, and the whole header value it travelled in (`Bearer value`).
 * Empty and too-short spellings are never searched for (a short needle matches everywhere), except the literal ones.
 */
export function echoMask(sent: readonly string[], mask: string): EchoMask {
  const forms = new Set<string>();
  for (const text of sent) {
    if (text.length === 0) continue;
    forms.add(text);
    for (const form of spellings(text)) if (form.length >= MIN_FORM_LENGTH) forms.add(form);
  }
  return { forms: [...forms].sort((left, right) => right.length - left.length), mask };
}

/** `text` with every spelling replaced. */
export function maskText(text: string, around: EchoMask): string {
  let out = text;
  for (const form of around.forms) if (out.includes(form)) out = out.split(form).join(around.mask);
  return out;
}

function maskJsonValue(value: unknown, around: EchoMask): unknown {
  if (typeof value === 'string') return maskText(value, around);
  if (Array.isArray(value)) return value.map(item => maskJsonValue(item, around));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [maskText(key, around), maskJsonValue(item, around)]),
    );
  return value;
}

/**
 * One document's text, masked: when it parses as JSON the decoded strings are masked (whatever escapes spelled them)
 * and the result is written back only if that changed something, and the final text is masked once more. Text that is
 * not JSON is masked line by line, so one JSON document per line (NDJSON) is covered too.
 */
export function maskPayload(text: string, around: EchoMask): string {
  const whole = parsed(text);
  if (whole !== undefined) {
    const masked = JSON.stringify(maskJsonValue(whole.value, around));
    return maskText(masked === JSON.stringify(whole.value) ? text : masked, around);
  }
  if (!text.includes('\n')) return maskText(text, around);
  return text
    .split('\n')
    .map(line => {
      const one = parsed(line);
      if (one === undefined) return maskText(line, around);
      const masked = JSON.stringify(maskJsonValue(one.value, around));
      return maskText(masked === JSON.stringify(one.value) ? line : masked, around);
    })
    .join('\n');
}

function parsed(text: string): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/** One complete server-sent event (no trailing blank line), masked: its `data` as one payload, every other line as text. */
export function maskEvent(block: string, around: EchoMask): string {
  const lines = block.split(/\r?\n/u);
  const data: string[] = [];
  let at = -1;
  const rest: { readonly line: string | undefined }[] = [];
  for (const line of lines) {
    if (line === 'data' || line.startsWith('data:')) {
      if (at < 0) {
        at = rest.length;
        rest.push({ line: undefined });
      }
      data.push(line.slice(5).replace(/^ /u, ''));
    } else rest.push({ line: maskText(line, around) });
  }
  const payload = data.length === 0 ? [] : maskPayload(data.join('\n'), around).split('\n');
  return rest
    .flatMap(entry => (entry.line === undefined ? payload.map(line => `data: ${line}`) : [entry.line]))
    .join('\n');
}

const TEXT_TYPE =
  /^(?:text\/[a-z0-9.+-]+|application\/(?:json|x-ndjson|ndjson|jsonl|xml|javascript)|[a-z]+\/[a-z0-9.+-]*\+(?:json|xml))$/iu;
const BODILESS = new Set([204, 205, 304]);

/** The text type of a `content-type`, or why it is not one this can be sure of. */
function textual(contentType: string | null): boolean {
  if (contentType === null) return false;
  const [type = '', ...parameters] = contentType.split(';').map(part => part.trim());
  if (!TEXT_TYPE.test(type)) return false;
  for (const parameter of parameters) {
    const match = /^charset\s*=\s*"?([^"]+)"?$/iu.exec(parameter);
    if (match !== null && !['utf-8', 'utf8', 'us-ascii'].includes((match[1] ?? '').toLowerCase())) return false;
  }
  return true;
}

const dropped = (why: string): MintedBody => ({ kind: 'dropped', why });

/**
 * The body of `response`, sanitized. An event stream becomes complete masked events as they arrive; any other text type
 * is read whole (up to `maxBytes`) and masked as one document. Anything this cannot be sure of is dropped.
 */
export async function sanitizeBody(
  response: Response,
  around: EchoMask,
  maxBytes: number = MINTED_DEFAULT_BODY_BYTES,
): Promise<MintedBody> {
  const body = response.body;
  const encoding = (response.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
  if (BODILESS.has(response.status) || body === null) return { kind: 'text', text: '' };
  if (response.headers.get('content-length') === '0') {
    await body.cancel().catch(() => undefined);
    return { kind: 'text', text: '' };
  }
  const contentType = response.headers.get('content-type');
  if (encoding !== 'identity' && encoding !== '') {
    await body.cancel().catch(() => undefined);
    return dropped('The server compressed its answer, so the Vault could not check it for the sign-in and kept it.');
  }
  if (!textual(contentType)) {
    await body.cancel().catch(() => undefined);
    return dropped(
      'The server’s answer is not plain text, so the Vault could not check it for the sign-in and kept it.',
    );
  }
  if ((contentType ?? '').toLowerCase().startsWith('text/event-stream'))
    return { kind: 'events', events: eventStream(body, around, maxBytes) };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = body.getReader();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      bytes += read.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return dropped('The server’s answer was larger than a check reads, so the Vault kept it.');
      }
      text += decoder.decode(read.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof TypeError) return dropped('The server’s answer was not valid text, so the Vault kept it.');
    throw error;
  }
  return { kind: 'text', text: maskPayload(text, around) };
}

/** Whole masked events from a byte stream; a stream that breaks the bounds or the text rule ends with an error. */
function eventStream(body: ReadableStream<Uint8Array>, around: EchoMask, maxBytes: number): ReadableStream<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let held = '';
  let bytes = 0;
  const boundary = /\r?\n\r?\n/u;
  return body.pipeThrough(
    new TransformStream<Uint8Array, string>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new Error('the event stream was larger than a check reads');
        try {
          held += decoder.decode(chunk, { stream: true });
        } catch {
          throw new Error('the event stream was not valid text');
        }
        for (;;) {
          const found = boundary.exec(held);
          if (found === null) break;
          controller.enqueue(`${maskEvent(held.slice(0, found.index), around)}\n\n`);
          held = held.slice(found.index + found[0].length);
        }
      },
      flush(controller) {
        let tail = held;
        try {
          tail += decoder.decode();
        } catch {
          throw new Error('the event stream was not valid text');
        }
        if (tail.trim().length > 0) controller.enqueue(maskEvent(tail, around));
      },
    }),
  );
}

/** The allowlisted headers of a reply, names and values masked. */
export function maskReplyHeaders(headers: Headers, around: EchoMask): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of MINTED_REPLY_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[maskText(name, around)] = maskText(value, around);
  }
  return out;
}
