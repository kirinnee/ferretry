import type { Word } from '@ferretry/kernel/contract';

/** Catalogs' glossary entries (§2.3). */
export const CATALOGS_WORDS = [
  { word: 'catalog', means: 'a shareable list of items' },
  {
    word: 'item',
    means: 'one shareable thing: an MCP server, skill, shell, recipe, layout, theme …',
    insteadOf: ['component'],
  },
  { word: 'share', means: 'giving a catalog to someone', insteadOf: ['invite'] },
  { word: 'member', means: 'a person you share with' },
] as const satisfies readonly Word[];
