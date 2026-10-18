import type {
  Harness,
  PermissionAction,
  PermissionOption,
  PermissionOptionKind,
  PermissionRequest,
} from '@ferretry/protocol';

/**
 * THE TOOL-PERMISSION PROMPT A HARNESS IS PARKED ON, read off its visible pane as data.
 *
 * Both harnesses stop before a tool they have not been allowed to run and draw the same shape: a
 * question, then a numbered choice list with a cursor on one row. Claude Code puts a titled dialog
 * under a full-width rule ("Bash command", "Read file", "Edit file", "Create file", "Fetch", "Tool use",
 * "Exit plan mode?"), Codex asks "Would you like to run the following command?" and lists the details
 * under it. The shapes here were read off real panes of Claude Code 2.1.220 and 2.1.281 and Codex
 * 0.145.0 and 0.156.1 (`tests/fixtures/permission-prompts/`), not off the harness source.
 *
 * WHY THE PANE AND NOT A HOOK. Claude's hooks can say THAT a permission prompt is up and which tool
 * asked, but not the rows its dialog offers — "don't ask again for: curl -s https://example.com" is
 * worked out inside the dialog — and an answer is a keystroke into this pane either way. So the pane is
 * the one witness that has everything a person decides on.
 *
 * RECOGNITION IS STRICT. A choice list counts only with a known question shape directly above it and
 * at least two rows numbered 1..n, all within the bottom of the frame: an ordinary numbered list in the
 * agent's own output has no such question, and a dialog that has scrolled up was already answered.
 *
 * PURE AND TOTAL: a frame in, a request or `undefined` out.
 */

/** How far up from the bottom of the frame the choice list may sit; matches `paneShowsPermissionPrompt`. */
const OPTION_WINDOW_LINES = 25;

/** How far above the first choice the question may sit — Codex lists details between them. */
const QUESTION_REACH_LINES = 12;

/** How far above the question a Claude dialog's rule and title may sit — an edit shows its diff there. */
const HEADER_REACH_LINES = 60;

/** One choice row: an optional cursor, a digit, a dot or paren, the label. */
const OPTION_ROW = /^(\s*[│|]?\s*)([>›❯»▌]\s*)?([1-9])[.)]\s+(\S.*)$/u;

/** An input line: the composer a harness shows when it is NOT asking anything. */
const COMPOSER = /^\s*[│|]?\s*[>›❯»](?:\s.*)?$/u;

/** The question shapes a tool permission is asked in. */
const QUESTION = /^(?:do you want to .+\?|would you like to .+\?|exit plan mode\?|allow command\?)$/iu;

/**
 * Dialogs with a question of the same shape that are NOT a tool permission: each has its own reading
 * in `pane.ts` and its own answer path, so it must never surface as an approval card.
 */
const NOT_A_TOOL_PERMISSION = ['do you want to use this api key'];

/** Claude's full-width rule above a dialog. */
const RULE = /^[─━]{20,}$/u;

/** A diff's dashed fence, which separates rows of the dialog and never says anything. */
const FENCE = /^[╌┄-]{20,}$/u;

/** The keyboard hint a harness prints after a label: `(y)`, `(p)`, `(a)`, `(esc)`, `(shift+tab)`. */
const KEY_HINT = /\s*\((?:[a-z]|esc|shift\+tab|tab)\)$/iu;

/** Codex marks its rows with a single-letter hint; Claude never does (both print `(esc)`). */
const CODEX_HINT = /\((?:y|p|a|n)\)$/u;

const LIMITS = { tool: 120, what: 500, detail: 300, question: 300, label: 300 } as const;

interface Row {
  readonly index: number;
  readonly number: number;
  readonly cursor: boolean;
  readonly column: number;
  label: string;
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** A line with any box-drawing gutter removed and its edges trimmed. */
const bare = (line: string): string =>
  line
    .replace(/^\s*[│|]\s?/u, '')
    .replace(/\s*[│|]\s*$/u, '')
    .trim();

/** The last run of numbered rows in the window, wrapped labels joined, or `undefined` when there is none. */
function choiceRows(lines: readonly string[], from: number): Row[] | undefined {
  let current: Row[] = [];
  let last: Row[] = [];
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const match = OPTION_ROW.exec(line);
    if (match !== null) {
      const column = (match[1] as string).length + (match[2] ?? '').length + 3;
      const row: Row = {
        index,
        number: Number(match[3]),
        cursor: match[2] !== undefined,
        column,
        label: (match[4] as string).trim(),
      };
      if (row.number === 1) current = [];
      current.push(row);
      last = current;
      continue;
    }
    const tail = current.at(-1);
    const indent = line.length - line.trimStart().length;
    if (tail !== undefined && line.trim() !== '' && indent >= tail.column) {
      tail.label = `${tail.label} ${line.trim()}`;
      continue;
    }
    current = [];
  }
  if (last.length < 2 || !last.every((row, position) => row.number === position + 1)) return undefined;
  // A harness draws its choice list IN PLACE of the composer. A composer line below the list means the
  // list is something the agent wrote — "Would you like to: 1. … 2. …" — and the agent is idle.
  const below = lines.slice((last.at(-1) as Row).index + 1);
  return below.some(line => COMPOSER.test(line)) ? undefined : last;
}

