/**
 * v4 `state/projects.json` (4.291.5): written by `FileProjectCatalog.write`
 * (`packages/daemon/src/adapters/catalog/file-project-catalog.ts`) as a BARE pretty-printed array with no version,
 * each entry parsed on read by today's `ProjectInfoSchema` (`packages/protocol/src/lib/catalog.ts:26-45`), a
 * non-strict `z.object`. A LOCAL copy on purpose: the product has no v4 reader.
 */
import { z } from 'zod';

export const V4_PROJECTS_FILE = 'state/projects.json';

export const V4Project = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1),
  path: z.string().min(1),
  source: z.enum(['existing-folder', 'clone', 'new-folder', 'confirmed-discovery']),
  createdAt: z.iso.datetime({ offset: true }),
  git: z.object({ commonDirectory: z.string().min(1) }).optional(),
  lastActivity: z.iso.datetime({ offset: true }).optional(),
});
export type V4Project = z.infer<typeof V4Project>;
