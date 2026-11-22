/**
 * THE DOCCHECK AN AGENT CAN RUN ON A MESSAGE BEFORE SENDING IT (`fy render check <file|->`).
 *
 * Two readers, one list of problems:
 *
 *  - Durian's own `check` (the format's rules: an unclosed fence, a chart with no series, a part past its caps), read
 *    with the options a chat message is read with — no front matter, because a message that starts with `---` is
 *    Markdown the reader sees — so a message is checked as it will be drawn.
 *  - the `fy-render` fences, which Durian sees as plain code: each one is read with the contract's own header, alt,
 *    `svg`, `html` and cap rules, the same ones that decide whether the app draws the block or shows it as code.
 *
 * Nothing runs this automatically (no hook, no gate on an agent's output): it is a command an agent chooses to run.
 *
 * A DECLARED GAP: the rules that need the app (a `src:` path's grammar, the `task`/`board` reference list, Lottie's
 * layer count, an inline image's raster header) live in the app half, which a CLI half may not import, so a block that
 * passes here can still fall back to a code fence for one of those reasons. The check says what it can prove.
 */
import { readConfigText } from '@ferretry/std/yaml';
import { check, type ParseOptions, type Problem, setYamlParser } from 'durian-hypermedia';
import { FY_RENDER_LIMITS } from '../../contract/fy-render-caps.ts';
import { parseFyRenderHeaders, validateHtml, validateSvg } from '../../contract/fy-render.ts';

/** One problem: the 1-based line of the message it is on, how bad it is, and what to do. */
export interface Finding {
  readonly line: number;
  readonly level: 'error' | 'warn';
  readonly message: string;
}

/**
 * The size a message may be and still be read as hypermedia. It is the app's own number (`MESSAGE_LIMITS` in
 * `app/hypermedia/limits.ts`); a CLI half cannot import an app half, so `tests/unit/cli/render-check.test.ts` pins the
 * two together.
 */
const CHECK_LIMITS = { maxInputBytes: 300_000 } as const;

/**
 * How much of a message the command reads: one byte past the cap, so a message over it is known to be over without the
 * rest of an arbitrarily large file or pipe being read into memory.
 */
export const CHECK_READ_BYTES = CHECK_LIMITS.maxInputBytes + 1;

/** The whole answer for a message past the cap: the app shows it as text, so no part of it is read as a part. */
const OVER_CAP_FINDING: Finding = {
  line: 1,
  level: 'error',
  message: `the message is over ${CHECK_LIMITS.maxInputBytes.toLocaleString('en-US')} bytes, so it is shown as text`,
};

/** The longest a diagnostic's own words may run on a line of the terminal; message text is clipped to this. */
const MAX_DIAGNOSTIC_CHARACTERS = 200;

/** C0 and C1 controls, DEL, zero-width and bidi marks, line and paragraph separators and the byte order mark. */
const UNSAFE_CHARACTER = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]',
  'gu',
);

/**
 * Text that came from the message (or from a path on the command line), made safe to print: every character that could
 * drive a terminal or hide the end of a line is shown as `\u{hex}`, and the result is clipped to
 * {@link MAX_DIAGNOSTIC_CHARACTERS} with an ellipsis. Pure.
 */
export function diagnosticText(text: string): string {
  const escaped = text.replace(UNSAFE_CHARACTER, each => `\\u{${(each.codePointAt(0) as number).toString(16)}}`);
  const characters = [...escaped];
  return characters.length <= MAX_DIAGNOSTIC_CHARACTERS
    ? escaped
    : `${characters.slice(0, MAX_DIAGNOSTIC_CHARACTERS - 1).join('')}…`;
}

/** The fence token whose whole info string makes a block ours; any longer info string is plain code. */
const FY_RENDER_FENCE = 'fy-render';

/**
 * The Durian parts the app does NOT draw (`app/hypermedia/held-fences.tsx`): a chart's formulas have no bound on their
 * work and the code walk's notes are set as HTML, so each is shown as the code it is. The guide never teaches them; an agent
 * that writes one anyway is told here. The two halves cannot share the list (a CLI half may not import an app half);
 * `tests/unit/cli/render-check.test.ts` pins the words to the app's own held fences.
 */
