import type { Scrub, TextRedactor } from '../secrets/redaction.ts';
import type { TerminalCapture } from './redraw.ts';

/**
 * A PANE CAPTURE WITH EVERY KNOWN SECRET MASKED, for a viewer.
 *
 * The operator's screen and an agent's read are scrubbed; the live stream the app draws is the same pane,
 * so it must be too. A capture is rows carrying colour codes, and a value that wrapped sits split across
 * two rows with codes possibly between. So the rows are read as plain text joined end to end, masked once
 * (one vault open for the whole capture), and the masks are put back into the ROWS THEY CAME FROM: a row a
 * mask touches is redrawn as plain text, every other row keeps its colours. A masked row may be longer or
 * shorter than it was; it is a screen, not an address.
 *
 * The redactor returns text, not positions, and no accessor may return a value, so where each mask sits is
 * recovered by aligning the text before and after. An alignment that cannot be confirmed hides everything
 * from the mask on, never less.
 */

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const ESCAPES = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)|.)`, 'gsu');
const MARKER = /\[redacted:[^\]\n]*\]/uy;

interface Span {
  readonly start: number;
  readonly end: number;
  readonly marker: string;
}

const strip = (row: string): string => row.replaceAll(ESCAPES, '');

function markerAt(text: string, at: number): string | undefined {
  MARKER.lastIndex = at;
  return MARKER.exec(text)?.[0];
}

/** Where each run of masks in `masked` sits in `original`, by walking both and confirming every span by scrubbing it. */
function spansOf(original: string, masked: string, scrub: Scrub): readonly Span[] {
  const spans: Span[] = [];
  let o = 0;
  let m = 0;
  while (m < masked.length) {
    const first = markerAt(masked, m);
    if (first === undefined || original.startsWith(first, o)) {
      m += 1;
      o += 1;
      continue;
    }
    let marker = first;
    m += first.length;
    for (let next = markerAt(masked, m); next !== undefined; next = markerAt(masked, m)) {
      marker += next;
      m += next.length;
    }
    let after = m;
    while (after < masked.length && markerAt(masked, after) === undefined) after += 1;
    const segment = masked.slice(m, after);
    let end = original.length;
    for (
      let candidate = original.indexOf(segment, o + 1);
      candidate !== -1 && segment !== '';
      candidate = original.indexOf(segment, candidate + 1)
    ) {
      if (scrub.text(original.slice(o, candidate)) === marker) {
        end = candidate;
        break;
      }
    }
    spans.push({ start: o, end, marker });
    o = end;
  }
  return spans;
}

function redactRows(capture: TerminalCapture, scrub: Scrub): TerminalCapture {
  const plain = capture.lines.map(strip);
  const joined = plain.join('');
  const masked = scrub.text(joined);
  if (masked === joined) return capture;
  const out = joined.split('');
  const spans = spansOf(joined, masked, scrub);
  for (const span of spans) {
    out[span.start] = span.marker;
    for (let i = span.start + 1; i < span.end; i += 1) out[i] = '';
  }
  let rowStart = 0;
  const lines = capture.lines.map((line, index) => {
    const rowEnd = rowStart + (plain[index]?.length ?? 0);
    const start = rowStart;
    rowStart = rowEnd;
    const touched = spans.some(span => span.start < rowEnd && span.end > start);
    return touched ? out.slice(start, rowEnd).join('') + RESET : line;
  });
  return { ...capture, lines };
}

/** `capture` with every secret the redactor knows masked. A redactor that fails fails the capture: nothing unmasked is returned. */
export async function redactCapture(capture: TerminalCapture, redactor: TextRedactor): Promise<TerminalCapture> {
  return await redactor.batch(scrub => redactRows(capture, scrub));
}
