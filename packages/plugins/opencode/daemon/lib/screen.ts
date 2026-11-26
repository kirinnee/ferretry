import type { HarnessScreenReader, HarnessScreenReading } from '@ferretry/core-ferrets/contract';

const UNKNOWN: HarnessScreenReading = { working: true, atPrompt: false, composer: null };

/** Foreground at one column in tmux's attributed capture. Only measured true-colour ink is accepted. */
function foreground(line: string, column: number): string | undefined {
  let color: string | undefined;
  let cell = 0;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reads ANSI SGR from the attributed terminal capture
  for (const token of line.matchAll(/\x1b\[([0-9;]*)m|([^\x1b])/gu)) {
    if (token[1] !== undefined) {
      const codes = token[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] === 0 || codes[i] === 39) color = undefined;
        if (codes[i] === 38 && codes[i + 1] === 2) {
          color = codes.slice(i + 2, i + 5).join(',');
          i += 4;
        }
      }
    } else if (cell++ === column) return color;
  }
  return undefined;
}

/** The measured 2.4.2 full-screen composer. Unknown screens remain unreadable, with no automatic keys. */
export const opencodeScreen: HarnessScreenReader = {
  key: 'opencode',
  read({ visible, attributed, cursorX, cursorY }) {
    const lines = visible.replaceAll('\r\n', '\n').split('\n');
    const closing = lines.findLastIndex(line => /^\s*╹▀{3,}/u.test(line));
    if (
      closing < 2 ||
      !lines
        .slice(closing + 1, closing + 4)
        .some(line => line.includes('shift+tab agents') && line.includes('ctrl+p commands'))
    )
      return UNKNOWN;
    const status = lines[closing - 1];
    if (status === undefined || !/^\s*┃\s+Build\s+(?:auto\s+)?·/u.test(status)) return UNKNOWN;
    let first = closing - 2;
    while (first > 0 && /^\s*┃/u.test(lines[first - 1] ?? '')) first--;
    const rows = lines.slice(first, closing - 1);
    if (cursorY === undefined || cursorX === undefined || cursorY < first || cursorY >= closing - 1) return UNKNOWN;
    const cursorLine = lines[cursorY] ?? '';
    const bar = cursorLine.indexOf('┃');
    if (bar < 0 || cursorX < bar + 3) return UNKNOWN;
    const text = rows
      .map(line =>
        line
          .slice(line.indexOf('┃') + 1)
          .replace(/^ {0,2}/u, '')
          .trimEnd(),
      )
      .join('\n')
      .trim();
    let placeholder: boolean | undefined;
    const ink = foreground(attributed?.replaceAll('\r\n', '\n').split('\n')[cursorY] ?? '', bar + 3);
    if (text === '') placeholder = false;
    else if (ink === '255,255,255') placeholder = false;
    else if (ink === '128,128,128' && cursorX === bar + 3 && /^Ask anything…\s+"[^"\n]*"$/u.test(text))
      placeholder = true;
    return { working: false, atPrompt: true, composer: { text, placeholder, pasted: false } };
  },
};
