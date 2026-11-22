/**
 * Forgives the three accidents that made a well-meant block draw as code: Windows line endings (the `---` boundary then
 * reads `---\r`), trailing spaces on a header or the boundary line, and blank lines before the first header. Only the
 * header half and the boundary line are touched; everything after the boundary line is the payload and stays
 * byte-for-byte as authored (a CRLF payload keeps its `\r\n`, trailing spaces stay). Still strict where the contract is:
 * the boundary must be exactly `---` once the line's own trailing whitespace is gone, and the language and keys stay
 * lowercase.
 *
 * Its own file because the Durian worker reads `fy-render` blocks (`hypermedia/fy-render-parse.ts`) and must not carry the
 * fence door's React components, which live beside it in `fences.tsx`.
 */
export function tolerateAuthoringNoise(source: string): string {
  const lineEnd = /([^\r\n]*)(\r\n|\r|\n|$)/gy;
  let offset = 0;
  while (offset <= source.length) {
    lineEnd.lastIndex = offset;
    const match = lineEnd.exec(source);
    if (match === null) break;
    const [whole, text = '', terminator = ''] = match;
    if (text.trimEnd() === '---') {
      const head = source
        .slice(0, offset)
        .split(/\r\n|\r|\n/u)
        .slice(0, -1)
        .map(line => line.trimEnd());
      while (head.length > 0 && head[0] === '') head.shift();
      const payload = source.slice(offset + whole.length);
      return [...head, '---'].join('\n') + (terminator === '' ? '' : '\n') + payload;
    }
    if (whole === '') break;
    offset += whole.length;
  }
  return source.replace(/\r\n?/gu, '\n');
}
