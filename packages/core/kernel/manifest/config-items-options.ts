import type { VerbOptionDecl } from './types.ts';

/**
 * The flags every item `add` / `edit` / `rm` shares (docs/config-files.md, "components"), worded once so `fy <verb> --help`
 * says the same thing for every kind: what a preview stops at, what a change that edits or removes needs, and the machine
 * output.
 */
export const ITEM_WRITE_OPTIONS: readonly VerbOptionDecl[] = [
  { flag: '--dry-run', help: 'show what would change and stop' },
  { flag: '-y, --yes', help: 'do not ask before a change that edits or removes something' },
];

/** `--remove-from-profiles`, for `rm`: take the item out of every profile that has it first. */
export const ITEM_REMOVE_OPTIONS: readonly VerbOptionDecl[] = [
  ...ITEM_WRITE_OPTIONS,
  { flag: '--remove-from-profiles', help: 'take it out of every profile that has it first' },
];

/** `--json`, for `ls` and `show`. */
export const ITEM_READ_OPTIONS: readonly VerbOptionDecl[] = [{ flag: '--json', help: 'print JSON instead of words' }];

/** The flags of a kind whose document is one mapping read from a local file (`settings`, `hooks`). */
export const ITEM_FILE_OPTIONS: readonly VerbOptionDecl[] = [
  { flag: '--file <path>', help: 'the mapping, from a local JSON or YAML file (- reads standard input)' },
  { flag: '--description <text>', help: 'one line about what it is for' },
];
