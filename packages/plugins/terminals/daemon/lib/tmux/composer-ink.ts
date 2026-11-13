/**
 * Reading the INK of a composer: whether the glyphs after its prompt are dim or plain.
 *
 * Where the cursor sits cannot tell a ghost suggestion from a draft. Claude Code parks the cursor at
 * the first column over a suggested next prompt (`❯ go ahead with all three`) — and a person who typed
 * the same words and pressed Home parks it in exactly the same place, so a draft read as "nothing
 * typed" was typed onto. The harnesses draw the distinction themselves: every placeholder they show —
 * Claude's ghost suggestion, `Try "…"` and `Press up to edit queued messages`, Codex's `Ask Codex to do
 * anything` — is SGR 2 (dim), and typed text, a collapsed paste chip included, never is.
 *
 * Measured with `capture-pane -e` on Claude Code 2.1.281 and Codex 0.156.1 (fixtures `*-ink-*.ansi`):
 *
 *   * Dim is switched off by `22` or a reset, NOT by `39` — the queued placeholder is `\e[2m\e[39m…`.
 *   * A glyph in a combined parameter list (`\e[0;2m`) is dim too, and a `2` inside `38;2;r;g;b` is a
 *     colour channel, not the attribute.
 *   * Claude fakes a cursor on its placeholder by drawing the FIRST glyph in inverse video (`\e[7mT`),
 *     outside the dim run. That cell is the cursor, not ink, so inverse cells are not counted.
 *   * The prompt glyph itself (`❯` grey, Codex's `›` bold) and the spaces between words are never dim
 *     or plain evidence, so only non-blank glyphs after the prompt are read.
 *
 * A harness started without a colour terminal draws no SGR at all, so every glyph would read as plain
 * and a placeholder as input: a capture with no SGR in it says nothing about dimness. Nor does a capture
 * taken a repaint after the plain one that shows other text. `undefined` means "the ink cannot say",
 * and the caller falls back to the cursor.
 *
 * Every function here is pure; the adapter owns the second capture.
 */

/** `dim` — every glyph of the composer's text is dim. `plain` — at least one is not. */
export type ComposerInk = 'dim' | 'plain';

/** A control sequence: CSI (parameters, intermediates, final byte), OSC up to BEL or ST, or a two-byte escape. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point.
const SEQUENCE = /\u001b\[[0-9:;?<=>]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/uy;
/** `\e[…m`, parameters only: the one control sequence that changes ink. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point.
const SGR = /^\u001b\[([0-9:;]*)m$/u;
const PROMPT_GLYPH = /[>›❯»]/u;
const BORDER = /[│|]/u;

interface Style {
  dim: boolean;
  inverse: boolean;
}

interface Cell {
  readonly glyph: string;
  readonly dim: boolean;
  readonly inverse: boolean;
}

/** Applies one SGR parameter list. Colour parameters are consumed whole so their channels are not read as attributes. */
function applySgr(style: Style, parameters: string): void {
  const tokens = parameters === '' ? ['0'] : parameters.split(';');
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    // A colon form (`38:2::r:g:b`, `4:3`) carries its own sub-parameters in one token.
    if (token.includes(':')) continue;
    const code = token === '' ? 0 : Number(token);
    if (code === 0) {
      style.dim = false;
      style.inverse = false;
    } else if (code === 2) style.dim = true;
    else if (code === 22) style.dim = false;
    else if (code === 7) style.inverse = true;
    else if (code === 27) style.inverse = false;
    else if (code === 38 || code === 48 || code === 58) index += tokens[index + 1] === '5' ? 2 : 4;
  }
}

/** The cells of an attributed capture, one array per row, and whether any SGR was in it. */
function cellsOf(attributed: string): { readonly rows: readonly (readonly Cell[])[]; readonly styled: boolean } {
  const rows: Cell[][] = [[]];
  const style: Style = { dim: false, inverse: false };
  let styled = false;
  let index = 0;
  while (index < attributed.length) {
    if (attributed[index] === '\u001b') {
      SEQUENCE.lastIndex = index;
      const sequence = SEQUENCE.exec(attributed);
      if (sequence === null) {
        index += 1;
        continue;
      }
      const sgr = SGR.exec(sequence[0]);
      if (sgr !== null) {
        styled = true;
        applySgr(style, sgr[1] as string);
      }
      index += sequence[0].length;
      continue;
    }
    const glyph = String.fromCodePoint(attributed.codePointAt(index) as number);
    index += glyph.length;
    if (glyph === '\n') rows.push([]);
    else if (glyph !== '\r') (rows[rows.length - 1] as Cell[]).push({ glyph, dim: style.dim, inverse: style.inverse });
  }
  // A capture ends with a newline, which opens a row of nothing.
  if (rows.length > 1 && (rows[rows.length - 1] as Cell[]).length === 0) rows.pop();
  return { rows, styled };
}

const blank = (glyph: string): boolean => /^\s$/u.test(glyph);

function textOf(cells: readonly Cell[]): string {
  return cells
    .map(cell => cell.glyph)
    .join('')
    .replaceAll(' ', ' ')
    .trimEnd();
}

/**
 * The cells that are the composer's TEXT: past the box border and, on the first row, the prompt glyph.
 * Trailing blanks and a closing border are not text either.
 */
function contentOf(cells: readonly Cell[], first: boolean): readonly Cell[] {
  let start = 0;
  const skip = (matches: (glyph: string) => boolean): void => {
    while (start < cells.length && matches((cells[start] as Cell).glyph)) start += 1;
  };
  skip(glyph => blank(glyph) || BORDER.test(glyph));
  if (first && start < cells.length && PROMPT_GLYPH.test((cells[start] as Cell).glyph)) start += 1;
  let end = cells.length;
  while (end > start && (blank((cells[end - 1] as Cell).glyph) || BORDER.test((cells[end - 1] as Cell).glyph)))
    end -= 1;
  return cells.slice(start, end);
}

/**
 * The ink of the composer rows in `attributed` (a `capture-pane -e -p` of exactly those rows), or
 * `undefined` when it cannot be trusted to describe `plain`, the same rows from the plain capture.
 *
 * `plain` is the check that the two captures saw the same screen: a repaint between them would
 * otherwise label one frame's text with another frame's attributes. A composer with no non-blank,
 * non-cursor glyph has no ink to read.
 */
export function composerInk(attributed: string, plain: readonly string[]): ComposerInk | undefined {
  const { rows, styled } = cellsOf(attributed);
  if (!styled || rows.length !== plain.length) return undefined;
  const same = rows.every((cells, row) => textOf(cells) === (plain[row] as string).replaceAll(' ', ' ').trimEnd());
  if (!same) return undefined;
  let dim = 0;
  let solid = 0;
  rows.forEach((cells, row) => {
    for (const cell of contentOf(cells, row === 0)) {
      if (blank(cell.glyph) || cell.inverse) continue;
      if (cell.dim) dim += 1;
      else solid += 1;
    }
  });
  if (solid > 0) return 'plain';
  return dim > 0 ? 'dim' : undefined;
}
