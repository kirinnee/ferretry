/**
 * THE LAUNCH FLAGS OF A CLAUDE SETTINGS ITEM, AND THE ONE RULE FOR WHICH OF THEM THE LAUNCH KEEPS.
 *
 * Any flag is accepted (owner decision !A525): there is no allowlist of names. v4's rule for a clash is kept: the launch's
 * own flags come AFTER the item's and win, and a flag the launch decides itself is dropped from the item's, so a settings
 * flag can neither loosen the permission mode nor break resume or attribution. What the launch decides: the permission
 * mode (`--permission-mode`, the two skip switches), the conversation (`--session-id`, `--resume`, `--continue`,
 * `--fork-session`), and the two files the home owns (`--settings`, `--mcp-config`). Everything else is the item's.
 *
 * Pure: words in, words out. The permission switches are also what makes an AGENT's edit a loosening (held for the owner).
 */

/** How many words after it a flag takes: none, one, one unless the next is a flag, or every word up to the next flag. */
type FlagShape = 'bare' | 'value' | 'optional' | 'many';

const OWNED: ReadonlyMap<string, FlagShape> = new Map<string, FlagShape>([
  ['--permission-mode', 'value'],
  ['--dangerously-skip-permissions', 'bare'],
  ['--allow-dangerously-skip-permissions', 'bare'],
  ['--session-id', 'value'],
  ['--resume', 'optional'],
  ['-r', 'optional'],
  ['--continue', 'bare'],
  ['-c', 'bare'],
  ['--fork-session', 'bare'],
  ['--settings', 'value'],
  ['--mcp-config', 'many'],
]);

/** The flags that set what the agent may do without asking: an agent adding one is a loosening. */
const PERMISSION_SWITCHES: ReadonlySet<string> = new Set([
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
]);

/** A flag word's name: what stands before the first `=` (`--permission-mode=plan` is `--permission-mode`). */
const nameOf = (word: string): string => {
  const equals = word.indexOf('=');
  return equals > 0 ? word.slice(0, equals) : word;
};

/** The item's words as the launch passes them: every word kept, in order, except a flag the launch decides and its value. */
export function launchFlagsKept(words: readonly string[]): readonly string[] {
  const kept: string[] = [];
  for (let at = 0; at < words.length; at++) {
    const word = words[at] as string;
    const shape = OWNED.get(nameOf(word));
    if (shape === undefined) {
      kept.push(word);
      continue;
    }
    if (shape === 'bare' || word.includes('=')) continue;
    if (shape === 'value') {
      if (at + 1 < words.length) at++;
      continue;
    }
    // `optional` takes one word and `many` every word, both only up to the next flag.
    const room = shape === 'optional' ? 1 : words.length;
    for (let taken = 0; taken < room && at + 1 < words.length && !(words[at + 1] as string).startsWith('-'); taken++)
      at++;
  }
  return kept;
}

/** The permission switches among the words, by name (never a value). */
const switchesOf = (words: readonly string[]): ReadonlySet<string> =>
  new Set(words.map(nameOf).filter(name => PERMISSION_SWITCHES.has(name)));

/** What an edit from `before` to `after` loosens through the flags: each permission switch the item did not carry. */
export function launchFlagsLoosen(before: readonly string[], after: readonly string[]): readonly string[] {
  const had = switchesOf(before);
  return [...switchesOf(after)]
    .filter(name => !had.has(name))
    .map(name => `a launch flag sets the permission mode (${name})`);
}
