/** `fy words [word]` (§1.3): a word, its owner and what it replaced. */
import { z } from 'zod';
import type { Word } from '@ferretry/kernel/contract';
import { EXIT } from '../errors.ts';
import { renderTable } from '../render.ts';
import type { CommandRegistry } from '../registry.ts';
import type { ShellVerb } from '../shell-context.ts';

export interface OwnedWord extends Word {
  readonly plugin: string;
}

const WordSchema = z.object({
  word: z.string(),
  means: z.string(),
  insteadOf: z.array(z.string()).optional(),
  plugin: z.string(),
});

/** The Kernel serves the joined glossary at `GET /v1/glossary` (data plugins' words included). */
const GLOSSARY_ROUTE = 'GET /v1/glossary';
const GlossarySchema = z.union([z.array(WordSchema), z.object({ words: z.array(WordSchema) })]);

/** The words compiled into this fy: every code plugin's manifest. A data plugin's words come only from the daemon. */
export function compiledWords(registry: CommandRegistry): readonly OwnedWord[] {
  return registry.plugins.flatMap(plugin =>
    (plugin.manifest.words ?? []).map(word => ({ ...word, plugin: plugin.id })),
  );
}

/** Entries whose word, or a word it replaced, is `query`; every entry when there is no query. */
export function findWords(words: readonly OwnedWord[], query: string | undefined): readonly OwnedWord[] {
  const sorted = [...words].sort((a, b) => a.word.localeCompare(b.word));
  if (query === undefined) return sorted;
  const wanted = query.trim().toLowerCase();
  return sorted.filter(
    entry => entry.word.toLowerCase() === wanted || (entry.insteadOf ?? []).some(old => old.toLowerCase() === wanted),
  );
}

function renderWords(words: readonly OwnedWord[], titles: Readonly<Record<string, string>>): string {
  return renderTable(
    ['WORD', 'OWNER', 'MEANS', 'INSTEAD OF'],
    words.map(entry => [
      entry.word,
      titles[entry.plugin] ?? entry.plugin,
      entry.means,
      (entry.insteadOf ?? []).join(', '),
    ]),
  );
}

/**
 * The daemon's joined glossary, or `undefined` when it is not answering, not readable, or blocked. It is read through
 * the guarded client as the Kernel's route (§9.6): the inventory is read and every core hash checked first, so a daemon
 * on another build is sent nothing but that bootstrap read.
 */
async function daemonWords(ctx: Parameters<ShellVerb>[0]): Promise<readonly OwnedWord[] | undefined> {
  if ((await ctx.world.probe()).state !== 'up') return undefined;
  try {
    const body = await ctx.client('kernel').call(GLOSSARY_ROUTE);
    const parsed = GlossarySchema.safeParse(body);
    if (!parsed.success) return undefined;
    return Array.isArray(parsed.data) ? parsed.data : parsed.data.words;
  } catch {
    return undefined;
  }
}

export const wordsVerb: ShellVerb = async ctx => {
  const { world } = ctx;
  const fromDaemon = await daemonWords(ctx);
  if (fromDaemon === undefined)
    world.io.err(
      `${world.identity.binary}: showing the words compiled into this ${world.identity.binary}; the daemon's glossary is not available\n`,
    );
  const query = ctx.invocation.args[0];
  const found = findWords(fromDaemon ?? compiledWords(world.registry), query);
  if (found.length === 0 && query === undefined) {
    world.io.out('the glossary is empty\n');
    return EXIT.ok;
  }
  if (found.length === 0) {
    world.io.err(`no word "${query}" in the glossary\n`);
    return EXIT.failure;
  }
  world.io.out(`${renderWords(found, ctx.surfaces.titles)}\n`);
  return EXIT.ok;
};
