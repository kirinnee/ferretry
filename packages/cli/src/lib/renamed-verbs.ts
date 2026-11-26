/**
 * The verbs 5.0 renamed or moved, and where each one went: what `fy` says instead of a bare "unknown verb" when someone
 * types the old spelling (a habit, an old transcript, an agent's old instructions). A pointer, not a way to run it: the
 * old verb takes different words now, so it is named and the person types the new one.
 */
const RENAMED: readonly { readonly typed: readonly string[]; readonly now: string }[] = [
  { typed: ['migrate'], now: 'ferret move <id>' },
  { typed: ['harness', 'status'], now: 'harness <claude-code|codex> status' },
  { typed: ['harness', 'update'], now: 'harness <claude-code|codex> update' },
  { typed: ['session', 'compact-at'], now: 'compact-at <ferret> [value]' },
  { typed: ['import', 'conversations'], now: 'link' },
  { typed: ['credentials'], now: 'login ls' },
  { typed: ['logins'], now: 'login ls' },
  { typed: ['credential'], now: 'login' },
  { typed: ['fleet'], now: 'recommend' },
];

/** The sentence pointing at a renamed verb's replacement when `typed` starts with one, else undefined. */
export function renamedPointer(binary: string, typed: readonly string[]): string | undefined {
  const old = RENAMED.find(entry => entry.typed.every((word, at) => typed[at] === word));
  return old === undefined
    ? undefined
    : `${binary}: \`${binary} ${old.typed.join(' ')}\` is now \`${binary} ${old.now}\``;
}
