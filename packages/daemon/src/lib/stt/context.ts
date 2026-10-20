import { parseFerretryNotice, parseHandoffPointer, parsePeerEnvelope } from '@ferretry/protocol';

/**
 * The conversation a cleanup model may read, reduced to plain prose.
 *
 * A raw transcript record is a poor reference: long agent replies carry code blocks, tables and tool
 * output that spend the budget on text nobody dictates, and a record can be Ferretry's own plumbing
 * (a turn-file pointer, a delivery notice) rather than anything a person said. Each message here is
 * reduced to the words a person could plausibly speak, then the newest messages are kept inside a
 * character AND a rough token budget, so the request stays well under a provider's per-request limit.
 */

export const CONTEXT_LIMITS = {
  /** One message, after reduction. Long replies keep their newest words. */
  maxMessageChars: 600,
  /** Every message together, after reduction. */
  maxTotalChars: 2_000,
  /** Roughly what the reference may cost a provider that meters tokens (Groq's smaller tiers are 8k per request). */
  maxTotalTokens: 700,
  /** A sliver smaller than this is not worth a line. */
  minUsefulChars: 24,
} as const;

/** A coarse token cost: the exact tokenizer is the provider's, but scripts without spaces cost about a token a character. */
export function estimateTokens(value: string): number {
  let cost = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    cost += code < 0x100 ? 0.3 : code < 0x800 ? 0.6 : 1;
  }
  return Math.ceil(cost);
}

const PASTED_CONTENT = /<pasted_content(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/pasted_content(?:\s[^>]*)?>/gu;
const FENCED_CODE = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[`~]*[ \t]*(?=\n|$)|$)/gu;
const NOISE_LINE =
  /^\s*(?:\$ |> |@@ |\+\+\+ |--- |diff --git |index [0-9a-f]{6,}|at \S+ \(|at \S+:\d+|\w*(?:Error|Exception)\b.*:\s|\[?(?:INFO|WARN|ERROR|DEBUG)\]?\s|\|?[-: |]{6,}\|?\s*$)/u;
const TABLE_ROW = /^\s*\|.*\|\s*$/u;
const LONG_TOKEN = /[\w+/=.-]{41,}/gu;
const URL = /\bhttps?:\/\/\S+/giu;
const FILE_PATH = /(?:^|\s)(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+){2,}/gu;

/** A record's words, or nothing when the record is Ferretry's own plumbing. */
function spoken(raw: string): string {
  const text = raw.replace(PASTED_CONTENT, (_block, inner: string) => inner);
  if (parseFerretryNotice(text) !== null || parseHandoffPointer(text) !== null) return '';
  const peer = parsePeerEnvelope(text.trimStart());
  return peer === null ? text : peer.body;
}

function plainProse(text: string): string {
  const withoutCode = text.replace(FENCED_CODE, '\n');
  const lines = withoutCode
    .split('\n')
    .filter(line => !NOISE_LINE.test(line) && !TABLE_ROW.test(line))
    .map(line =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/u, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
        .replace(/<\/?[A-Za-z][^>]*>/gu, ' ')
        .replace(/(\*\*|\*|`)/gu, '')
        .replace(URL, ' ')
        .replace(FILE_PATH, ' ')
        .replace(LONG_TOKEN, ' '),
    );
  return lines.join(' ').replace(/\s+/gu, ' ').trim();
}

/** The newest `maxChars` characters, starting at a word boundary when one is near. */
function newestWords(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const tail = value.slice(value.length - maxChars);
  const space = tail.indexOf(' ');
  return space >= 0 && space < 40 ? tail.slice(space + 1) : tail;
}

/**
 * The newest `maxMessages` messages that still hold words once reduced, oldest first, one line each.
 * Walks newest to oldest and stops at the budget, so the peak work is the budget and not the sum of
 * what a caller sent.
 */
export function conversationReference(raw: readonly string[] | undefined, maxMessages: number): readonly string[] {
  const lines: string[] = [];
  let chars = 0;
  let tokens = 0;
  for (const record of [...(raw ?? [])].reverse()) {
    if (lines.length >= maxMessages) break;
    const room = CONTEXT_LIMITS.maxTotalChars - chars;
    if (room < CONTEXT_LIMITS.minUsefulChars || tokens >= CONTEXT_LIMITS.maxTotalTokens) break;
    // A multi-megabyte record is reduced from its newest end only; nothing earlier could survive the cap.
    const prose = plainProse(spoken(record.slice(-CONTEXT_LIMITS.maxTotalChars * 8)));
    if (prose.length === 0) continue;
    let line = newestWords(prose, Math.min(CONTEXT_LIMITS.maxMessageChars, room - 1));
    while (line.length > 0 && tokens + estimateTokens(line) > CONTEXT_LIMITS.maxTotalTokens) {
      line = newestWords(line, Math.floor(line.length / 2));
      if (line.length < CONTEXT_LIMITS.minUsefulChars) line = '';
    }
    if (line.length === 0) break;
    lines.push(line);
    chars += line.length + 1;
    tokens += estimateTokens(line);
  }
  return lines.reverse();
}