const HELD_PART_FENCES: ReadonlyMap<string, string> = new Map([
  ['chart', 'a chart is an fy-render block of type chart'],
  ['codewalk', 'show the code in a plain fence with the notes in prose'],
]);

/** A fence line, wherever it sits: after quote marks and a list marker, a run of three or more backticks or tildes. */
const FENCE_LINE = /^(?<prefix>[ \t>]*(?:[-*+]\s+|\d+[.)]\s+)?)(?<run>`{3,}|~{3,})(?<info>.*)$/u;

let configured = false;
/** Durian reads YAML through a parser the host gives it; ours is the repository's bounded reader. Set once. */
function configureYaml(): void {
  if (configured) return;
  configured = true;
  setYamlParser(text => {
    const read = readConfigText(text);
    if (!read.ok) throw new Error(read.errors[0]?.message ?? 'the YAML could not be read');
    return read.read.value;
  });
}

/** U+FEFF: three bytes at the start of a file saved by an editor that writes one. */
const BYTE_ORDER_MARK = '\u{feff}';

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Why the app would show this `fy-render` block as a plain code fence, or `null` when the rules checkable here pass.
 * `source` is the fence body: the header lines, a `---` line, then the payload.
 */
function fyRenderRefusal(source: string): string | null {
  const lines = source.split('\n');
  const boundary = lines.indexOf('---');
  if (boundary === -1) return 'Missing the exact --- boundary line between headers and payload';
  const headers = parseFyRenderHeaders(lines.slice(0, boundary));
  if (typeof headers === 'string') return headers;
  const payload = lines.slice(boundary + 1).join('\n');
  if (headers.src !== undefined)
    return payload.trim() === '' ? null : 'A block with a src header must have an empty payload';
  switch (headers.type) {
    case 'html':
      return validateHtml(payload);
    case 'svg':
      return validateSvg(payload);
    case 'mermaid':
      return [...payload].length > FY_RENDER_LIMITS.mermaidCharacters
        ? 'Mermaid payload exceeds 20,000 characters'
        : null;
    case 'map':
      if (byteLength(payload) > FY_RENDER_LIMITS.mapBytes) return 'Map payload exceeds 32 KiB';
      return payload.trim() === '' ? 'A map block needs a payload describing it' : null;
    case 'chart':
      if (byteLength(payload) > FY_RENDER_LIMITS.chartBytes) return 'Chart payload exceeds 64 KiB';
      return payload.trim() === '' ? 'A chart block needs a payload describing it' : null;
    default:
      return null;
  }
}

/** A line that opens a step the way a part's own marker does: `@step` first on the line, then a space or the end. */
const BARE_STEP = /^\s*@step(?:\s|$)/u;

/**
 * What one scan of a message's fences found: the problems of its `fy-render` fences, the held parts, and the 1-based
 * lines each held part spans (Durian reads those as parts and may call them errors the app never raises).
 */
interface FenceScan {
  readonly found: Finding[];
  readonly held: readonly { readonly from: number; readonly to: number }[];
}

/** Every `fy-render` fence of a message, read by the rules above; a fence inside another fence is an example. */
function scanFences(text: string): FenceScan {
  // Durian ends a line at LF, CRLF or a bare CR; so does this scan, with the same line numbers (a CRLF is one break).
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const found: Finding[] = [];
  const held: { from: number; to: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE_LINE.exec(lines[index] as string)?.groups;
    if (open === undefined) continue;
    const run = open.run as string;
    const info = (open.info as string).trim();
    // Its end: the next line that is only a run of the same mark, at least as long. Unclosed runs to the end of the text.
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const close = FENCE_LINE.exec(lines[next] as string)?.groups;
      if (
        close !== undefined &&
        (close.info as string).trim() === '' &&
        (close.run as string)[0] === run[0] &&
        (close.run as string).length >= run.length
      ) {
        end = next;
        break;
      }
    }
    const first = info.split(/\s+/u)[0];
    if (first === FY_RENDER_FENCE && info !== FY_RENDER_FENCE) {
      found.push({
        line: index + 1,
        level: 'warn',
        message: `the info string "${info}" is not exactly "${FY_RENDER_FENCE}", so this fence is shown as plain code`,
      });
    } else if (HELD_PART_FENCES.has(first as string)) {
      // Only a CLOSED part is held: Durian's complaints about the body of a part the app never draws are not the message's
      // problems. An UNCLOSED one keeps every Durian error, the missing closing fence first: that is a broken message.
      if (end < lines.length) held.push({ from: index + 1, to: end + 1 });
      found.push({
        line: index + 1,
        level: 'warn',
        message: `a ${first} fence is not drawn by the app, so it is shown as plain code; ${HELD_PART_FENCES.get(first as string)}`,
      });
    } else if (info === FY_RENDER_FENCE && end < lines.length) {
      const prefix = open.prefix as string;
      const body = lines
        .slice(index + 1, end)
        .map(line => (prefix !== '' && line.startsWith(prefix) ? line.slice(prefix.length) : line));
      const reason = fyRenderRefusal(body.join('\n'));
      if (reason !== null)
        found.push({ line: index + 1, level: 'error', message: `${reason}; the block is shown as a plain code fence` });
    } else if (first === 'mermaid') {
      // Mermaid's step marker is a comment, `%% @step <title>`; a bare `@step` is not one, so the diagram is a single frame.
      for (let at = index + 1; at < end; at += 1)
        if (BARE_STEP.test(lines[at] as string))
          found.push({
            line: at + 1,
            level: 'warn',
            message: 'a bare @step is not a step in a mermaid diagram (it stays one frame); write `%% @step <caption>`',
          });
    }
    index = end;
  }
  return { found, held };
}

/** Durian's problems for one message, as it is read in chat: no front matter, the message size cap. */
function durianFindings(text: string): Finding[] {
  configureYaml();
  const options: ParseOptions = { frontMatter: false, limits: CHECK_LIMITS };
  return check(text, options).map((problem: Problem) => ({
    line: problem.line,
    level: problem.level,
    message: problem.message,
  }));
}

/**
 * Every problem of a message, in the order it appears. Pure over its input. A message past the size cap is answered by
 * the size finding alone, before Durian or the `fy-render` scan reads a byte of it: it is shown as text, so nothing
 * inside it is a part to check.
 *
 * THE CAP COUNTS THE BYTES AS READ, A BYTE ORDER MARK INCLUDED (a bounded read keeps it: `plugin-host.ts`), and then ONE
 * leading mark is dropped, as the reader of a message drops it, before Durian and the fence scan see the text: with the
 * mark in front, the first line is no fence to the scan and a block that has no alt would pass as "no problems found".
 * A diagnostic's line number is the same either way (the mark is not a line).
 */
export function checkMessage(read: string): readonly Finding[] {
  if (byteLength(read) > CHECK_LIMITS.maxInputBytes) return [OVER_CAP_FINDING];
  const text = read.startsWith(BYTE_ORDER_MARK) ? read.slice(BYTE_ORDER_MARK.length) : read;
  const { found, held } = scanFences(text);
  // A CLOSED held part is shown as code and the scan above already says so as a warning: Durian's own errors on its body
  // (a chart with no series) are about a part the app never draws, so they are not the message's problems.
  const durian = durianFindings(text).filter(
    finding => finding.level !== 'error' || !held.some(span => finding.line >= span.from && finding.line <= span.to),
  );
  return [...durian, ...found]
    .map((finding, order) => ({ finding, order }))
    .sort((a, b) => a.finding.line - b.finding.line || a.order - b.order)
    .map(({ finding }) => finding);
}

/**
 * `line 8: a code fence is never closed` — a warning says so before its words. The words are escaped and bounded
 * ({@link diagnosticText}): some carry text from the message itself, and a terminal must never obey it.
 */
export const findingLine = (finding: Finding): string =>
  `line ${finding.line}: ${finding.level === 'warn' ? 'warning: ' : ''}${diagnosticText(finding.message)}`;
