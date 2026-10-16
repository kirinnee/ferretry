/**
 * THE NOTION-STYLE EDITING RULES, as pure text transforms over the draft.
 *
 * The composer stays a plain textarea holding plain markdown — what is sent is exactly what was typed —
 * and these rules only decide what a key does to that text:
 *
 *   ↵ inside a list continues it      `- a` ↵ → `- a\n- `, `3. c` ↵ → `3. c\n4. `, `[ ] x` ↵ → `… \n[ ] `
 *   ↵ on an empty list item ends it   `- ` ↵ → `` (the marker is removed, the list is over)
 *   ↵ inside a ``` code block         a new line, never a send
 *   ⌘B / ⌘I / ⌘E                      wrap the selection in `**` / `*` / `` ` `` (or unwrap it)
 *
 * Every function answers `null` when its rule does not apply, so the caller falls through to the
 * reader's configured Enter behaviour unchanged.
 */

export interface DraftEdit {
  readonly value: string;
  /** Where the caret goes once the edit is applied. */
  readonly caret: number;
}

/** `- `, `* `, `1. `, `- [ ] `, `[ ] ` and their indented forms, with the text after them. */
const LIST_ITEM = /^(\s*)(?:([-*])\s(\[[ xX]\]\s)?|(\d+)\.\s|(\[[ xX]\])\s)(.*)$/u;

const lineAround = (value: string, caret: number): { readonly start: number; readonly text: string } => {
  const start = value.lastIndexOf('\n', caret - 1) + 1;
  const end = value.indexOf('\n', caret);
  return { start, text: value.slice(start, end === -1 ? value.length : end) };
};

/** Is the caret inside an unclosed ``` fence? */
export const insideCodeBlock = (value: string, caret: number): boolean =>
  (value.slice(0, caret).match(/^\s*```/gmu)?.length ?? 0) % 2 === 1;

/** What ↵ does at a list item, or `null` when the caret is not at the end of one. */
export const continueList = (value: string, caret: number): DraftEdit | null => {
  const line = lineAround(value, caret);
  if (caret !== line.start + line.text.length) return null;
  const match = LIST_ITEM.exec(line.text);
  if (match === null) return null;
  const [, indent = '', bullet, bulletBox, number, box, rest = ''] = match;
  if (rest.trim() === '') {
    // An empty item ends the list: the marker goes, the line stays.
    const value2 = value.slice(0, line.start) + value.slice(caret);
    return { value: value2, caret: line.start };
  }
  const marker =
    number !== undefined
      ? `${Number(number) + 1}. `
      : box !== undefined
        ? '[ ] '
        : `${bullet as string} ${bulletBox === undefined ? '' : '[ ] '}`;
  const insert = `\n${indent}${marker}`;
  return { value: value.slice(0, caret) + insert + value.slice(caret), caret: caret + insert.length };
};

/** ⌘B / ⌘I / ⌘E: wrap the selection in a marker, or take the marker off when it is already wrapped. */
export const toggleWrap = (value: string, start: number, end: number, marker: string): DraftEdit => {
  const before = value.slice(Math.max(0, start - marker.length), start);
  const after = value.slice(end, end + marker.length);
  if (before === marker && after === marker)
    return {
      value: value.slice(0, start - marker.length) + value.slice(start, end) + value.slice(end + marker.length),
      caret: end - marker.length,
    };
  return {
    value: value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end),
    caret: end + marker.length * (start === end ? 1 : 2),
  };
};

/** The marker a ⌘/Ctrl shortcut wraps with, or `null` for any other key. */
export const wrapMarkerFor = (key: string): string | null => {
  switch (key.toLowerCase()) {
    case 'b':
      return '**';
    case 'i':
      return '*';
    case 'e':
      return '`';
    default:
      return null;
  }
};
