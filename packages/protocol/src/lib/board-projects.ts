/**
 * THE BOARD'S PROJECT LIST AND EACH PROJECT'S LANES, on the wire.
 *
 * `GET /v1/board/projects` lists the Unfiled board first and then every registered project, each with its lane
 * set or `null` while it has none, and names the board the CALLER's session works on (`current`). The
 * registry itself (`GET /v1/projects`) never lists Unfiled. `GET /v1/board/projects/:projectId/lanes` reads one
 * of them; `POST` takes a {@link LaneSetActionRequestSchema} to propose, edit or confirm.
 */
import { z } from 'zod';
import { BoardProjectIdSchema } from './board-refs.ts';
import { LaneSetSchema } from './board-lanes.ts';

export const BoardProjectSchema = z.strictObject({
  id: BoardProjectIdSchema,
  name: z.string().min(1),
  /** The registered folder; `null` for the Unfiled board. */
  path: z.string().min(1).nullable(),
  laneSet: LaneSetSchema.nullable(),
});
export type BoardProject = z.infer<typeof BoardProjectSchema>;

export const BoardProjectsResponseSchema = z.strictObject({
  projects: z.array(BoardProjectSchema).min(1),
  /** The board the calling session works on; `null` for a caller that is not a session. */
  current: BoardProjectIdSchema.nullable(),
});
export type BoardProjectsResponse = z.infer<typeof BoardProjectsResponseSchema>;

/**
 * What a lane-set change answers. `agenda` says whether the owner was asked: `raised` is the one choice on
 * the proposing ferret's agenda, `not-needed` is a confirmed set or an owner's own edit, and `failed` means
 * the set is live but no card was raised (the proposer should say so itself).
 */
export const LaneSetChangeResponseSchema = z.strictObject({
  laneSet: LaneSetSchema,
  agenda: z.enum(['raised', 'not-needed', 'failed']),
});
export type LaneSetChangeResponse = z.infer<typeof LaneSetChangeResponseSchema>;