function optionKind(label: string): PermissionOptionKind {
  const lower = label.toLowerCase().replaceAll('’', "'");
  if (/^no\b/u.test(lower)) return 'deny';
  if (/^(?:yes|yes, proceed|proceed|allow|allow once)$/u.test(lower)) return 'allow';
  return /^yes\b/u.test(lower) ? 'allow-always' : 'allow';
}

/** FNV-1a over the text, twice with different offsets: sixteen hex digits, stable across runs. */
function digest(text: string): string {
  const half = (offset: number): string => {
    let hash = offset;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };
  return `${half(0x811c9dc5)}${half(0x050c5d1f)}`;
}

interface Subject {
  readonly tool: string;
  readonly action: PermissionAction;
  readonly what?: string | undefined;
  readonly detail?: string | undefined;
}

const after = (lines: readonly string[], prefix: RegExp): string | undefined => {
  for (const line of lines) {
    const match = prefix.exec(line);
    if (match !== null) return (match[1] as string).trim() || undefined;
  }
  return undefined;
};

/** What a Claude dialog is about, from its title and the rows between the title and the question. */
function claudeSubject(title: string | undefined, body: readonly string[], below: readonly string[]): Subject {
  switch (title?.toLowerCase()) {
    case 'bash command': {
      const command = body.slice(0, body.length > 1 ? -1 : undefined).join('\n');
      return {
        tool: 'Bash',
        action: 'run',
        what: command || undefined,
        detail: body.length > 1 ? body.at(-1) : undefined,
      };
    }
    case 'read file':
      return { tool: 'Read', action: 'read', what: body[0]?.replace(/^Read\((.*)\)$/u, '$1') };
    case 'edit file':
      return { tool: 'Edit', action: 'edit', what: body[0] };
    case 'create file':
      return { tool: 'Write', action: 'create', what: body[0] };
    case 'fetch':
      return { tool: 'WebFetch', action: 'fetch', what: /https?:\/\/[^\s"',]+/u.exec(body.join(' '))?.[0] };
    case 'tool use': {
      const call = body[0];
      const mcp = call?.endsWith('(MCP)') === true;
      const what = call?.replace(/\s*\(MCP\)$/u, '').replace(/:$/u, '');
      const described = body.length > 1 ? body.at(-1)?.replace(/^[│|]\s*/u, '') : undefined;
      return { tool: mcp ? 'MCP' : 'Tool', action: 'use', what: what || undefined, detail: described };
    }
    case 'exit plan mode?':
      return { tool: 'Plan', action: 'exit-plan', detail: below[0] };
    case undefined:
      return { tool: 'Tool', action: 'other', what: body[0] };
    default:
      return { tool: title as string, action: 'other', what: body[0] };
  }
}

/** What a Codex approval is about, from its question and the rows around it. */
function codexSubject(question: string, above: readonly string[], below: readonly string[]): Subject {
  const lower = question.toLowerCase();
  const reason = after(below, /^Reason:\s*(.*)$/u);
  if (lower.includes('run the following command'))
    return { tool: 'Shell', action: 'run', what: after(below, /^\$\s+(.*)$/u), detail: reason };
  if (lower.includes('make the following edits')) {
    const changed = after(above, /^•\s+(?:Added|Edited|Updated|Deleted|Modified)\s+(.+?)(?:\s+\(.*\))?$/u);
    return { tool: 'Edit', action: 'edit', what: after(below, /^Destination:\s*(.*)$/u) ?? changed, detail: reason };
  }
  if (lower.includes('grant these permissions')) return { tool: 'Permissions', action: 'other', detail: reason };
  return { tool: 'Codex', action: 'other', what: below[0], detail: reason };
}

/**
 * The permission prompt this frame is parked on, or `undefined` when it shows none.
 *
 * Everything a person decides on is in the result; `id` is a digest of exactly that, so a prompt that
 * changed on screen — another command, another file, other choices — is a different id.
 */
export function parsePermissionPrompt(pane: string): PermissionRequest | undefined {
  const lines = pane.replaceAll('\r\n', '\n').trimEnd().split('\n');
  const rows = choiceRows(lines, Math.max(0, lines.length - OPTION_WINDOW_LINES));
  if (rows === undefined) return undefined;
  const first = (rows[0] as Row).index;

  let questionAt = -1;
  for (let index = first - 1; index >= Math.max(0, first - QUESTION_REACH_LINES); index -= 1) {
    if (QUESTION.test(bare(lines[index] as string))) {
      questionAt = index;
      break;
    }
  }
  if (questionAt < 0) return undefined;
  const question = bare(lines[questionAt] as string);
  if (NOT_A_TOOL_PERMISSION.some(marker => question.toLowerCase().includes(marker))) return undefined;

  const harness: Harness = rows.some(row => CODEX_HINT.test(row.label)) ? 'codex' : 'claude';
  const meaningful = (line: string): boolean => {
    const text = bare(line);
    return text !== '' && !FENCE.test(text) && !text.startsWith('Tip:') && text !== 'This command requires approval';
  };
  const below = lines
    .slice(questionAt + 1, first)
    .filter(meaningful)
    .map(bare);

  let subject: Subject;
  if (harness === 'codex') {
    subject = codexSubject(question, lines.slice(Math.max(0, questionAt - 6), questionAt).map(bare), below);
  } else {
    let rule = -1;
    for (let index = questionAt; index >= Math.max(0, questionAt - HEADER_REACH_LINES); index -= 1) {
      if (RULE.test(bare(lines[index] as string))) {
        rule = index;
        break;
      }
    }
    // No rule in reach — a narrow or partly scrolled frame: the dialog is the block of rows that runs
    // unbroken up to the question.
    let top = rule + 1;
    if (rule < 0) {
      top = questionAt;
      while (top > 0 && top > questionAt - 8 && bare(lines[top - 1] as string) !== '') top -= 1;
    }
    const dialog = lines
      .slice(top, questionAt + 1)
      .filter(meaningful)
      .map(bare);
    // A lone question is no title — except the plan dialog's, whose title IS its question.
    const title = dialog[0] === question && question.toLowerCase() !== 'exit plan mode?' ? undefined : dialog[0];
    // The plan dialog's title IS its question, so nothing sits between them.
    const body = dialog.slice(1, title === question ? 1 : -1);
    subject = claudeSubject(title, body, below);
  }

  const options: PermissionOption[] = rows.map(row => {
    const label = clip(row.label.replace(KEY_HINT, '').trim(), LIMITS.label);
    return { number: row.number, label, kind: optionKind(label) };
  });
  const request = {
    harness,
    tool: clip(subject.tool, LIMITS.tool),
    action: subject.action,
    ...(subject.what === undefined ? {} : { what: clip(subject.what, LIMITS.what) }),
    ...(subject.detail === undefined ? {} : { detail: clip(subject.detail, LIMITS.detail) }),
    question: clip(question, LIMITS.question),
    options,
  };
  return {
    id: digest(JSON.stringify(request)),
    ...request,
    selected: rows.find(row => row.cursor)?.number ?? 1,
  };
}

/**
 * The keys that answer `request` with `answer`, exactly as a person at the keyboard would press them.
 *
 * A digit ALONE. Both harnesses act on the digit the moment it is pressed — measured on every version
 * the fixtures come from — so an Enter after it would land on whatever the harness drew next, and if
 * that is the next permission prompt, Enter would approve it unseen. A refusal is Escape: the
 * harness's own `(esc)`, which stops the tool and leaves the agent at its prompt.
 */
export function permissionAnswerKeys(
  request: PermissionRequest,
  answer: { readonly kind: 'choice'; readonly number: number } | { readonly kind: 'deny' },
): string | undefined {
  if (answer.kind === 'deny') return '\u001b';
  return request.options.some(option => option.number === answer.number) ? String(answer.number) : undefined;
}

/**
 * The permission prompt a frame is parked on, in one line — what a send that cannot land reports as
 * blocking it — or `undefined` when it shows none.
 */
export function paneBlockingPermission(pane: string): string | undefined {
  const request = parsePermissionPrompt(pane);
  if (request === undefined) return undefined;
  const about = request.what === undefined ? request.tool : `${request.tool} ${request.what.split('\n')[0]}`;
  return clip(`Permission prompt — ${about}: ${request.question}`, 200);
}
