import { MINTED_DEFAULT_BODY_BYTES, MINTED_REPLY_HEADERS, type MintedBody } from '../../../contract/index.ts';

/**
 * Sanitizing a stranger's reply to a request that carried a credential, INSIDE the Vault, the one holder of what was
 * sent. Listing the spellings a server could give the value cannot win (partial or mixed-case percent-encoding,
 * whitespace-folded base64, HTML entities and the next one all slip past a list), so this does not list them. It
 * DECODES, then CHECKS, then DROPS:
 *
 *   1. Only a body the Vault can PARSE is kept: JSON (`application/json`, `+json`), or an event stream whose `data` is
 *      parsed the same way. Every other type (HTML, XML, plain text, binary, compressed) is dropped with a sentence.
 *   2. The JSON is parsed here and every string in it (keys AND values) is walked. For each string the Vault builds the
 *      forms it can be read in: as it is · repeatedly URI-decoded (tolerant of partial escapes) · HTML-entity decoded ·
 *      backslash-unescaped · hex runs decoded · base64/base64url runs decoded (whitespace folded away) · NFKC-folded,
 *      each compared lower-cased with whitespace removed. If ANY form holds the value as sent, the WHOLE string is
 *      replaced by a fixed marker; nothing is "half masked".
 *   3. The status text and every header kept (an allowlist) get the same check, a string at a time.
 *   4. A body past a bound (size, depth, nodes, forms, work) is DROPPED, never clipped: the Vault fails closed.
 *
 * Out of scope, said plainly (docs/secrets.md): a value a server SPLIT across two strings, a cipher, a reversal, or any
 * form no decoder above produces. The check is "decode and look", not a proof.
 */

/** What was sent, in the two shapes the check compares: `literal` (for a value too short to search for) and `canon`. */
interface Sent {
  readonly literal: string;
  readonly canon: string;
  readonly searchable: boolean;
}

export interface EchoMask {
  readonly sent: readonly Sent[];
  readonly mask: string;
}

const MIN_FORM_LENGTH = 4;
const MAX_DEPTH = 64;
const MAX_NODES = 200_000;
const MAX_FORMS = 1024;
const MAX_DECODE_ROUNDS = 6;
const MAX_WORK_CHARS = 64 * 1024 * 1024;

/** The one thing that can go wrong inside the check: a bound was passed, so the caller fails closed. */
class Bound extends Error {}

/** The work one body (or one field) has used so far. */
interface Work {
  chars: number;
  nodes: number;
}

const newWork = (): Work => ({ chars: 0, nodes: 0 });

const canonical = (text: string): string => text.toLowerCase().replaceAll(/\s+/gu, '');

/** The mask for a credential: what was sent (the value and the whole header value it travelled in) and the marker. */
export function echoMask(sent: readonly string[], mask: string): EchoMask {
  const out: Sent[] = [];
  for (const text of new Set(sent)) {
    if (text.length === 0) continue;
    const canon = canonical(text);
    out.push({ literal: text, canon, searchable: canon.length >= MIN_FORM_LENGTH });
  }
  return { sent: out, mask };
}

// ---- the decoders: each answers the forms a string can ALSO be read as (possibly none) ----

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  excl: '!',
  num: '#',
  dollar: '$',
  percnt: '%',
  lpar: '(',
  rpar: ')',
  ast: '*',
  midast: '*',
  plus: '+',
  comma: ',',
  period: '.',
  sol: '/',
  colon: ':',
  semi: ';',
  equals: '=',
  quest: '?',
  commat: '@',
  lsqb: '[',
  lbrack: '[',
  bsol: '\\',
  rsqb: ']',
  rbrack: ']',
  hat: '^',
  lowbar: '_',
  underbar: '_',
  grave: '`',
  lcub: '{',
  lbrace: '{',
  verbar: '|',
  vert: '|',
  verticalline: '|',
  rcub: '}',
  rbrace: '}',
  tab: '\t',
  newline: '\n',
  hyphen: '-',
  dash: '-',
  minus: '-',
};

const codePoint = (value: number): string => {
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
};

function entities(text: string): string[] {
  if (!text.includes('&')) return [];
  return [
    text.replaceAll(
      /&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]*));?/giu,
      (whole, hex?: string, dec?: string, name?: string) => {
        if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
        if (dec !== undefined) return codePoint(Number.parseInt(dec, 10));
        return NAMED[(name ?? '').toLowerCase()] ?? whole;
      },
    ),
  ];
}

const PERCENT_RUN = /(?:%[0-9a-f]{2})+/giu;

