import type { Harness, HarnessDialog, HarnessDialogKind, HarnessDialogOption } from '@ferretry/protocol';
import { parsePermissionPrompt, promptDigest } from './permission-prompt.ts';

/**
 * THE HARNESS'S OWN DIALOG A PANE IS PARKED ON, read off its visible frame as data.
 *
 * Apart from tool permissions (`./permission-prompt.ts`), both harnesses stop on screens of their own
 * and wait: Codex's "Hooks need review", "Update available" and sign-in screen, Claude's "New MCP
 * server found in this project" and "Settings Error". Read off real panes of Codex 0.145.0, 0.156.1 and
 * 0.163.0 and Claude Code 2.1.220 and 2.1.281 (`tests/fixtures/harness-dialogs/`), they share one shape:
 *
 *   a header block (title, then what it says) · a list of rows with a cursor on one · a key-hint footer
 *   ("enter confirm · esc skip", "Press enter to continue", "Enter to confirm · Esc to cancel")
 *
 * as the LAST thing on screen. Rows are read by where their label starts — the cursor row fixes the
 * column — because Claude 2.1.281 draws some lists without digits; a line indented to or past that
 * column under a numbered row is that row's description ("Pay for what you use").
 *
 * RECOGNITION IS STRICT where a false match costs something: the footer must be the frame's last
 * line and must name Enter or Esc, and a tool-permission prompt is never read as a dialog. A dialog
 * this module does not name is still read, as `other`, because a session parked on an unknown screen
 * must never sit there with nobody told.
 *
 * PURE AND TOTAL: a frame in, a dialog or `undefined` out.
 */

/** How far up from the bottom of the frame a dialog may reach. */
const WINDOW_LINES = 40;

/** How many lines a dialog's header may run to above its rows. */
const HEADER_LINES = 16;

/** One row: indent, an optional cursor, an optional digit, the label. */
const ROW = /^(\s*)(?:([>›❯»▌])\s*)?(?:([1-9])[.)]\s+)?(\S.*)$/u;

/** A key-hint footer: it names Enter or Esc, and what they do. */
const FOOTER =
  /^(?:press\s+)?(?:enter|esc|[a-z])\b.{0,90}\b(?:confirm|continue|select|skip|cancel|close|go back|review|exit)\b/iu;
const FOOTER_KEY = /\b(?:enter|esc)\b/iu;

/** The footer's word for Esc: `esc skip`, `esc to go back`, `Esc to cancel`. */
const ESCAPE_WORD = /\besc\s+(?:to\s+)?([a-z]+(?:\s+back)?)/iu;

/** Claude's full-width rule over a dialog. */
const RULE = /^\s*[─━]{20,}\s*$/u;

/** How far above the rows a rule may sit and still be the dialog's. */
const HEADER_REACH_LINES = 30;

/** Where a header block with no rule ends upward: a box's edge. */
const HEADER_EDGE = /^\s*[╭╰│]/u;

const LIMITS = { title: 300, body: 1200, label: 300, detail: 300 } as const;
const MAX_OPTIONS = 9;

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const blank = (line: string | undefined): boolean => line === undefined || line.trim() === '';

interface DialogRow {
  readonly index: number;
  readonly cursor: boolean;
  readonly label: string;
  detail?: string;
}

interface Row {
  readonly cursor: boolean;
  readonly digit: boolean;
  /** The column the label starts at. */
  readonly column: number;
  readonly label: string;
}

function rowOf(line: string): Row | undefined {
  const match = ROW.exec(line);
  if (match === null) return undefined;
  const label = match[4] as string;
  return {
    cursor: match[2] !== undefined,
    digit: match[3] !== undefined,
    column: line.length - label.length,
    label: label.trim(),
  };
}

/**
 * The rows above the footer: found from the cursor row outwards, every row starting its label at the
 * cursor row's column. Blank lines may separate rows (Codex's sign-in screen) but not end the list.
 */
function dialogRows(
  lines: readonly string[],
  from: number,
  footer: number,
): { rows: DialogRow[]; top: number } | undefined {
  let cursorAt = -1;
  for (let index = footer - 1; index >= from; index -= 1) {
    if (rowOf(lines[index] as string)?.cursor === true) {
      cursorAt = index;
      break;
    }
  }
  if (cursorAt < 0) return undefined;
  const anchor = rowOf(lines[cursorAt] as string) as Row;
  const numbered = anchor.digit;
  const kindOf = (line: string): 'row' | 'detail' | 'blank' | 'other' => {
    if (blank(line)) return 'blank';
    const row = rowOf(line) as Row;
    if (numbered ? row.digit && row.column === anchor.column : row.column === anchor.column && !row.digit) return 'row';
    const indent = line.length - line.trimStart().length;
    return indent >= anchor.column + (numbered ? 0 : 1) ? 'detail' : 'other';
  };
  // Everything between the cursor row and the footer belongs to the list.
  for (let index = cursorAt + 1; index < footer; index += 1)
    if (kindOf(lines[index] as string) === 'other') return undefined;
  // Upwards: rows and their details, across single blank lines, until anything else.
  let top = cursorAt;
  for (let index = cursorAt - 1; index >= from; index -= 1) {
    const kind = kindOf(lines[index] as string);
    if (kind === 'other') break;
    if (kind === 'row') top = index;
  }
  const rows: DialogRow[] = [];
  for (let index = top; index < footer; index += 1) {
    const line = lines[index] as string;
    const kind = kindOf(line);
    if (kind === 'row') {
      const row = rowOf(line) as Row;
      rows.push({ index, cursor: row.cursor, label: row.label });
    } else if (kind === 'detail') {
      const last = rows.at(-1) as DialogRow;
      last.detail = last.detail === undefined ? line.trim() : `${last.detail} ${line.trim()}`;
    }
  }
  if (rows.length > MAX_OPTIONS) return undefined;
  return { rows, top };
}

