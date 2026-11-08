import type { RedactionScope } from '@ferretry/kernel/contract';

/**
 * A FILE AS IT LEAVES THE DAEMON, with every secret the read's scope knows masked.
 *
 * The outbound projection only: the bytes on disk are never touched. Masking is POSITIONAL (a covered character
 * becomes `*` where it stood), so the file keeps its length in characters and its line count. The lines are matched
 * as one run by the scope, so a value that spans lines is found whole, and each line on its own is covered by the
 * same look.
 */
export function redactedFileText(text: string, scope: RedactionScope): string {
  const lines = text.split('\n').map((line, at, all) => (at < all.length - 1 ? line + '\n' : line));
  const masked = scope.lines(lines);
  return masked.join('');
}

/**
 * A base64 read of a TEXT file is the same bytes in another coat, so it is masked too: decoded, masked as text, and
 * encoded again. Bytes that are not valid UTF-8 text (or hold a NUL) get a byte-for-byte pass: read as latin1 (one byte,
 * one unit) and every byte of a matched value becomes `*`, length kept. That finds every ASCII value wherever it sits
 * in the bytes. Not covered: values inside compressed containers, UTF-16 files, and non-ASCII values in such bytes.
 */
export function redactedFileBase64(base64: string, scope: RedactionScope): string {
  const bytes = Buffer.from(base64, 'base64');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return redactedBytes(bytes, base64, scope);
  }
  if (text.includes('\0')) return redactedBytes(bytes, base64, scope);
  const masked = redactedFileText(text, scope);
  return masked === text ? base64 : Buffer.from(masked, 'utf8').toString('base64');
}

function redactedBytes(bytes: Buffer, base64: string, scope: RedactionScope): string {
  const latin = bytes.toString('latin1');
  const masked = redactedFileText(latin, scope);
  const out = Buffer.from(bytes);
  let changed = false;
  for (let at = 0; at < latin.length; at++) {
    if (masked[at] !== latin[at]) {
      out[at] = 0x2a;
      changed = true;
    }
  }
  return changed ? out.toString('base64') : base64;
}
