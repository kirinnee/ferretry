/**
 * THE LANE MODEL, as the lanes code reads it: a project's lanes (arbitrary names over a fixed set of categories),
 * their stages and gates, the templates, the lane sets and a waiting proposal, and every pure, total helper over
 * them. The model is Board's contract (`contract/lanes.ts`), because the app, the CLI and the card rules read the
 * same lanes; this module is only where the lanes code imports it from.
 */
export * from '../../../contract/lanes.ts';
export {
  type LaneSetActionRequest,
  LaneSetActionRequestSchema,
  laneEditProblems,
} from '../../../contract/index.ts';
export {
  type CardActorVia as BoardActorVia,
  CardActorViaSchema as BoardActorViaSchema,
} from '../../../contract/index.ts';
