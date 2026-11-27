import { z } from 'zod';

/** The same opaque group used by `fy worktree add --project` and the project's move action. */
export function projectGroup(project: { readonly id: string; readonly name: string }): string {
  const slug = project.name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  const tag = project.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return `${slug === '' ? 'project' : slug}-${tag}`;
}

/** A read-only offer. Only the daemon chooses a destination and fingerprints the checkout the person reviews. */
export const WorktreeMoveOfferSchema = z.object({
  worktreeId: z.string().min(1),
  destination: z.string().min(1).optional(),
  reviewedIdentity: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  reason: z.string().min(1).optional(),
});
export type WorktreeMoveOffer = z.infer<typeof WorktreeMoveOfferSchema>;

/** No path, force flag or bulk apply is accepted. Each confirmation concerns one daemon-issued offer. */
export const MoveProjectWorktreeRequestSchema = z.strictObject({
  project: z.string().min(1),
  worktreeId: z.string().min(1),
  reviewedIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type MoveProjectWorktreeRequest = z.infer<typeof MoveProjectWorktreeRequestSchema>;
export const MovedProjectWorktreeSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });
export type MovedProjectWorktree = z.infer<typeof MovedProjectWorktreeSchema>;
