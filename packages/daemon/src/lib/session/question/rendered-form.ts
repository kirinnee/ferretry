import type { PendingQuestion } from '@ferretry/protocol';

/**
 * Reading a harness's native question form off a captured pane.
 *
 * The answer driver types into whatever this file says is on screen, so it is pure and it refuses to
 * guess. Every shape below was captured from a real pane (fixtures `tests/fixtures/question-forms/`):
 *
 *   Claude Code 2.1.281   `❯ 1. Label` rows with the description indented beneath; a single question
 *                          is drawn with a `│` gutter on every wrapped line of its text; the free-form
 *                          row is `Type something.` and is its own text field; a multi-select row is
 *                          `[ ] Label`, Enter TOGGLES it, and a separate unnumbered `Submit` row ends
 *                          the page; a multi-select or multi-question form ends on a "Review your
 *                          answers" page whose `Submit answers` row must be chosen as well.
 *   Codex 0.156.1          `› 1. Label  description` — two columns flattened onto one line; a
 *                          `Question 1/2` header; the free-form row is `None of the above` and takes
 *                          its text as a note opened with Tab.
 *
 * WHY THE SCROLLBACK IS READ AS WELL AS THE SCREEN. A form taller than the pane pushes its own header —
 * the question text — off the top of the screen, while its rows and cursor stay at the bottom. The rows
 * are bound ONLY on the visible screen, because a form that has closed leaves its rows in the scrollback
 * and a stale row must never be mistaken for a live one; the question text is searched for upward from
 * those rows, through the scrollback if it has to be, but never past the form's own top border.
 */

export type RenderedQuestion = PendingQuestion['questions'][number];

/**
 * How the harness takes free-form text, read off the row it rendered for it.
 *
 * `inline`: the row is itself a text field (Claude) — paste on it, then Enter.
 * `notes`: Tab opens a note under the row (Codex) — Tab, paste, then Enter.
 * `page`: Enter opens a separate free-form page that is bound again before the text is pasted.
 */
type FreeFormEntry = 'inline' | 'notes' | 'page';

/** The label a free-form answer is driven as, whatever the harness calls its row. */
export const FREE_FORM_LABEL = 'Other';

export interface BoundQuestionForm {
  /** Every navigable row, in Up/Down order; the free-form row is named {@link FREE_FORM_LABEL}. */
  readonly labels: readonly string[];
  /** Whether each row's multi-select box is ticked; `false` for a row without one. */
  readonly checked: readonly boolean[];
  /** The navigation index the cursor is on, or `undefined` when no bound row carries it. */
  readonly cursor: number | undefined;
  readonly freeForm?: { readonly index: number; readonly entry: FreeFormEntry };
  /** The navigation index of a separate Submit row that ends a multi-select page. */
  readonly submit?: number;
}

export interface ReviewPage {
  /** The navigation index of the cursor, or `undefined` when it is not on a bound row. */
  readonly cursor: number | undefined;
  /** The navigation index of the row that submits the reviewed answers. */
  readonly submit: number;
}

/** The pane as the binder reads it: scrollback above the screen, and where the screen begins. */
export interface QuestionScreen {
  readonly lines: readonly string[];
  readonly visibleFrom: number;
}

interface Row {
  readonly line: number;
  readonly cursor: boolean;
  readonly checked: boolean | undefined;
  readonly text: string;
  /** Lines under the row that belong to it (a wrapped label, then its description). */
  readonly continuation: readonly string[];
}

interface Block {
  readonly rows: readonly Row[];
  readonly submit?: { readonly line: number; readonly cursor: boolean };
  /** The lines between the form's top border and its first row: where its question is drawn. */
  readonly header: readonly string[];
}

const CURSOR = '[❯›>➜▶]';
/** `❯ 1. Label`, `  2. Label`, `  › 1. Label  description`: at most four columns before the number. */
const NUMBERED_ROW = new RegExp(
  `^(?<lead> *)(?<cursor>${CURSOR} ?)?(?<pad> *)(?<number>\\d{1,2})\\.\\s+(?<rest>.*)$`,
  'u',
);
const SUBMIT_ROW = new RegExp(`^\\s*(?<cursor>${CURSOR})?\\s*Submit\\s*$`, 'u');
const CHECKBOX = /^\[(?<mark>.)\]\s+/u;
/** A full-width horizontal rule: the border Claude draws above and inside a form. */
const RULE = /^\s*[─━═]{8,}\s*$/u;
/** Codex's header, `Question 1/2 (2 unanswered)`, which is where its form begins. */
const CODEX_HEADER = /^\s*Question \d+\/\d+\b/u;
/** The gutter a harness draws beside a quoted question, which is not part of its text. */
const GUTTER = /^\s*[│┃▏▎▍]\s?/u;
/** How far above its rows a form's header may be searched for, scrollback included. */
const HEADER_REACH = 200;