/** Percent-decoding that tolerates a partial escape: each run of valid escapes is decoded, anything else is left. */
function decodePercent(text: string): string {
  return text.replaceAll(PERCENT_RUN, run => {
    try {
      return decodeURIComponent(run);
    } catch {
      const bytes = Uint8Array.from(run.split('%').slice(1), pair => Number.parseInt(pair, 16));
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
  });
}

function percent(text: string): string[] {
  const bases = text.includes('+') ? [text, text.replaceAll('+', ' ')] : [text];
  return bases.map(base => (/%[0-9a-f]{2}/iu.test(base) ? decodePercent(base) : base));
}

const ESCAPE = /\\(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([\s\S]))/giu;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

function backslashes(text: string): string[] {
  if (!text.includes('\\')) return [];
  return [
    text.replaceAll(ESCAPE, (_whole, braced?: string, four?: string, two?: string, other?: string) => {
      const hex = braced ?? four ?? two;
      if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
      return SIMPLE_ESCAPES[other ?? ''] ?? other ?? '';
    }),
  ];
}

/** The readable stretches (four or more characters) of some decoded bytes: a decode of anything else is not a credential. */
function readable(bytes: Uint8Array): string[] {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text.match(/[^\p{C}�]{4,}/gu) ?? [];
}

function hexes(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(/[0-9a-f]{8,}/giu) ?? [])
    for (const offset of [0, 1]) {
      const part = run.slice(offset, run.length - ((run.length - offset) % 2));
      if (part.length >= 8) out.push(...readable(Buffer.from(part, 'hex')));
    }
  return out;
}

function base64s(text: string): string[] {
  const out: string[] = [];
  for (const run of text.replaceAll(/\s+/gu, '').match(/[A-Za-z0-9+/_-]{8,}/gu) ?? [])
    for (const offset of [0, 1, 2, 3]) {
      const part = run.slice(offset).replaceAll('-', '+').replaceAll('_', '/');
      if (part.length >= 8) out.push(...readable(Buffer.from(part, 'base64')));
    }
  return out;
}

function folded(text: string): string[] {
  const form = text.normalize('NFKC');
  return form === text ? [] : [form];
}

const DECODERS: readonly ((text: string) => string[])[] = [percent, entities, backslashes, hexes, base64s, folded];

/** Every form `text` can be read in, each decoded further until nothing new appears (bounded: over a bound, including the round cap with forms left to decode, the check throws `Bound`). */
function formsOf(text: string, work: Work): Set<string> {
  const seen = new Set<string>([text]);
  let frontier = [text];
  for (let round = 0; round < MAX_DECODE_ROUNDS && frontier.length > 0; round += 1) {
    const next: string[] = [];
    for (const form of frontier) {
      if (form.length < MIN_FORM_LENGTH) continue;
      work.chars += form.length;
      if (work.chars > MAX_WORK_CHARS) throw new Bound('too much to decode');
      for (const decoder of DECODERS)
        for (const found of decoder(form)) {
          if (found.length < MIN_FORM_LENGTH || seen.has(found)) continue;
          seen.add(found);
          next.push(found);
          if (seen.size > MAX_FORMS) throw new Bound('too many forms');
        }
    }
    frontier = next;
  }
  // The round cap ended the walk with forms still undecoded: the set is NOT complete, so it must not be reported as
  // checked. Failing closed here lets every caller drop the body or replace the field.
  if (frontier.length > 0) throw new Bound('too many decoding rounds');
  return seen;
}

/** Whether any form of `text` holds what was sent. */
function leaks(text: string, around: EchoMask, work: Work): boolean {
  if (text.length === 0 || around.sent.length === 0) return false;
  for (const form of formsOf(text, work)) {
    const canon = canonical(form);
    for (const sent of around.sent) {
      // a value too short to search for is looked for only in the string AS IT IS, never in a decoded form
      if (sent.searchable ? canon.includes(sent.canon) : form === text && form.includes(sent.literal)) return true;
    }
  }
  return false;
}

/**
 * One string, checked: itself, or the marker for the WHOLE string when any form of it holds what was sent. A string
 * the check cannot finish is replaced too (a field, unlike a body, has no "drop": the marker is the safe answer).
 */
export function maskText(text: string, around: EchoMask): string {
  try {
    return leaks(text, around, newWork()) ? around.mask : text;
  } catch (error) {
    if (error instanceof Bound) return around.mask;
    throw error;
  }
}

function cleanValue(value: unknown, around: EchoMask, work: Work, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Bound('too deep');
  work.nodes += 1;
  if (work.nodes > MAX_NODES) throw new Bound('too many values');
  if (typeof value === 'string') return leaks(value, around, work) ? around.mask : value;
  // A digit credential can ride as a JSON number.
  if (typeof value === 'number') return leaks(String(value), around, work) ? around.mask : value;
  if (Array.isArray(value)) return value.map(item => cleanValue(item, around, work, depth + 1));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        leaks(key, around, work) ? around.mask : key,
        cleanValue(item, around, work, depth + 1),
      ]),
    );
  return value;
}

/** The text of one JSON document, parsed here and written back with every string checked; throws if it is not JSON or a bound is passed. */
export function maskJson(text: string, around: EchoMask): string {
  if (text.trim().length === 0) return '';
  return JSON.stringify(cleanValue(JSON.parse(text) as unknown, around, newWork(), 0));
}

