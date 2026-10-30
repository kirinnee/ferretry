/**
 * WHEN A FERRET'S LAST WORDS ASK THE OWNER FOR SOMETHING (docs/attention.md).
 *
 * A ferret that needs the owner to DO or DECIDE something is meant to raise an Attention item; one
 * that only writes it into its closing message leaves the owner nothing to find on the board. The
 * daemon therefore reads a finished turn's final Markdown reply and asks one question — does this
 * ask the owner for something? — and, when it does and no item covers it, nudges the ferret.
 *
 * A false positive costs an agent a pointless nudge, so this reads only STRUCTURE the ferrets are
 * already told to write: an owner-facing heading (`## Waiting on you`), a `Next steps` list whose
 * items carry an owner label (`You:`), or a table that names the owner in a column. Prose never
 * counts, however much it sounds like a request. When in doubt, it returns nothing.
 *
 * Pure and total: a string in, a list out, no I/O, and every pattern is bounded so a hostile reply
 * cannot make it spin.
 */

/** At most this many asks are returned. */
export const MAX_OWNER_ASKS = 8;
/** Each ask is cut to this many characters (ending with '…' when cut). */
export const MAX_OWNER_ASK_LENGTH = 160;

/** `owner`: every item is for the owner. `mixed`: only items labelled for the owner are. */
type Kind = 'owner' | 'mixed';

const OWNER_HEADINGS: readonly string[] = [
  'waiting on you',
  'waiting for you',
  'what i need from you',
  'needed from you',
  'need from you',
  'for you',
  'action needed',
  'action required',
  'actions for you',
  'your turn',
  'your move',
  'you need to',
  'to do for you',
  'owner actions',
  'next steps for you',
];

const MIXED_HEADINGS: readonly string[] = [
  'next steps',
  'next step',
  'next',
  'to do',
  'todo',
  'follow-ups',
  'follow ups',
  'action items',
  "what's next",
  'what happens next',
];

const KIND_OF_HEADING: ReadonlyMap<string, Kind> = new Map([
  ...OWNER_HEADINGS.map((label): [string, Kind] => [label, 'owner']),
  ...MIXED_HEADINGS.map((label): [string, Kind] => [label, 'mixed']),
]);

const MARK = '(?:\\*\\*|__)?';

const headingPattern = (label: string): string => label.replace(/'/gu, "['’]").replace(/\s+/gu, '\\s+');

/** Longest first, so `next steps for you` is never read as `next steps`. */
const HEADING_ALTERNATIVES = [...KIND_OF_HEADING.keys()]
  .sort((a, b) => b.length - a.length)
  .map(headingPattern)
  .join('|');

/** `## Heading`, `**Heading**`, `Heading:` — optional `(you)`, then an optional inline remainder. */
const SECTION = new RegExp(
  `^(#{1,6}\\s+)?(\\*\\*|__)?\\s*(${HEADING_ALTERNATIVES})(\\s*\\(you\\))?\\s*(?:\\*\\*|__)?\\s*(:)?\\s*(?:\\*\\*|__)?\\s*(.*)$`,
  'iu',
);

const ANY_HEADING = /^\s{0,3}#{1,6}(?:\s|$)/u;

/** Each captures what is left after the label. */
const OWNER_LABELS: readonly RegExp[] = [
  new RegExp(`^${MARK}\\(you\\)${MARK}\\s*[:\\-–—]?\\s*${MARK}(.*)$`, 'iu'),
  new RegExp(`^${MARK}(?:you|owner)${MARK}\\s?:${MARK}(.*)$`, 'iu'),
  new RegExp(`^${MARK}you${MARK}\\s*[—–](.*)$`, 'iu'),
  new RegExp(`^${MARK}you${MARK}\\s+-(?:\\s+(.*))?$`, 'iu'),
  new RegExp(`^${MARK}(?:for you|your action)${MARK}\\s*:${MARK}(.*)$`, 'iu'),
  new RegExp(`^${MARK}you need to${MARK}(?:\\s+(.*))?$`, 'iu'),
];