const FREE_FORM_ROWS: readonly { readonly pattern: RegExp; readonly entry: FreeFormEntry }[] = [
  { pattern: /^type something\.?$/iu, entry: 'inline' },
  { pattern: /^none of the above$/iu, entry: 'notes' },
  { pattern: /^other(?:…|\.\.\.)?$/iu, entry: 'page' },
];

const compact = (value: string): string => value.replace(/\s+/gu, ' ').trim();
/** Whitespace-free, so a wrap at any column — even inside a word — compares equal to the source. */
const dense = (value: string): string => value.replace(/\s+/gu, '');

function lines(text: string): string[] {
  const split = text.split('\n');
  if (split.at(-1) === '') split.pop();
  return split;
}

/**
 * The scrollback above the screen, then the screen.
 *
 * `history` is a capture of the whole pane (`capture-pane -S -`), which ENDS with the visible screen; only
 * the part above it is new. Two captures are not one instant, so a history that does not end the way the
 * screen does contributes nothing rather than lines that might be out of order.
 */
export function questionScreen(visible: string, history: string): QuestionScreen {
  const screen = lines(visible);
  const all = lines(history);
  const above = all.length > screen.length ? all.slice(0, all.length - screen.length) : [];
  const tail = all.slice(above.length);
  const aligned = tail.length === screen.length && tail.every((line, index) => line === screen[index]);
  const scrollback = aligned ? above : [];
  return { lines: [...scrollback, ...screen], visibleFrom: scrollback.length };
}

function numbered(line: string): Omit<Row, 'continuation' | 'line'> & { readonly number: number } {
  const match = NUMBERED_ROW.exec(line);
  const groups = match?.groups;
  if (groups === undefined) return { number: 0, cursor: false, checked: undefined, text: '' };
  const lead = (groups.lead ?? '').length + (groups.cursor ?? '').length + (groups.pad ?? '').length;
  if (lead > 4) return { number: 0, cursor: false, checked: undefined, text: '' };
  const rest = groups.rest ?? '';
  const box = CHECKBOX.exec(rest);
  const label = box === null ? rest : rest.slice(box[0].length);
  return {
    number: Number(groups.number),
    cursor: groups.cursor !== undefined,
    checked: box === null ? undefined : (box.groups?.mark ?? ' ') !== ' ',
    // Codex flattens its two columns onto one line; only the first is the label.
    text: compact(label.split(/\s{2,}/u)[0] ?? ''),
  };
}

/**
 * The LAST run of rows numbered 1, 2, 3… whose rows all lie on the visible screen.
 *
 * A rule ends a run (Claude's `Chat about this` sits below one and is not an answer), and so does a
 * number out of sequence. The last run is the live form: whatever a transcript printed above it —
 * including a prompt that quoted the very same options — came earlier.
 */
function lastBlock(screen: QuestionScreen): Block | undefined {
  let found: Block | undefined;
  let rows: Row[] = [];
  let submit: Block['submit'];
  let open = false;
  const close = (): void => {
    if (rows.length > 0 && (rows[0]?.line ?? -1) >= screen.visibleFrom)
      found = { rows, ...(submit === undefined ? {} : { submit }), header: headerAbove(screen, rows[0]?.line ?? 0) };
    rows = [];
    submit = undefined;
    open = false;
  };
  for (let index = 0; index < screen.lines.length; index++) {
    const line = screen.lines[index] ?? '';
    const row = numbered(line);
    if (row.number === 1) {
      close();
      open = true;
    }
    if (open && row.number === rows.length + 1 && submit === undefined) {
      rows.push({ line: index, cursor: row.cursor, checked: row.checked, text: row.text, continuation: [] });
      continue;
    }
    if (!open) continue;
    if (row.number > 0 || RULE.test(line)) {
      close();
      continue;
    }
    const submitRow = SUBMIT_ROW.exec(line);
    if (submitRow !== null && submit === undefined) {
      submit = { line: index, cursor: submitRow.groups?.cursor !== undefined };
      continue;
    }
    const last = rows.at(-1);
    if (last !== undefined && submit === undefined && line.trim() !== '')
      rows[rows.length - 1] = { ...last, continuation: [...last.continuation, line] };
  }
  close();
  return found;
}

