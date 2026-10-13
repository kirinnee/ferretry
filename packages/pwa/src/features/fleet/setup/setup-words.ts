/**
 * The few words every setup screen shares (docs/design/account-model.md §4.1 rule 8): the two
 * harness names, counts that read as words, and lists that read as a sentence.
 */

export type SetupHarness = 'claude' | 'codex';

/** In the order every screen lists them. */
export const SETUP_HARNESSES: readonly SetupHarness[] = ['claude', 'codex'];

export const SETUP_HARNESS_NAMES: Readonly<Record<SetupHarness, string>> = { claude: 'Claude Code', codex: 'Codex' };

/** "1 runtime", "3 runtimes". */
export const countWords = (count: number, word: string): string =>
  `${String(count)} ${count === 1 ? word : `${word}s`}`;

/** "a", "a and b", "a, b and c". */
export const listWords = (items: readonly string[]): string => {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;
};

/** The last part of a path: a person sees `settings.json`, never where it lives. */
export const fileName = (path: string): string =>
  path
    .split(/[\\/]/u)
    .filter(part => part !== '')
    .pop() ?? path;
