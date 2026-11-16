/**
 * THE INSTRUCTIONS LIST, as pure decisions (today's context rail "Instructions" tab): which files of the ferret's folder are
 * instruction files, how they are chipped and searched, and how they are sized.
 */
import { type ContextChip, chipsFor, matchesQuery } from '@ferretry/app/ui';
import { formatBytes } from '../files/files-model.ts';
import type { FsEntry } from '../files/wire.ts';

export type DocChip = 'all' | 'claude' | 'generic';

const DOC_CHIPS: readonly DocChip[] = ['all', 'claude', 'generic'];
const DOC_CHIP_LABEL: Readonly<Record<DocChip, string>> = { all: 'All', claude: 'Claude', generic: 'Generic' };

/** The label of the search box, and what an empty list says. */
export const DOCS_SEARCH_LABEL = 'Search instructions';
export const NO_DOCS = 'No instruction files in this folder.';

/**
 * The instruction files an agent reads from the folder it works in, by name. Claude reads `CLAUDE.md` (and the uncommitted
 * `CLAUDE.local.md`); Codex and most other agents read `AGENTS.md`; Gemini reads `GEMINI.md`. Listed in this order.
 */
const INSTRUCTION_FILE_NAMES: readonly string[] = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.override.md',
  'GEMINI.md',
];

/** One instruction file in the agent's folder, by its path relative to that folder. */
export interface ContextDoc {
  readonly path: string;
  readonly name: string;
  readonly size?: number;
}

/** The instruction files in one directory listing, in `INSTRUCTION_FILE_NAMES` order. A file the daemon refuses to serve is not offered. */
export const instructionDocs = (entries: readonly FsEntry[], directory = ''): ContextDoc[] =>
  INSTRUCTION_FILE_NAMES.flatMap(name => {
    const entry = entries.find(candidate => candidate.name === name && candidate.type === 'file');
    if (entry === undefined || entry.denied === true || entry.escapes === true) return [];
    return [
      {
        path: directory === '' ? name : `${directory}/${name}`,
        name,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      },
    ];
  });

const docInChip = (doc: ContextDoc, chip: DocChip): boolean =>
  chip === 'all' || (chip === 'claude') === doc.name.startsWith('CLAUDE.');

export const docChips = (docs: readonly ContextDoc[], query: string): ContextChip<DocChip>[] =>
  chipsFor(
    DOC_CHIPS,
    DOC_CHIP_LABEL,
    docs.filter(doc => matchesQuery(query, doc.path)),
    docInChip,
  );

export const visibleDocs = (docs: readonly ContextDoc[], query: string, chip: DocChip): ContextDoc[] =>
  docs.filter(doc => docInChip(doc, chip) && matchesQuery(query, doc.path));

/** "12.5 KB", or nothing when the listing did not say. */
export const docSize = (doc: ContextDoc): string => formatBytes(doc.size);
