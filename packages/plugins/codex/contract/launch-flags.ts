/**
 * THE LAUNCH FLAGS OF A CODEX SETTINGS ITEM, AND THE ONE RULE FOR WHICH OF THEM THE LAUNCH KEEPS.
 *
 * Any flag is accepted (owner decision !A525): there is no allowlist of names. v4's rule for a clash is kept: the launch's
 * own arguments come AFTER the item's and win, and a flag the launch decides itself is dropped from the item's, so a
 * settings flag can neither loosen the permission mode nor take over the Ferretry tools server. What the launch decides:
 * the approval and sandbox switches (`--ask-for-approval`/`-a`, `--sandbox`/`-s`, `--full-auto`,
 * `--dangerously-bypass-approvals-and-sandbox`), a `-c`/`--config` override of `approval_policy`, `sandbox_mode` or the
 * `ferretry` MCP server, and `--no-alt-screen` (Codex refuses it twice). Everything else is the item's, `-c` included.
 *
 * Pure: words in, words out. The permission switches are also what makes an AGENT's edit a loosening (held for the owner).
 */

/** How many words after it a flag takes: none, one, or one `key=value` that decides whether it is dropped. */
type FlagShape = 'bare' | 'value' | 'config';

const OWNED: ReadonlyMap<string, FlagShape> = new Map<string, FlagShape>([
  ['--dangerously-bypass-approvals-and-sandbox', 'bare'],
  ['--full-auto', 'bare'],
  ['--ask-for-approval', 'value'],
  ['-a', 'value'],
  ['--sandbox', 'value'],
  ['-s', 'value'],
  ['--no-alt-screen', 'bare'],
  ['--config', 'config'],
  ['-c', 'config'],
]);

/** The `-c` keys the launch sets itself: the permission pair, and the Ferretry tools server and everything under it. */
const ownedConfigKey = (key: string): boolean =>
  key === 'approval_policy' ||
  key === 'sandbox_mode' ||
  key === 'mcp_servers.ferretry' ||
  key.startsWith('mcp_servers.ferretry.');

/** The flags that set what the agent may do without asking: an agent adding one is a loosening. */
const PERMISSION_FLAGS: ReadonlySet<string> = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--full-auto',
  '--ask-for-approval',
  '-a',
  '--sandbox',
  '-s',
]);
const PERMISSION_KEYS: ReadonlySet<string> = new Set(['approval_policy', 'sandbox_mode']);

/** A flag word's name: what stands before the first `=` (`--sandbox=read-only` is `--sandbox`). */
const nameOf = (word: string): string => {
  const equals = word.indexOf('=');
  return equals > 0 ? word.slice(0, equals) : word;
};

/** The config key an override sets: what stands before the first `=` of its `key=value`. */
const keyOf = (assignment: string): string => nameOf(assignment).trim();

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
    const inline = word.includes('=');
    const takesNext = shape !== 'bare' && !inline && at + 1 < words.length;
    if (shape === 'config') {
      const assignment = inline ? word.slice(word.indexOf('=') + 1) : (words[at + 1] ?? '');
      if (!ownedConfigKey(keyOf(assignment))) {
        kept.push(word);
        if (takesNext) kept.push(words[++at] as string);
        continue;
      }
    }
    if (takesNext) at++;
  }
  return kept;
}

/** The permission switches among the words, by name (never a value): a flag, or the `-c` key that sets one. */
function switchesOf(words: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>();
  words.forEach((word, at) => {
    const name = nameOf(word);
    if (PERMISSION_FLAGS.has(name)) found.add(name);
    if (OWNED.get(name) !== 'config') return;
    const key = keyOf(word.includes('=') ? word.slice(word.indexOf('=') + 1) : (words[at + 1] ?? ''));
    if (PERMISSION_KEYS.has(key)) found.add(`-c ${key}`);
  });
  return found;
}

/** What an edit from `before` to `after` loosens through the flags: each permission switch the item did not carry. */
export function launchFlagsLoosen(before: readonly string[], after: readonly string[]): readonly string[] {
  const had = switchesOf(before);
  return [...switchesOf(after)]
    .filter(name => !had.has(name))
    .map(name => `a launch flag sets the permission mode (${name})`);
}