/** The lines between a form's first row and its top border (a rule, or Codex's `Question n/m`). */
function headerAbove(screen: QuestionScreen, first: number): readonly string[] {
  const header: string[] = [];
  for (let index = first - 1; index >= Math.max(0, first - HEADER_REACH); index--) {
    const line = screen.lines[index] ?? '';
    if (RULE.test(line)) break;
    header.unshift(line);
    if (CODEX_HEADER.test(line)) break;
  }
  return header;
}

function shows(header: readonly string[], text: string): boolean {
  const wanted = dense(text);
  return wanted !== '' && dense(header.map(line => line.replace(GUTTER, '')).join('\n')).includes(wanted);
}

/** Whether a row is this label: its first line, or its first line joined to a wrapped remainder. */
function rowIs(row: Row, label: string): boolean {
  const wanted = dense(label);
  let text = dense(row.text);
  if (text === wanted) return true;
  for (const line of row.continuation.slice(0, 2)) {
    text += dense(line);
    if (text === wanted) return true;
    if (!wanted.startsWith(text)) return false;
  }
  return false;
}

/**
 * The exact pending question, positively bound on the pane — or `undefined`.
 *
 * Bound means: the question's text is drawn in the header of the live form, and EVERY option the
 * transcript recorded is one of its rows. A free-form row is recognised by name and offered as
 * {@link FREE_FORM_LABEL}; any other row the transcript does not name keeps its own text, so it can
 * never be chosen by accident.
 */
export function bindQuestionForm(screen: QuestionScreen, question: RenderedQuestion): BoundQuestionForm | undefined {
  const block = lastBlock(screen);
  if (block === undefined || !shows(block.header, question.question)) return undefined;
  const options = question.options?.map(option => compact(option.label)) ?? [];
  if (options.length === 0) return undefined;
  const labels: string[] = [];
  let freeForm: BoundQuestionForm['freeForm'];
  for (const [index, row] of block.rows.entries()) {
    const option = options.find(label => label !== FREE_FORM_LABEL && rowIs(row, label));
    const entry = FREE_FORM_ROWS.find(candidate => candidate.pattern.test(row.text))?.entry;
    if (option !== undefined) labels.push(option);
    else if (entry !== undefined && freeForm === undefined) {
      labels.push(FREE_FORM_LABEL);
      freeForm = { index, entry };
    } else labels.push(row.text);
  }
  if (!options.every(label => labels.includes(label))) return undefined;
  const submit = block.submit === undefined ? undefined : block.rows.length;
  const onRow = block.rows.findIndex(row => row.cursor);
  return {
    labels,
    checked: block.rows.map(row => row.checked === true),
    cursor: onRow >= 0 ? onRow : block.submit?.cursor === true ? submit : undefined,
    ...(freeForm === undefined ? {} : { freeForm }),
    ...(submit === undefined ? {} : { submit }),
  };
}

/**
 * Claude's closing "Review your answers" page for exactly these questions, or `undefined`.
 *
 * Bound only when the page names every one of the questions and offers `Submit answers` as a row —
 * choosing it is the one key that finishes a form, so it is never pressed on a page that merely looks
 * similar.
 */
export function bindReviewPage(screen: QuestionScreen, questions: readonly RenderedQuestion[]): ReviewPage | undefined {
  const block = lastBlock(screen);
  if (block === undefined || !block.header.some(line => /review your answers/iu.test(line))) return undefined;
  if (!questions.every(question => shows(block.header, question.question))) return undefined;
  const submit = block.rows.findIndex(row => /^submit answers$/iu.test(row.text));
  if (submit < 0) return undefined;
  const cursor = block.rows.findIndex(row => row.cursor);
  return { cursor: cursor >= 0 ? cursor : undefined, submit };
}

/** Whether the question's text is drawn anywhere on the screen, for a free-form page opened by Enter. */
export function screenShowsQuestion(screen: QuestionScreen, question: string): boolean {
  return shows(screen.lines.slice(screen.visibleFrom), question);
}
