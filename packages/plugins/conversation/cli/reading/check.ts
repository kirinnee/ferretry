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
import { check, type ParseOptions, type Problem, parse, setYamlParser } from 'durian-hypermedia';
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

/** The fence token whose whole info string makes a block ours; any longer info string is plain code. */
const FY_RENDER_FENCE = 'fy-render';

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

/** Every `fy-render` fence of a message, read by the rules above; a fence inside another fence is an example. */
function fyRenderFindings(text: string): Finding[] {
  const lines = text.split('\n');
  const found: Finding[] = [];
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
    } else if (info === FY_RENDER_FENCE && end < lines.length) {
      const prefix = open.prefix as string;
      const body = lines
        .slice(index + 1, end)
        .map(line => (prefix !== '' && line.startsWith(prefix) ? line.slice(prefix.length) : line));
      const reason = fyRenderRefusal(body.join('\n'));
      if (reason !== null)
        found.push({ line: index + 1, level: 'error', message: `${reason}; the block is shown as a plain code fence` });
    }
    index = end;
  }
  return found;
}

/** Durian's problems for one message, as it is read in chat: no front matter, the message size cap. */
function durianFindings(text: string): Finding[] {
  configureYaml();
  const options = { frontMatter: false, limits: CHECK_LIMITS };
  return problemsOf(text, options).map((problem: Problem) => ({
    line: problem.line,
    level: problem.level,
    message: problem.message,
  }));
}

/**
 * Durian's problems for `text`. A text past the size cap is refused by `parse` before it records what `check` needs
 * (Durian v0.5.1 then throws a TypeError from `check`), so that one case reads the problems `parse` itself reports:
 * the page is too big, which is the whole answer.
 */
function problemsOf(text: string, options: ParseOptions): readonly Problem[] {
  try {
    return check(text, options);
  } catch {
    return parse(text, options).problems;
  }
}

/** Every problem of a message, in the order it appears. Pure over its input. */
export function checkMessage(text: string): readonly Finding[] {
  return [...durianFindings(text), ...fyRenderFindings(text)]
    .map((finding, order) => ({ finding, order }))
    .sort((a, b) => a.finding.line - b.finding.line || a.order - b.order)
    .map(({ finding }) => finding);
}

/** `line 8: a code fence is never closed` — a warning says so before its words. */
export const findingLine = (finding: Finding): string =>
  `line ${finding.line}: ${finding.level === 'warn' ? 'warning: ' : ''}${finding.message}`;
