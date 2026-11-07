/**
 * Reading what a package manager said. Copied from today's `tool-install.ts` (`readManagerTail` and its
 * patterns), the part the harness update shared.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const CSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const SHORT_ESCAPE = /\u001b[()#][0-9A-Za-z]|\u001b[<>=]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them IS the purpose
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

/** One output line with every terminal escape and stray control character removed. */
export function stripTerminalEscapes(raw: string): string {
  return raw
    .replaceAll(OSC_SEQUENCE, '')
    .replaceAll(CSI_SEQUENCE, '')
    .replaceAll(SHORT_ESCAPE, '')
    .replaceAll(CONTROL_CHARACTERS, '');
}

/** What a manager prints when it needed rights it was not given. */
const NEEDS_ADMIN: readonly RegExp[] = [
  /\bEACCES\b/u,
  /\bEPERM\b/u,
  /permission denied/iu,
  /sudo: (?:a terminal is required|a password is required|no tty present)/iu,
  /need sudo access/iu,
  /are you root\?/iu,
];

function lastLine(tail: readonly string[]): string | undefined {
  const line = tail
    .map(entry => stripTerminalEscapes(entry).trim())
    .filter(entry => entry !== '')
    .at(-1);
  return line === undefined ? undefined : line.slice(0, 200);
}

/** Whether the manager needed admin rights it was not given, and the last thing it said. */
export function readManagerTail(tail: readonly string[]): { readonly needsAdmin: boolean; readonly said: string | undefined } {
  const lines = tail.map(stripTerminalEscapes);
  return { needsAdmin: lines.some(line => NEEDS_ADMIN.some(pattern => pattern.test(line))), said: lastLine(tail) };
}