/**
 * The header above `top`. Under a full-width rule — Claude draws one over every dialog — it is every
 * line between the rule and the rows, blank runs and all ("Settings Error" spaces its paragraphs out).
 * With no rule in reach, it runs up to a box's edge or two blank lines in a row.
 */
function headerAbove(lines: readonly string[], from: number, top: number): string[] {
  for (let index = top - 1; index >= Math.max(from, top - HEADER_REACH_LINES); index -= 1) {
    const line = lines[index] as string;
    if (RULE.test(line))
      return lines
        .slice(index + 1, top)
        .filter(text => !blank(text))
        .slice(0, HEADER_LINES)
        .map(text => text.trim());
    if (HEADER_EDGE.test(line)) break;
  }
  let index = top - 1;
  while (index >= from && blank(lines[index])) index -= 1;
  const header: string[] = [];
  let blanks = 0;
  for (; index >= from && header.length < HEADER_LINES; index -= 1) {
    const line = lines[index] as string;
    if (HEADER_EDGE.test(line)) break;
    if (blank(line)) {
      blanks += 1;
      if (blanks >= 2) break;
      continue;
    }
    blanks = 0;
    header.unshift(line.trim());
  }
  return header;
}

/** Claude's "You've hit your org's monthly spend limit" notice, which sits above the dialog's rule. */
const LIMIT_NOTICE = /^you['’]ve hit your\b.*\blimit\b/iu;

/** How far above the rows the notice may sit. */
const NOTICE_REACH_LINES = 14;

/**
 * Claude's `/rate-limit-options` dialog is recognised by its ROWS: its title ("What do you want to do?")
 * is generic, but no other dialog offers to wait for a limit to reset or to ask an admin for more usage.
 */
function isUsageLimitDialog(rows: readonly DialogRow[]): boolean {
  return (
    rows.some(row => /\bwait for (?:the )?limit to reset\b/iu.test(row.label)) &&
    rows.some(row => /\bask your admin\b|\bwait here, then continue\b/iu.test(row.label))
  );
}

/** The "You've hit your … limit" notice above the dialog, wrapped lines joined, or `undefined`. */
function limitNotice(lines: readonly string[], top: number): string | undefined {
  for (let index = top - 1; index >= Math.max(0, top - NOTICE_REACH_LINES); index -= 1) {
    const text = (lines[index] as string).replace(/^\s*⎿\s*/u, '').trim();
    if (!LIMIT_NOTICE.test(text)) continue;
    const parts = [text];
    for (let next = index + 1; next < top && !blank(lines[next]) && !RULE.test(lines[next] as string); next += 1)
      parts.push((lines[next] as string).trim());
    return parts.join(' ');
  }
  return undefined;
}

/** Which dialog a header shows, and the line that is its title. */
const KINDS: readonly { readonly kind: HarnessDialogKind; readonly marker: RegExp }[] = [
  { kind: 'hooks-review', marker: /^hooks need review$/iu },
  { kind: 'update', marker: /update available/iu },
  { kind: 'sign-in', marker: /^welcome to codex\b/iu },
  { kind: 'usage-limit', marker: /^usage limit reached$/iu },
  { kind: 'mcp-servers', marker: /^new mcp servers? found\b/iu },
  { kind: 'settings-error', marker: /^settings error$/iu },
  // Codex from 0.156 titles its folder screens "Folder access": the trust question, and the restricted
  // opening of a folder its config marks untrusted.
  {
    kind: 'directory-trust',
    marker: /do you trust the contents of this directory|quick safety check|do you trust the files|^folder access$/iu,
  },
];

/** Whether choosing `label` in a `kind` dialog trusts something to run. */
function grantsTrust(kind: HarnessDialogKind, label: string): boolean {
  const lower = label.toLowerCase().replaceAll('’', "'");
  if (kind === 'mcp-servers') return lower.startsWith('use this');
  if (kind === 'directory-trust') return /^(?:yes|trust and continue)\b/u.test(lower);
  // Every other dialog: a row that says it trusts, unless it says it does not.
  return /\btrust/u.test(lower) && !/\bwithout\b|\bnot\b|n't\b|^no\b/u.test(lower);
}

/** Codex marks its cursor `›` or `>`; Claude `❯`. */
const harnessOf = (cursorLine: string): Harness => (cursorLine.includes('❯') ? 'claude' : 'codex');

/** Codex's hook list, which "Review hooks" opens: a table, not a choice list. Esc closes it. */
function hooksList(lines: readonly string[], footer: string): HarnessDialog | undefined {
  if (!/\besc close\b/iu.test(footer)) return undefined;
  const at = lines.findIndex(
    (line, index) => line.trim() === 'Hooks' && /^lifecycle hooks from config/iu.test(lines[index + 1]?.trim() ?? ''),
  );
  if (at < 0) return undefined;
  const warning = lines.slice(at + 2, at + 6).find(line => /hooks? needs? review/iu.test(line));
  const dialog = {
    harness: 'codex' as const,
    kind: 'hooks-list' as const,
    title: 'Hooks',
    ...(warning === undefined ? {} : { body: clip(warning.trim(), LIMITS.body) }),
    options: [],
    escape: 'close',
  };
  return { id: promptDigest(JSON.stringify(dialog)), ...dialog };
}

/**
 * The harness dialog this frame is parked on, or `undefined` when it shows none.
 *
 * Everything a person decides on is in the result; `id` is a digest of exactly that — not of where
 * the cursor is — so moving the cursor keeps the dialog, and another dialog is another id.
 */
export function parseHarnessDialog(pane: string): HarnessDialog | undefined {
  const all = pane.replaceAll('\r\n', '\n').trimEnd().split('\n');
  const from = Math.max(0, all.length - WINDOW_LINES);
  const lines = all.slice(from);
  const footerAt = lines.length - 1;
  const footer = (lines[footerAt] as string).trim();
  if (!FOOTER.test(footer) || !FOOTER_KEY.test(footer)) return undefined;
  if (parsePermissionPrompt(pane) !== undefined) return undefined;
  const list = hooksList(lines, footer);
  if (list !== undefined) return list;

  const found = dialogRows(lines, 0, footerAt);
  if (found === undefined) return undefined;
  const header = headerAbove(lines, 0, found.top);
  if (header.length === 0) return undefined;
  const known = KINDS.map(({ kind, marker }) => ({ kind, at: header.findIndex(line => marker.test(line)) })).find(
    ({ at }) => at >= 0,
  );
  const usageLimit = known === undefined && isUsageLimitDialog(found.rows);
  const kind = usageLimit ? 'usage-limit' : (known?.kind ?? 'other');
  const titleAt = known?.at ?? 0;
  const notice = usageLimit ? limitNotice(lines, found.top) : undefined;
  const body = [...(notice === undefined ? [] : [notice]), ...header.slice(titleAt + 1)].join('\n').trim();
  const escapeWord = ESCAPE_WORD.exec(footer)?.[1]?.toLowerCase();
  const options: HarnessDialogOption[] = found.rows.map((row, index) => {
    const label = clip(row.label, LIMITS.label);
    return {
      number: index + 1,
      label,
      ...(row.detail === undefined ? {} : { detail: clip(row.detail, LIMITS.detail) }),
      grantsTrust: grantsTrust(kind, label),
    };
  });
  const cursor = found.rows.find(row => row.cursor) as DialogRow;
  const dialog = {
    harness: harnessOf(lines[cursor.index] as string),
    kind,
    title: clip(header[titleAt] as string, LIMITS.title),
    ...(body === '' ? {} : { body: clip(body, LIMITS.body) }),
    options,
    ...(escapeWord === undefined ? {} : { escape: escapeWord }),
  };
  return {
    id: promptDigest(JSON.stringify(dialog)),
    ...dialog,
    selected: found.rows.indexOf(cursor) + 1,
  };
}

/** The bytes a terminal sends for the keys an answer presses. */
export const DIALOG_KEYS = { up: '\u001b[A', down: '\u001b[B', enter: '\r', escape: '\u001b' } as const;

/**
 * The cursor moves that put `dialog`'s cursor on option `number`, or `undefined` when it has no such
 * option. Empty when the cursor is already there.
 *
 * ARROWS, NEVER THE DIGIT. Codex's hook review moves the cursor on a digit and waits for Enter; its
 * update prompt acts on the digit at once; Claude 2.1.281 draws some lists with no digits at all —
 * all measured on the fixtures' versions. Arrows then Enter mean the same thing on every one of them,
 * and the caller confirms the cursor landed before it presses Enter.
 */
export function dialogCursorMoves(dialog: HarnessDialog, number: number): string | undefined {
  if (dialog.selected === undefined || !dialog.options.some(option => option.number === number)) return undefined;
  const distance = number - dialog.selected;
  return (distance > 0 ? DIALOG_KEYS.down : DIALOG_KEYS.up).repeat(Math.abs(distance));
}

/**
 * The harness dialog a frame is parked on, in one line — what a send that cannot land reports as
 * blocking it — or `undefined` when it shows none.
 */
export function paneBlockingDialog(pane: string): string | undefined {
  const dialog = parseHarnessDialog(pane);
  return dialog === undefined ? undefined : clip(`Harness dialog — ${dialog.title}`, 200);
}
