/**
 * THE LAUNCH FLAGS OF A CLAUDE SETTINGS ITEM, AND THE ONE RULE FOR WHICH OF THEM THE LAUNCH KEEPS.
 *
 * Any flag is accepted (owner decision !A525): there is no allowlist of names. v4's rule for a clash is kept: the launch's
 * own flags come AFTER the item's and win, and a flag the launch decides itself is dropped from the item's, so a settings
 * flag can neither loosen the permission mode nor break resume or attribution. What the launch decides: the permission
 * mode (`--permission-mode`, the two skip switches), the conversation (`--session-id`, `--resume`, `--continue`,
 * `--fork-session`, and the short `-r`/`-c` in any spelling, `-r<id>` and clusters like `-dr` included), and the two files
 * the home owns (`--settings`, `--mcp-config`). Everything else is the item's.
 *
 * THE WORDS ARE READ AS FLAG ITEMS, so no item word can change how the launch's own words parse. An item is a flag-shaped
 * word with its value: written into it (`--model=x`), or the one plain word right after it. Every other word (a bare `--`,
 * a subcommand, a positional, a second plain word: repeat the flag instead, `--add-dir a --add-dir b`) is refused, and a
 * kept item is re-spelled with its value ATTACHED (`--model=x`), so what the launch passes is flag-shaped words only: a
 * positional can never lead and `--` can never turn the launch's flags into positionals. A flag left with no value at the
 * end of the item flags may still take the next word whatever it is, so the launch puts one disposable word of its own
 * right after them (`launch.ts`).
 *
 * Pure: words in, words out. The permission switches are also what makes an AGENT's edit a loosening (held for the owner).
 */

const OWNED: ReadonlySet<string> = new Set([
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--session-id',
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--fork-session',
  '--settings',
  '--mcp-config',
]);

/** The short flags the launch decides: one of these letters anywhere in a single-dash word is that flag (`-dr`, `-r<id>`). */
const OWNED_SHORT: readonly string[] = ['r', 'c'];

/** The flags that set what the agent may do without asking: an agent adding one is a loosening. */
const PERMISSION_SWITCHES: ReadonlySet<string> = new Set([
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
]);

/** One flag of the item with its value: `value` is `undefined` for a bare flag (or one the item left without a value). */
interface FlagItem {
  readonly name: string;
  readonly value: string | undefined;
}

/** A flag-shaped word split into its name and the value written into it: `--a=b` is `--a`+`b`, `-nb` is `-n`+`b`. */
function flagWord(word: string): { readonly name: string; readonly attached: string | undefined } | undefined {
  if (!word.startsWith('-') || word === '-' || word === '--') return undefined;
  if (word.startsWith('--')) {
    const equals = word.indexOf('=');
    return equals > 0
      ? { name: word.slice(0, equals), attached: word.slice(equals + 1) }
      : { name: word, attached: undefined };
  }
  const letter = OWNED_SHORT.find(owned => word.slice(1).includes(owned));
  if (letter !== undefined) return { name: `-${letter}`, attached: undefined };
  return word.length > 2
    ? { name: word.slice(0, 2), attached: word.slice(2).replace(/^=/u, '') }
    : { name: word, attached: undefined };
}

/** The item's words as flag items: the plain word right after a flag is its value, every other plain word is refused. */
function flagItems(words: readonly string[]): readonly FlagItem[] {
  const items: FlagItem[] = [];
  for (let at = 0; at < words.length; at++) {
    const flag = flagWord(words[at] as string);
    if (flag === undefined) continue;
    let value = flag.attached;
    const next = words[at + 1];
    if (value === undefined && next !== undefined && next !== '--' && flagWord(next) === undefined) {
      value = next;
      at++;
    }
    items.push({ name: flag.name, value });
  }
  return items;
}

/** An item as ONE word with its value attached, so nothing that follows it can be taken for its value or for the item. */
const spelled = ({ name, value }: FlagItem): string =>
  value === undefined ? name : name.startsWith('--') ? `${name}=${value}` : `${name}${value}`;

/** The item's words as the launch passes them: flag-shaped words only, in order, except a flag the launch decides. */
export function launchFlagsKept(words: readonly string[]): readonly string[] {
  return flagItems(words)
    .filter(item => !OWNED.has(item.name))
    .map(spelled);
}

/** The permission switches among the words, by name (never a value). */
const switchesOf = (words: readonly string[]): ReadonlySet<string> =>
  new Set(
    flagItems(words)
      .map(item => item.name)
      .filter(name => PERMISSION_SWITCHES.has(name)),
  );

/** What an edit from `before` to `after` loosens through the flags: each permission switch the item did not carry. */
export function launchFlagsLoosen(before: readonly string[], after: readonly string[]): readonly string[] {
  const had = switchesOf(before);
  return [...switchesOf(after)]
    .filter(name => !had.has(name))
    .map(name => `a launch flag sets the permission mode (${name})`);
}
