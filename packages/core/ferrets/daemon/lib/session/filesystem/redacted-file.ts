import type { RedactionScope } from '@ferretry/kernel/contract';

/**
 * A FILE AS IT LEAVES THE DAEMON, with every secret the read's scope knows masked.
 *
 * The outbound projection only: the bytes on disk are never touched. Masking is POSITIONAL (a covered character
 * becomes `*` where it stood), so the file keeps its length in characters and its line count: a line break (`\n`,
 * and the `\r` before it) is never starred, so a masked multi-line value is one mask per original line. The lines are
 * matched as one run by the scope, so a value that spans lines is found whole, and each line on its own is covered by
 * the same look.
 *
 * A CRLF file is looked at TWO ways and the coverage is the union: as it is (a value stored with `\r` in it, such as
 * a CRLF key file or `token\r`, is found) and with the `\r` before each line break left out (a value stored with LF
 * is found). Positions line up, because the second look only loses `\r` units, which are never covered.
 */
export interface MaskedText {
  readonly text: string;
  /** Whether the scope reported ANY coverage. A refusal rests on this, never on how the text compares. */
  readonly covered: boolean;
}

export function redactedFile(text: string, scope: RedactionScope): MaskedText {
  const row = coverage(text, scope);
  if (!row.includes(true)) return { text, covered: false };
  let out = '';
  for (let unit = 0; unit < text.length; unit++) {
    const char = text.charAt(unit);
    out += row[unit] === true && char !== '\n' && char !== '\r' ? '*' : char;
  }
  return { text: out, covered: true };
}

export function redactedFileText(text: string, scope: RedactionScope): string {
  return redactedFile(text, scope).text;
}

/**
 * Which UTF-16 units of the text the scope covers: the union of THREE looks. As it is; with the `\r` before each line
 * break left out (a value stored with LF); and with every line break made CRLF (a value stored with CRLF, served from a
 * file that has LF). The last two only change the break, so positions in the line's content line up.
 */
function coverage(text: string, scope: RedactionScope): boolean[] {
  const lines = text.split('\n').map((line, at, all) => (at < all.length - 1 ? `${line}\n` : line));
  const contents = lines.map(line => line.replace(/\r?\n?$/, ''));
  const raw = scope.lines(lines);
  const lf = scope.lines(contents.map(content => `${content}\n`));
  const crlf = scope.lines(contents.map(content => `${content}\r\n`));
  const row: boolean[] = [];
  lines.forEach((line, at) => {
    const content = contents[at] ?? '';
    for (let unit = 0; unit < line.length; unit++) {
      const inContent = unit < content.length;
      row.push(
        (inContent && (raw[at] ?? line).charAt(unit) !== line.charAt(unit)) ||
          (inContent && (lf[at] ?? '').charAt(unit) !== content.charAt(unit)) ||
          (inContent && (crlf[at] ?? '').charAt(unit) !== content.charAt(unit)),
      );
    }
  });
  return row;
}

/**
 * A base64 read of a TEXT file is the same bytes in another coat, so it is masked too: decoded, masked as text, and
 * encoded again. Bytes that are not valid UTF-8 text (or hold a NUL) get a byte-for-byte pass: read as latin1 (one byte,
 * one unit) and every byte of a matched value becomes `*`, length kept. That finds every ASCII value wherever it sits
 * in the bytes. Not covered: values inside compressed containers, UTF-16 files, and non-ASCII values in such bytes.
 */
export function redactedFileBase64(
  base64: string,
  scope: RedactionScope,
): { readonly base64: string; readonly covered: boolean } {
  const bytes = Buffer.from(base64, 'base64');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return redactedBytes(bytes, base64, scope);
  }
  if (text.includes('\0')) return redactedBytes(bytes, base64, scope);
  const masked = redactedFile(text, scope);
  return masked.covered
    ? { base64: Buffer.from(masked.text, 'utf8').toString('base64'), covered: true }
    : { base64, covered: false };
}

function redactedBytes(
  bytes: Buffer,
  base64: string,
  scope: RedactionScope,
): { readonly base64: string; readonly covered: boolean } {
  const latin = bytes.toString('latin1');
  const row = coverage(latin, scope);
  const out = Buffer.from(bytes);
  let changed = false;
  for (let at = 0; at < latin.length; at++) {
    if (row[at] === true) {
      changed = true;
      if (latin[at] !== '\n' && latin[at] !== '\r') out[at] = 0x2a;
    }
  }
  return changed ? { base64: out.toString('base64'), covered: true } : { base64, covered: false };
}
