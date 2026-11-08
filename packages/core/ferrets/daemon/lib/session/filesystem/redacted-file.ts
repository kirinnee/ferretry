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
 * encoded again. A file that is not valid UTF-8 text (an image, a PDF) is served as it is: its bytes are not a place a
 * vault value can be matched as text.
 */
export function redactedFileBase64(base64: string, scope: RedactionScope): string {
  const bytes = Buffer.from(base64, 'base64');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return base64;
  }
  if (text.includes('\0')) return base64;
  const masked = redactedFileText(text, scope);
  return masked === text ? base64 : Buffer.from(masked, 'utf8').toString('base64');
}
