import { AGENDA_PUSH_BODY_LENGTH, AGENDA_PUSH_TITLE_LENGTH } from '../../contract/index.ts';

/** The text on one line: runs of whitespace become one space. */
export function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim();
}

/** The text on one line, cut at a word to at most `limit` characters with an ellipsis (today's `clipAtWord`). */
export const clipAtWord = (text: string, limit: number): string => {
  const line = oneLine(text);
  if (line.length <= limit) return line;
  const room = line.slice(0, limit - 1);
  const space = room.lastIndexOf(' ');
  const cut = space >= Math.floor(limit / 2) ? room.slice(0, space) : room;
  return `${cut.trimEnd().replace(/[\s,;:.\-–—]+$/u, '')}…`;
};

/** What a new paired device's alert says. Access sends it; a ferret's words must never read as it. */
const DEVICE_PAIRED_TITLE = 'A new device was paired';
/** What an approve-on-phone push says. A ferret's words must never read as it. */
const PHONE_APPROVAL_TITLE = 'Approve on your phone';

/** Latin look-alikes an agent could spell the reserved alert title with, folded to the letter they mimic. */
const CONFUSABLE_LETTERS: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  і: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  ԁ: 'd',
  ԝ: 'w',
  α: 'a',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
};

/** The letters a reader sees, whatever script or accent spells them: `A nеw dévice!` becomes `anewdevice`. */
function letterSkeleton(text: string): string {
  return [...text.normalize('NFKD').toLowerCase()]
    .map(letter => CONFUSABLE_LETTERS[letter] ?? letter)
    .join('')
    .replaceAll(/[^a-z]/gu, '');
}

/**
 * What the reserved alerts say, as letters: a name that reads as "new device" or "paired" anywhere is not a ferret's to
 * put on a lock screen bare. Derived from the alerts' own titles, so the two cannot drift.
 */
const RESERVED_ALERT_SKELETONS = [
  letterSkeleton(DEVICE_PAIRED_TITLE.split(' ').slice(1, 3).join(' ')),
  letterSkeleton(DEVICE_PAIRED_TITLE.split(' ').at(-1) ?? ''),
  // A ferret's own push must never read as the daemon's approve-on-phone push, whose number the owner taps.
  letterSkeleton(PHONE_APPROVAL_TITLE),
].filter(skeleton => skeleton !== '');

/**
 * A buzz's title: the ask's own, plain, trimmed to `AGENDA_PUSH_TITLE_LENGTH` at a word boundary.
 *
 * A ferret chooses these words, so one that READS as the daemon's own new-device alert or its approve-on-phone push, in
 * any letters that look like it, is labelled `Ferret “…”`, which no real alert ever opens with. Every other title is
 * the words as written.
 */
export function buzzTitle(title: string): string {
  const name = oneLine(title);
  const letters = letterSkeleton(name);
  if (!RESERVED_ALERT_SKELETONS.some(reserved => letters.includes(reserved)))
    return clipAtWord(name, AGENDA_PUSH_TITLE_LENGTH);
  return `Ferret “${clipAtWord(name, AGENDA_PUSH_TITLE_LENGTH - 9)}”`;
}

/** A buzz's body: one line, clipped at a word. */
export const buzzBody = (text: string): string => clipAtWord(text, AGENDA_PUSH_BODY_LENGTH);

/** The longest ferret name a stop's title carries whole; the count after it must survive a lock screen. */
export const STOPPED_NAME_LENGTH = 24;
