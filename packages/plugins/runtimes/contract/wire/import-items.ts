/**
 * The names of the things an import can leave out (`setup.import` `skip`), one grammar for the screen that
 * builds them and the planner that reads them.
 *
 * `<harness>:<kind>` for the things a harness has one of (`claude-code:instructions`, `claude-code:settings`,
 * `claude-code:env`), `<harness>:<kind>:<name>` for the ones it has many of (`claude-code:mcp:notes`,
 * `codex:skill:review`, `codex:profile:fast`). The harness is the wire key (`claude-code`, `codex`). A name
 * is what the host calls the thing — a server, a skill folder, a profile — and is never a value.
 *
 * Naming something that is not there, or of a harness that is not being imported, leaves out nothing.
 */
import { z } from 'zod';
import type { HarnessKeySchema } from './shared.ts';

type HarnessKey = z.infer<typeof HarnessKeySchema>;

/** What a harness has one of. */
export const IMPORT_SINGLE_ITEMS = ['instructions', 'settings', 'env'] as const;
/** What a harness has many of, each by name. */
export const IMPORT_NAMED_ITEMS = ['mcp', 'skill', 'profile'] as const;

export type ImportSingleItem = (typeof IMPORT_SINGLE_ITEMS)[number];
export type ImportNamedItem = (typeof IMPORT_NAMED_ITEMS)[number];

/** The longest name an item id carries; a longer host name could not be imported anyway. */
const IMPORT_ITEM_NAME_LIMIT = 200;

const ITEM_ID_PATTERN = new RegExp(
  `^(?:claude-code|codex):(?:(?:${IMPORT_SINGLE_ITEMS.join('|')})|(?:${IMPORT_NAMED_ITEMS.join('|')}):[^\\s:][^:]{0,${String(IMPORT_ITEM_NAME_LIMIT - 1)}})$`,
  'u',
);

/** One item of one harness's setup, spelled as the grammar above. */
export const ImportItemIdSchema = z.string().regex(ITEM_ID_PATTERN, 'an import item names <harness>:<kind>[:<name>]');
export type ImportItemId = z.infer<typeof ImportItemIdSchema>;

/** The id of a single item (`claude-code:instructions`). */
export const importItemId = (harness: HarnessKey, kind: ImportSingleItem): ImportItemId => `${harness}:${kind}`;

/** The id of a named item (`codex:skill:review`). */
export const importNamedItemId = (harness: HarnessKey, kind: ImportNamedItem, name: string): ImportItemId =>
  `${harness}:${kind}:${name}`;