const AGENT_LABELS: readonly RegExp[] = [
  new RegExp(`^${MARK}(?:me|i|claude|agent|ferret)${MARK}\\s*[:\\-–—]`, 'iu'),
  /^next\s*\(me\)/iu,
  /^i['’]ll\b/iu,
];

const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,3}[.)])(?:[ \t]+(.*))?$/u;
const CHECKBOX = /^\[[ xX]\]\s*/u;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/u;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;
const WHO_HEADER = /^(?:who|owner|by|actor|whose)$/u;
const OWNER_CELL = /^(?:you|owner|human|for you)$/u;
const NOTHING = /^(?:none|nothing|n\/a|nil|no action|no further action|no input)(?![\p{L}\p{N}])/iu;
const ONLY_DASHES = /^[-–—\s]*$/u;
const ATTENTION_ITEM_REFERENCE = /[!?]A\d+\b|attention item|agenda item/iu;

const NEXT_LINE_BREAK = /\r\n|\r|\n/u;

interface Block {
  readonly indent: number;
  readonly fromList: boolean;
}

/** The reply without its fenced code blocks, line by line. An unclosed fence swallows the rest. */
function withoutFences(markdown: string): readonly string[] {
  const kept: string[] = [];
  let open: { readonly char: string; readonly size: number } | undefined;
  for (const line of markdown.split(NEXT_LINE_BREAK)) {
    const fence = FENCE.exec(line);
    const marker = fence?.[1] ?? '';
    const info = fence?.[2] ?? '';
    if (open === undefined) {
      if (fence !== null && !(marker.startsWith('`') && info.includes('`'))) {
        open = { char: marker.charAt(0), size: marker.length };
      } else {
        kept.push(line);
      }
    } else if (fence !== null && marker.charAt(0) === open.char && marker.length >= open.size && info.trim() === '') {
      open = undefined;
    }
  }
  return kept;
}

function indentOf(leading: string): number {
  return leading.replace(/\t/gu, '    ').length;
}

function withoutCheckbox(text: string): string {
  return text.trim().replace(CHECKBOX, '');
}

/** What follows an owner label (empty for a bare label), or undefined when there is no owner label. */
function ownerLabel(text: string): string | undefined {
  const body = withoutCheckbox(text);
  for (const pattern of OWNER_LABELS) {
    const match = pattern.exec(body);
    if (match !== null) return match[1] ?? '';
  }
  return undefined;
}

function isAgentLabel(text: string): boolean {
  const body = withoutCheckbox(text);
  return AGENT_LABELS.some(pattern => pattern.test(body));
}

function stripEmphasis(text: string): string {
  let result = text;
  for (const marker of ['**', '__']) {
    const balanced = result.length >= marker.length * 2 && result.startsWith(marker) && result.endsWith(marker);
    if (balanced) {
      result = result.slice(marker.length, -marker.length);
    } else if ((result.split(marker).length - 1) % 2 === 1) {
      if (result.endsWith(marker)) result = result.slice(0, -marker.length);
      else if (result.startsWith(marker)) result = result.slice(marker.length);
    }
  }
  return result;
}

function clean(text: string): string {
  return stripEmphasis(withoutCheckbox(text).replace(/\s+/gu, ' ').trim()).replace(/\s+/gu, ' ').trim();
}

function isNothing(text: string): boolean {
  return ONLY_DASHES.test(text) || NOTHING.test(text);
}

function cut(text: string): string {
  const characters = [...text];
  return characters.length > MAX_OWNER_ASK_LENGTH ? `${characters.slice(0, MAX_OWNER_ASK_LENGTH - 1).join('')}…` : text;
}

/** The section a line opens, and whatever the line says after the heading itself. */
function sectionOf(line: string): { readonly kind: Kind; readonly rest: string } | undefined {
  const match = SECTION.exec(line);
  if (match === null) return undefined;
  const heading = match[1] !== undefined;
  const bold = match[2] !== undefined;
  const colon = match[5] !== undefined;
  const rest = (match[6] ?? '').trim();
  if (!colon && !((heading || bold) && rest === '')) return undefined;
  const label = (match[3] ?? '').toLowerCase().replace(/’/gu, "'").replace(/\s+/gu, ' ');
  const kind = match[4] !== undefined ? 'owner' : (KIND_OF_HEADING.get(label) ?? 'mixed');
  return { kind, rest };
}

function cellsOf(row: string): readonly string[] {
  const trimmed = row.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return trimmed.split('|').map(cell => cell.trim());
}

function isTableHeader(line: string, next: string | undefined): boolean {
  return (
    next !== undefined &&
    line.includes('|') &&
    !LIST_ITEM.test(line) &&
    next.includes('|') &&
    TABLE_DELIMITER.test(next)
  );
}

