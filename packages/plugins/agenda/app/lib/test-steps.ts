/**
 * HOW TO TEST, CUT INTO STEPS: a gate's checklist as the owner reads it before answering. Board draws the same
 * checklist on a card's page; the ask is Agenda's, so this half keeps its own copy of the parse rather than reaching
 * into Board.
 */

/** A run of consecutive steps, or a label/heading between runs. A step keeps the number it was written with. */
type TestBlock =
  | { readonly kind: 'steps'; readonly steps: readonly { readonly n: number; readonly text: string }[] }
  | { readonly kind: 'section'; readonly text: string };

/** How to test, as the owner reads it: an optional lead ("On the Mac, v4.157:"), then its blocks in order. */
export interface TestSteps {
  readonly lead: string | null;
  readonly blocks: readonly TestBlock[];
}

const LIST_ITEM = /^( {0,3}(?:(\d{1,9})[.)]|[-*+])\s+)(.*)$/u;
const FENCE = /^\s*(?:```|~~~)/u;
const HEADING = /^ {0,3}#{1,6}\s/u;

interface Draft {
  readonly kind: 'step' | 'section';
  readonly n: number;
  /** How far a step's own text is indented: its continuation lines lose this much. */
  readonly indent: number;
  readonly lines: string[];
}

const dedent = (line: string, indent: number): string => {
  const spaces = /^ */u.exec(line)?.[0].length ?? 0;
  return line.slice(Math.min(spaces, indent));
};

const blocksOf = (drafts: readonly Draft[]): readonly TestBlock[] => {
  const blocks: TestBlock[] = [];
  for (const draft of drafts) {
    const text = draft.lines.join('\n').trim();
    const last = blocks.at(-1);
    if (draft.kind === 'section') blocks.push({ kind: 'section', text });
    else if (last?.kind === 'steps')
      blocks[blocks.length - 1] = { kind: 'steps', steps: [...last.steps, { n: draft.n, text }] };
    else blocks.push({ kind: 'steps', steps: [{ n: draft.n, text }] });
  }
  return blocks;
};

/**
 * How to test split into steps when it is written as a list (numbered or bulleted), each step keeping its own
 * continuation lines (an indented code block, a second paragraph). Text before the first step is its lead; a heading,
 * or a paragraph set apart by a blank line, between steps is a section label. A run of numbered steps keeps the
 * number it starts at (a list that begins at 4 shows 4); bullets are counted on from the step before. `null` when
 * there is no list at all: then it is drawn whole, as Markdown, rather than cut up wrongly.
 */
export const testSteps = (text: string): TestSteps | null => {
  const lead: string[] = [];
  const drafts: Draft[] = [];
  let fence = false;
  let gap = false;
  let lastN = 0;
  let run = false;
  for (const line of text.trim().split('\n')) {
    const current = drafts.at(-1);
    const item = fence ? null : LIST_ITEM.exec(line);
    if (item !== null) {
      const written = item[2] === undefined ? null : Number(item[2]);
      const n = written !== null && !run ? written : lastN + 1;
      lastN = n;
      run = true;
      gap = false;
      drafts.push({ kind: 'step', indent: item[1]?.length ?? 0, lines: [item[3] ?? ''], n });
      continue;
    }
    const opens = FENCE.test(line);
    if (current === undefined) {
      lead.push(line);
      if (opens) fence = !fence;
      continue;
    }
    const blank = !fence && line.trim() === '';
    const indented = (/^ */u.exec(line)?.[0].length ?? 0) >= Math.min(current.indent, 2);
    const apart =
      !fence &&
      !blank &&
      (current.kind === 'step' ? !indented && (gap || HEADING.test(line)) : gap || HEADING.test(line));
    if (apart) {
      drafts.push({ kind: 'section', indent: 0, lines: [line], n: 0 });
      run = false;
    } else {
      current.lines.push(current.kind === 'step' ? dedent(line, current.indent) : line);
    }
    gap = blank;
    if (opens) fence = !fence;
  }
  if (!drafts.some(draft => draft.kind === 'step')) return null;
  const leadText = lead.join('\n').trim();
  return { lead: leadText === '' ? null : leadText, blocks: blocksOf(drafts) };
};
