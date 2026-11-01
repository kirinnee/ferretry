/**
 * An option's label as plain words. A ferret sometimes writes Markdown into a label ("**Send now**"); anywhere the
 * label is drawn as text rather than parsed (a button, a name, a tooltip) that would show the marks themselves.
 * Only the label's DISPLAY goes through this; the label stays as written wherever it identifies the answer. Pure.
 */

const BOUNDARY = String.raw`(?<![\p{L}\p{N}])`;
const BOUNDARY_AFTER = String.raw`(?![\p{L}\p{N}])`;

const LINK = /!?\[([^\]]*)\]\([^)]*\)/gu;
const STRONG = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/gu;
const EMPHASIS_STAR = /\*(?=\S)([^*]+?)(?<=\S)\*/gu;
const EMPHASIS_UNDERSCORE = new RegExp(`${BOUNDARY}_(?=\\S)([^_]+?)(?<=\\S)_${BOUNDARY_AFTER}`, 'gu');
const CODE = /`([^`]*)`/gu;
const STRIKE = /~~(?=\S)(.+?)(?<=\S)~~/gu;

const SEPARATOR = String.raw`[:.)\-–—]`;

/** The label less its own key letter ("B Wait" under B → "Wait"), when it repeats the letter drawn beside it. */
const withoutOwnLetter = (plain: string, letter: string): string => {
  const own = new RegExp(`^${letter}(?:\\s*${SEPARATOR}\\s*|\\s+(?![\\p{Ll}]))(?=\\S)`, 'u');
  const rest = plain.replace(own, '');
  return rest === plain || rest === '' ? plain : rest;
};

export const plainLabel = (label: string, letter?: string): string => {
  const plain = label
    .replaceAll(LINK, '$1')
    .replaceAll(CODE, '$1')
    .replaceAll(STRONG, '$2')
    .replaceAll(STRIKE, '$1')
    .replaceAll(EMPHASIS_STAR, '$1')
    .replaceAll(EMPHASIS_UNDERSCORE, '$1')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  if (plain === '') return label;
  return letter === undefined ? plain : withoutOwnLetter(plain, letter);
};
