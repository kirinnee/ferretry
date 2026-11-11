/**
 * Ruling #37's rule for the words of a command line, FROZEN from rebuild/5.0 at c2c55b4e0b
 * (`daemon/lib/service/resolved-view.ts`: `shownWord`, `shownWords` and `serverLine`), the commit that merged #37,
 * so the differential holds the #40 rule to it as a SECOND floor: every word #37 hid must stay at least as hidden.
 * The first floor (`resolved-view-today.ts`, 4.291.5) never hid `-H<token> KEY=v`, so it could not see #40 show it
 * again (review r1 F2). Only the imports are changed: it shares the live `looksSecret`, byte-identical to #37's.
 *
 * Do not edit this to follow 5.0. It is a floor.
 */
import { looksSecret } from '@ferretry/std/credential-words';

const RESOLVED_HIDDEN_TEXT = '‹hidden›';

const FLAG_WORD = /^-{1,2}[A-Za-z0-9][^=\s]*$/u;
const GLUED_VALUE = /^(-{1,2}[A-Za-z0-9][^=\s]*)(=|\s+)([\s\S]*)$/u;
const STUCK_VALUE = /^(-[A-Za-z])([^-=\s][\s\S]*)$/u;
const PIECE_BREAK = /[\s"'`:,;=]+/u;
const unquoted = (value: string): string => /^(["'])([\s\S]*)\1$/u.exec(value)?.[2] ?? value;

function secretValue(name: string, value: string): boolean {
  return looksSecret(name, unquoted(value)) || value.split(PIECE_BREAK).some(piece => looksSecret('', piece));
}

/** #37's word: `{ value, hidden }` the way the differential compares a word. */
function shownWord(word: string, before: string | undefined): { readonly value: string; readonly hidden?: true } {
  const hidden = (value: string) => ({ value, hidden: true as const });
  const glued = GLUED_VALUE.exec(word);
  if (glued !== null) {
    const [, flag = '', separator = '', value = ''] = glued;
    if (secretValue(flag, value)) return hidden(`${flag}${separator}${RESOLVED_HIDDEN_TEXT}`);
  }
  const stuck = STUCK_VALUE.exec(word);
  if (stuck !== null && secretValue('', stuck[2] ?? '')) return hidden(`${stuck[1] ?? ''}${RESOLVED_HIDDEN_TEXT}`);
  const name = before !== undefined && FLAG_WORD.test(before) && !word.startsWith('-') ? before : '';
  return secretValue(name, word) ? hidden(RESOLVED_HIDDEN_TEXT) : { value: word };
}

/** #37's launch flags, word by word, each judged with the flag before it. */
export const flags37 = (words: readonly string[]): readonly { readonly value: string; readonly hidden?: true }[] =>
  words.map((word, index) => shownWord(word, words[index - 1]));

/** #37's `serverLine` for a server started by a command. */
export function serverLine37(command: string, args: readonly string[]): string {
  const words = [command, ...args].filter(word => word !== '');
  return words.map((word, index) => shownWord(word, words[index - 1]).value).join(' ');
}