/**
 * One complete server-sent event (no trailing blank line), rebuilt from checked parts: `data` is parsed as JSON and
 * every string in it checked (a `data` that is not JSON, such as an old transport's endpoint path, is checked as ONE
 * string); `event` and `id` are checked as strings; `retry` is kept only as digits; comments and other fields are dropped.
 */
export function maskEvent(block: string, around: EchoMask): string {
  const data: string[] = [];
  const kept: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '');
    if (field === 'data') data.push(value);
    else if (field === 'event' || field === 'id')
      kept.push(`${field}: ${maskText(value.replaceAll(/[\r\n]/gu, ' '), around)}`);
    else if (field === 'retry' && /^\d{1,9}$/u.test(value) && maskText(value, around) === value)
      kept.push(`retry: ${value}`);
  }
  if (data.length > 0) {
    const joined = data.join('\n');
    let payload: string;
    try {
      payload = maskJson(joined, around);
    } catch (error) {
      if (error instanceof Bound) throw error;
      payload = maskText(joined, around);
    }
    for (const part of payload.split('\n')) kept.push(`data: ${part}`);
  }
  return kept.join('\n');
}

const JSON_TYPE = /^(?:application\/json|[a-z]+\/[a-z0-9.+-]*\+json)$/iu;
const BODILESS = new Set([204, 205, 304]);

type Kind = 'json' | 'events';

/** What the Vault can parse a `content-type` as, or undefined. A charset other than UTF-8 is not parsed. */
function parseableAs(contentType: string | null): Kind | undefined {
  if (contentType === null) return undefined;
  const [type = '', ...parameters] = contentType.split(';').map(part => part.trim());
  for (const parameter of parameters) {
    const match = /^charset\s*=\s*"?([^"]+)"?$/iu.exec(parameter);
    if (match !== null && !['utf-8', 'utf8', 'us-ascii'].includes((match[1] ?? '').toLowerCase())) return undefined;
  }
  if (type.toLowerCase() === 'text/event-stream') return 'events';
  return JSON_TYPE.test(type) ? 'json' : undefined;
}

const dropped = (why: string): MintedBody => ({ kind: 'dropped', why });

const NOT_PARSEABLE = 'The server’s answer is not JSON, so the Vault could not check it for the sign-in and kept it.';
const COMPRESSED = 'The server compressed its answer, so the Vault could not check it for the sign-in and kept it.';
const TOO_LARGE = 'The server’s answer was larger than a check reads, so the Vault kept it.';
const NOT_TEXT = 'The server’s answer was not valid text, so the Vault kept it.';
const NOT_JSON_TEXT =
  'The server’s answer was not valid JSON, so the Vault could not check it for the sign-in and kept it.';
const TOO_COMPLEX = 'The server’s answer was too deep or too long to check for the sign-in, so the Vault kept it.';

/**
 * The body of `response`, sanitized. An event stream becomes complete rebuilt events as they arrive; JSON is read whole
 * (up to `maxBytes`), parsed and rewritten. Anything else, or anything this cannot finish checking, is dropped.
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
  if (encoding !== 'identity' && encoding !== '') {
    await body.cancel().catch(() => undefined);
    return dropped(COMPRESSED);
  }
  const kind = parseableAs(response.headers.get('content-type'));
  if (kind === undefined) {
    await body.cancel().catch(() => undefined);
    return dropped(NOT_PARSEABLE);
  }
  if (kind === 'events') return { kind: 'events', events: eventStream(body, around, maxBytes) };
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
        return dropped(TOO_LARGE);
      }
      text += decoder.decode(read.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof TypeError) return dropped(NOT_TEXT);
    throw error;
  }
  try {
    return { kind: 'text', text: maskJson(text, around) };
  } catch (error) {
    if (error instanceof Bound || error instanceof RangeError) return dropped(TOO_COMPLEX);
    if (error instanceof SyntaxError) return dropped(NOT_JSON_TEXT);
    throw error;
  }
}

/** Whole checked events from a byte stream; a stream that breaks a bound or the text rule ends with an error. */
function eventStream(body: ReadableStream<Uint8Array>, around: EchoMask, maxBytes: number): ReadableStream<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let held = '';
  let bytes = 0;
  const boundary = /\r?\n\r?\n/u;
  const checked = (block: string): string => {
    try {
      return maskEvent(block, around);
    } catch (error) {
      if (error instanceof Bound || error instanceof RangeError)
        throw new Error('the event stream was too complex to check');
      throw error;
    }
  };
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
          const event = checked(held.slice(0, found.index));
          if (event.length > 0) controller.enqueue(`${event}\n\n`);
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
        if (tail.trim().length > 0) {
          const event = checked(tail);
          if (event.length > 0) controller.enqueue(event);
        }
      },
    }),
  );
}

/** The allowlisted headers of a reply (the names are the allowlist's own), each value checked as a string. */
export function maskReplyHeaders(headers: Headers, around: EchoMask): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of MINTED_REPLY_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = maskText(value, around);
  }
  return out;
}
