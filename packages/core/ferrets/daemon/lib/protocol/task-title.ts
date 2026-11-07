/**
 * A SHORT HUMAN TITLE FOR A BRIEF, derived deterministically when nobody named the session.
 *
 * A session with no `--name` used to be titled with the first words of its prompt, which for a
 * delegated brief is boilerplate ("You-are-a-Ferretry-impl…"). The title a reader scans in the
 * Sessions list is the task, so this reads the brief the way a person would: the first Markdown
 * heading, else the first sentence that is not role-play or "go read this file" boilerplate,
 * trimmed to at most five words in Title Case. When nothing readable is left it says so (`null`)
 * and the caller picks a labelled-hash fallback, never the raw first words.
 */

const MAX_TITLE_WORDS = 5;
const MAX_TITLE_LENGTH = 60;

/** Words a title never opens with: a task title names the work, not the request for it. */
const LEADING_FILLER = new Set(['a', 'an', 'the', 'to', 'please', 'then', 'and', 'now', 'also', 'first']);
/** Words that stay lowercase inside a Title Case title. */
const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'with', 'by']);
/** Headings that say nothing about the task. */
const EMPTY_HEADINGS = new Set(['assigned task', 'task', 'brief', 'context', 'overview', 'summary', 'goal']);

const HEADING = /^#{1,6}\s+(.+?)\s*#*$/u;
const ROLE_PLAY = /^(?:you are|you're|act as|your role|your job)\b/iu;
const POINTER = /^(?:please\s+)?(?:first\s+)?(?:read|follow|see|open)\b/iu;
const PATH_TOKEN = /(?:^|\s)(?:~|\.{1,2})?\/\S+/gu;
const URL_TOKEN = /\bhttps?:\/\/\S+/giu;
const REFERENCE =
  /\b(?:read|follow|see|open)\s+[`'"]?((?:~|\.{1,2})?\/[^\s`'")]+|[\w.-]+\/[^\s`'")]+\.\w+|[\w.-]+\.md)/iu;

/** The file a brief tells its reader to read first (`Read /tmp/brief.md and follow it`), or null. */
export function briefFileReference(brief: string): string | null {
  const match = REFERENCE.exec(brief);
  return match?.[1] === undefined ? null : match[1].replace(/[.,;:]+$/u, '');
}

const unmark = (text: string): string =>
  text
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replaceAll(URL_TOKEN, ' ')
    .replaceAll(PATH_TOKEN, ' ')
    .replaceAll(/[`*_>~|]/gu, '')
    .replace(/^(?:[-+]|\d+[.)])\s+/u, '')
    .replaceAll(/\s+/gu, ' ')
    .trim();

const sentences = (text: string): readonly string[] =>
  text
    .split(/(?<=[.!?])\s+|\s[-–—:]\s|:\s/u)
    .map(part => part.trim())
    .filter(part => part !== '');

const titleWord = (word: string, index: number, last: number): string => {
  if (/[A-Z0-9]/u.test(word.slice(1)) || /\d/u.test(word)) return word;
  if (index !== 0 && index !== last && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
};

/** Up to five Title Case words from a sentence, or null when none are left. */
function titleOf(sentence: string): string | null {
  const words = sentence
    .split(' ')
    .map(word => word.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(word => word !== '');
  while (words.length > 0 && LEADING_FILLER.has((words[0] as string).toLowerCase())) words.shift();
  const kept = words.slice(0, MAX_TITLE_WORDS);
  while (kept.length > 1 && SMALL_WORDS.has((kept.at(-1) as string).toLowerCase())) kept.pop();
  if (kept.length === 0) return null;
  const title = kept.map((word, index) => titleWord(word, index, kept.length - 1)).join(' ');
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : title;
}

/** The title of a brief: its first heading, else its first line that names work; null when there is none. */
export function deriveTaskTitle(brief: string): string | null {
  const lines = brief
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('```') && line !== '---');
  const headings = lines.flatMap(line => {
    const text = HEADING.exec(line)?.[1];
    return text === undefined ? [] : [unmark(text)];
  });
  for (const heading of headings) {
    if (EMPTY_HEADINGS.has(heading.toLowerCase())) continue;
    const title = titleOf(heading);
    if (title !== null) return title;
  }
  for (const line of lines.filter(candidate => !HEADING.test(candidate))) {
    for (const sentence of sentences(line)) {
      if (ROLE_PLAY.test(sentence) || POINTER.test(sentence)) continue;
      const title = titleOf(unmark(sentence));
      if (title !== null) return title;
    }
  }
  return null;
}

/** A short, stable hash of a brief, so two untitled sessions of one kind still read apart. */
export function briefHash(brief: string): string {
  let hash = 0x811c9dc5;
  for (const character of brief) {
    hash ^= character.codePointAt(0) as number;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(4, '0').slice(-4);
}

/** The label-and-hash title used when a brief has nothing readable in it: `Review 7k2x`. */
export function fallbackTaskTitle(label: string, brief: string): string {
  const named = titleOf(unmark(label.replaceAll(/[-_]+/gu, ' '))) ?? 'Task';
  return `${named} ${briefHash(brief)}`;
}

/** The title for a brief nobody named: what it says, else a labelled hash. Never its raw first words. */
export function taskTitleFor(brief: string, label: string): string {
  return deriveTaskTitle(brief) ?? fallbackTaskTitle(label, brief);
}
