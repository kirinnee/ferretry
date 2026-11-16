/**
 * THE LAUNCH FLAGS OF A CODEX SETTINGS ITEM, AND THE ONE RULE FOR WHICH OF THEM THE LAUNCH KEEPS.
 *
 * Any flag is accepted (owner decision !A525): there is no allowlist of names. v4's rule for a clash is kept: the launch's
 * own arguments come AFTER the item's and win, and a flag the launch decides itself is dropped from the item's, so a
 * settings flag can neither loosen the permission mode nor take over the Ferretry tools server. What the launch decides:
 * the approval and sandbox switches (`--ask-for-approval`/`-a`, `--sandbox`/`-s`, `--full-auto`, `--yolo`,
 * `--dangerously-bypass-approvals-and-sandbox`), a profile (`--profile`/`-p`, which carries a permission of its own), a
 * `-c`/`--config` override of `approval_policy`, `sandbox_mode`, `profile`, the whole `mcp_servers` table or the `ferretry`
 * MCP server, and `--no-alt-screen` (Codex refuses it twice). Everything else is the item's, `-c` included.
 *
 * THE WORDS ARE READ AS FLAG ITEMS, so no item word can change how the launch's own words parse. An item is a flag-shaped
 * word with its value: written into it (`--model=x`, `-sread-only`, `-cKEY=v`: a short flag is its first two characters),
 * or the one plain word right after it. Every other word (a bare `--`, a subcommand, a positional, a second plain word)
 * is refused, and a kept item is re-spelled with its value ATTACHED (`--model=x`, `-cKEY=v`), so what the launch passes
 * is flag-shaped words only: a subcommand can never lead and `--` can never turn the launch's `-c` into a positional.
 * The launch also passes its permission as explicit `--ask-for-approval`/`--sandbox` (see `fixed-layer.ts`), which Codex
 * refuses twice, so a spelling this file did not recognise can only make the start fail, never loosen it.
 *
 * Pure: words in, words out. The permission switches are also what makes an AGENT's edit a loosening (held for the owner).
 */

/** How many words after it a flag takes: none, one, or one `key=value` that decides whether it is dropped. */
type FlagShape = 'bare' | 'value' | 'config';

const OWNED: ReadonlyMap<string, FlagShape> = new Map<string, FlagShape>([
  ['--dangerously-bypass-approvals-and-sandbox', 'bare'],
  ['--yolo', 'bare'],
  ['--full-auto', 'bare'],
  ['--ask-for-approval', 'value'],
  ['-a', 'value'],
  ['--sandbox', 'value'],
  ['-s', 'value'],
  ['--profile', 'value'],
  ['-p', 'value'],
  ['--no-alt-screen', 'bare'],
  ['--config', 'config'],
  ['-c', 'config'],
]);

/** A `-c` key with its quotes and blanks removed (`"approval_policy"`, `mcp_servers . "ferretry"`). */
const keyOf = (assignment: string): string => {
  const equals = assignment.indexOf('=');
  return (equals > 0 ? assignment.slice(0, equals) : '').replace(/["'\s]/gu, '');
};

/**
 * The `-c` keys the launch sets itself: the permission pair, the profile that can set them, and the Ferretry tools
 * server — and so the whole `mcp_servers` table, which holds it.
 */
const ownedConfigKey = (key: string): boolean =>
  key === 'approval_policy' ||
  key === 'sandbox_mode' ||
  key === 'profile' ||
  key === 'mcp_servers' ||
  key === 'mcp_servers.ferretry' ||
  key.startsWith('mcp_servers.ferretry.');

/** The flags that set what the agent may do without asking: an agent adding one is a loosening. */
const PERMISSION_FLAGS: ReadonlySet<string> = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--full-auto',
  '--ask-for-approval',
  '-a',
  '--sandbox',
  '-s',
  '--profile',
  '-p',
]);

/** One flag of the item with its value: `value` is `undefined` for a bare flag (or one the item left without a value). */
interface FlagItem {
  readonly name: string;
  readonly value: string | undefined;
}

/** A flag-shaped word split into its name and the value written into it: `--a=b` is `--a`+`b`, `-sb` is `-s`+`b`. */
function flagWord(word: string): { readonly name: string; readonly attached: string | undefined } | undefined {
  if (!word.startsWith('-') || word === '-' || word === '--') return undefined;
  if (word.startsWith('--')) {
    const equals = word.indexOf('=');
    return equals > 0
      ? { name: word.slice(0, equals), attached: word.slice(equals + 1) }
      : { name: word, attached: undefined };
  }
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

/** Whether the launch decides this flag item itself. */
function owned({ name, value }: FlagItem): boolean {
  const shape = OWNED.get(name);
  if (shape === undefined) return false;
  return shape !== 'config' || value === undefined || ownedConfigKey(keyOf(value));
}

/** The item's words as the launch passes them: flag-shaped words only, in order, except a flag the launch decides. */
export function launchFlagsKept(words: readonly string[]): readonly string[] {
  return flagItems(words)
    .filter(item => !owned(item))
    .map(spelled);
}

/** The permission switches among the words, by name (never a value): a flag, or the `-c` key that sets one. */
function switchesOf(words: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const { name, value } of flagItems(words)) {
    if (PERMISSION_FLAGS.has(name)) found.add(name);
    if (OWNED.get(name) !== 'config' || value === undefined) continue;
    const key = keyOf(value);
    if (ownedConfigKey(key)) found.add(`-c ${key}`);
  }
  return found;
}

/** What an edit from `before` to `after` loosens through the flags: each permission switch the item did not carry. */
export function launchFlagsLoosen(before: readonly string[], after: readonly string[]): readonly string[] {
  const had = switchesOf(before);
  return [...switchesOf(after)]
    .filter(name => !had.has(name))
    .map(name => `a launch flag sets the permission mode (${name})`);
}
