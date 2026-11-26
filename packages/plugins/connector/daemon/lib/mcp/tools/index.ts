import type { ConnectorToolSpec } from './spec.ts';
import { ACTION_TOOLS } from './actions.ts';
import { ATTENTION_TOOLS } from './attention.ts';
import { FERRET_TOOLS } from './ferrets.ts';

export { parseAttentionRef, shapeAnswer } from './attention-core.ts';
export type { ConnectorToolSpec } from './spec.ts';

/** The eleven tools, in the order `tools/list` offers them. */
export const CONNECTOR_TOOLS: readonly ConnectorToolSpec[] = [
  FERRET_TOOLS[0],
  FERRET_TOOLS[1],
  FERRET_TOOLS[2],
  ATTENTION_TOOLS[0],
  ATTENTION_TOOLS[1],
  ACTION_TOOLS[0],
  ATTENTION_TOOLS[3],
  ATTENTION_TOOLS[2],
  ACTION_TOOLS[1],
  ACTION_TOOLS[2],
  ACTION_TOOLS[3],
] as unknown as readonly ConnectorToolSpec[];
