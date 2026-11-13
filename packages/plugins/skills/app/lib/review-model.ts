/**
 * How text carrying hidden-character markers is READ, as a pure function (today's `catalog-review-model.ts`, the part a
 * skill file shown in full uses).
 *
 * The daemon writes each hidden character out as a marker. Nothing here recomputes it; this only finds where the markers
 * sit so each run can be drawn on its own.
 */

/** Markers with nothing between them: a marker the daemon wrote for a hidden character looks like `⟨U+202E⟩`. */
const MARKER_RUN = /(?:⟨U\+[0-9A-F]{4,6}⟩)+/gu;

export interface TextSegment {
  readonly marker: boolean;
  readonly text: string;
}

/** A run of markers, with each stretch of the same one written once and counted: `⟨U+200B ×1,000⟩`. */
const runLabel = (run: string): string => {
  const tokens: { readonly token: string; count: number }[] = [];
  for (const token of run.slice(0, -1).split('⟩')) {
    const last = tokens.at(-1);
    if (last?.token === token) last.count += 1;
    else tokens.push({ token, count: 1 });
  }
  return tokens
    .map(({ token, count }) => (count === 1 ? `${token}⟩` : `${token} ×${count.toLocaleString('en-US')}⟩`))
    .join('');
};

/**
 * Splits text so each run of hidden-character markers can be drawn on its own, as ONE mark that
 * counts repeats, so a file of a million zero-width spaces is one mark and not a million. Nothing but
 * that count is changed: the text between runs is kept as it was.
 */
export function splitMarkers(text: string): readonly TextSegment[] {
  const segments: TextSegment[] = [];
  let from = 0;
  for (const found of text.matchAll(MARKER_RUN)) {
    const at = found.index ?? 0;
    if (at > from) segments.push({ marker: false, text: text.slice(from, at) });
    segments.push({ marker: true, text: runLabel(found[0]) });
    from = at + found[0].length;
  }
  if (from < text.length) segments.push({ marker: false, text: text.slice(from) });
  return segments;
}
