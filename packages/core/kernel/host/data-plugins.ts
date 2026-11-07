import { KEBAB_NAME } from '@ferretry/std';
import { z } from 'zod';
import { PLUGIN_API } from '../contract/ids.ts';
import { DATA_KINDS } from '../manifest/types.ts';
import type { HostFs } from './adapters/node-fs.ts';
import type { DataPluginManifest } from './snapshot.ts';

const DATA_PLUGIN_FORMAT = 1;

/** A data plugin's `plugin.json` (§3.1): data kinds only, nothing that runs; pinned by the install (§3.6). */
const DataPluginSchema = z.strictObject({
  format: z.literal(DATA_PLUGIN_FORMAT),
  id: z.string().regex(KEBAB_NAME).max(40),
  title: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  api: z.literal(PLUGIN_API),
  kinds: z.array(z.enum(DATA_KINDS)).min(1),
  words: z
    .array(
      z.strictObject({ word: z.string().min(1), means: z.string().min(1), insteadOf: z.array(z.string()).optional() }),
    )
    .optional(),
  instructions: z.array(z.strictObject({ id: z.string().regex(KEBAB_NAME), text: z.string().min(1) })).optional(),
  onboarding: z
    .array(z.strictObject({ id: z.string().regex(KEBAB_NAME), title: z.string().min(1), order: z.number().int() }))
    .optional(),
  items: z
    .array(z.strictObject({ kind: z.string().min(1), id: z.string().regex(KEBAB_NAME), file: z.string().min(1) }))
    .optional(),
});

export interface DataPluginRefusal {
  readonly folder: string;
  readonly sentence: string;
}

/**
 * Reads the installed data plugins from `state/kernel/plugins/<id>/plugin.json` (§3.4 found/checked). A plugin that
 * does not check is refused and named for `fy doctor`; the rest boots. A data plugin whose id collides with a code
 * plugin is refused.
 */
export async function loadDataPlugins(
  fs: HostFs,
  home: string,
  codeIds: ReadonlySet<string>,
): Promise<{ readonly accepted: readonly DataPluginManifest[]; readonly refused: readonly DataPluginRefusal[] }> {
  const root = `${home}/state/kernel/plugins`;
  const accepted: DataPluginManifest[] = [];
  const refused: DataPluginRefusal[] = [];
  for (const folder of await fs.list(root)) {
    const path = `${root}/${folder}/plugin.json`;
    let decoded: unknown;
    try {
      decoded = JSON.parse(await fs.readText(path));
    } catch {
      refused.push({ folder, sentence: `The data plugin in ${folder} has no readable plugin.json.` });
      continue;
    }
    const parsed = DataPluginSchema.safeParse(decoded);
    if (!parsed.success) {
      refused.push({
        folder,
        sentence: `The data plugin in ${folder} does not check: ${parsed.error.issues[0]?.message ?? 'invalid'}.`,
      });
      continue;
    }
    if (
      parsed.data.id !== folder ||
      codeIds.has(parsed.data.id) ||
      accepted.some(other => other.id === parsed.data.id)
    ) {
      refused.push({
        folder,
        sentence: `The data plugin in ${folder} names the id ${parsed.data.id}, which is taken or not its folder.`,
      });
      continue;
    }
    accepted.push(parsed.data);
  }
  return { accepted, refused };
}