function plainCell(cell: string): string {
  return cell
    .replace(/[*_`]/gu, '')
    .replace(/[:?]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

/** What a cell says after an owner label (`You`, `**You:** x`); undefined when the cell is not one. */
function ownerCell(cell: string): string | undefined {
  if (OWNER_CELL.test(plainCell(cell))) return '';
  return ownerLabel(cell);
}

/** The ask each qualifying row makes, in order. */
function tableAsks(header: readonly string[], rows: readonly (readonly string[])[], section: Kind | undefined) {
  const asks: string[] = [];
  const whoColumn = header.findIndex(cell => WHO_HEADER.test(plainCell(cell)));
  for (const row of rows) {
    let cells: readonly string[];
    if (whoColumn >= 0) {
      if (ownerCell(row[whoColumn] ?? '') === undefined) continue;
      cells = row.filter((_, column) => column !== whoColumn);
    } else if (section === 'owner') {
      cells = row;
    } else if (section === 'mixed') {
      const first = ownerCell(row[0] ?? '');
      if (first === undefined) continue;
      cells = [first, ...row.slice(1)];
    } else {
      continue;
    }
    asks.push(
      cells
        .map(clean)
        .filter(cell => cell !== '')
        .join(' — '),
    );
  }
  return asks;
}

/** The owner-directed actions a reply asks for, in order, each once — empty when it asks for none. */
export function ownerAsks(markdown: string): readonly string[] {
  const lines = withoutFences(markdown);
  const asks: string[] = [];

  const add = (raw: string): void => {
    const text = clean(raw);
    if (text === '' || isNothing(text) || ATTENTION_ITEM_REFERENCE.test(text)) return;
    const ask = cut(text);
    if (asks.length < MAX_OWNER_ASKS && !asks.includes(ask)) asks.push(ask);
  };

  let section: Kind | undefined;
  let topIndent: number | undefined;
  let owned: Block | undefined;
  let blank = false;

  const open = (kind: Kind | undefined): void => {
    section = kind;
    topIndent = undefined;
    owned = undefined;
  };

  const sayInline = (rest: string, kind: Kind): void => {
    const item = LIST_ITEM.exec(rest);
    const body = withoutCheckbox(item === null ? rest : (item[2] ?? ''));
    if (isAgentLabel(body)) return;
    const label = ownerLabel(body);
    if (label === undefined) {
      if (kind === 'owner') add(body);
    } else if (clean(label) === '') {
      owned = { indent: 0, fromList: false };
    } else {
      add(label);
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      blank = true;
      continue;
    }
    const afterBlank = blank;
    blank = false;
    const text = line.trim();

    if (isTableHeader(line, lines[index + 1])) {
      const rows: string[][] = [];
      let end = index + 2;
      while (end < lines.length && (lines[end] ?? '').trim() !== '' && (lines[end] ?? '').includes('|')) {
        rows.push([...cellsOf(lines[end] ?? '')]);
        end++;
      }
      for (const ask of tableAsks(cellsOf(line), rows, section)) add(ask);
      index = end - 1;
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      const indent = indentOf(item[1] ?? '');
      const body = withoutCheckbox(item[2] ?? '');
      if (owned?.fromList && indent <= owned.indent) owned = undefined;
      if (isAgentLabel(body)) {
        owned = undefined;
        continue;
      }
      const label = ownerLabel(body);
      if (label !== undefined) {
        if (clean(label) === '') owned = { indent, fromList: true };
        else add(label);
        continue;
      }
      if (owned !== undefined) {
        add(body);
      } else if (section === 'owner' && (topIndent === undefined || indent <= topIndent)) {
        topIndent = indent;
        add(body);
      }
      continue;
    }

    const opened = sectionOf(text);
    if (opened !== undefined) {
      open(opened.kind);
      if (opened.rest !== '') sayInline(opened.rest, opened.kind);
      continue;
    }
    if (ANY_HEADING.test(line)) {
      open(undefined);
      continue;
    }

    if (isAgentLabel(text)) {
      open(undefined);
      continue;
    }
    const label = ownerLabel(text);
    if (label !== undefined) {
      if (clean(label) === '') owned = { indent: indentOf(/^[ \t]*/u.exec(line)?.[0] ?? ''), fromList: false };
      else {
        add(label);
        owned = undefined;
      }
      continue;
    }

    if (afterBlank) open(undefined);
  }

  return asks;
}
