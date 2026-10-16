import { z } from 'zod';
import { ProposalCategorySchema } from './learning.ts';

/**
 * THE `lessons.suggest` AGENT TOOL — how a ferret files a lesson (docs/learning.md).
 *
 * A ferret calls it as `fy lesson suggest "<rule>" --scope global|repo` or as the `lessons_suggest` MCP
 * tool. Both reach `POST /v1/agent/lessons`, authenticated by the session credential alone: the daemon
 * derives the session from it, and attaches the evidence — the owner's latest message in that session
 * and the turn — itself. Nothing in the call can name a session or carry a quote, so a ferret cannot
 * file a lesson in another ferret's name or invent what the owner said.
 *
 * A duplicate (the same rule, by meaning, still open) is MERGED: its count goes up and its evidence list
 * grows. A rule the owner already rejected is not filed again.
 */

/** The longest rule one suggestion carries. A lesson is a sentence or two, not a document. */
export const LESSON_RULE_MAX_CHARS = 500;

export const AGENT_LESSONS_PATH = '/v1/agent/lessons' as const;

export const AgentLessonToolCallSchema = z.discriminatedUnion('tool', [
  z.strictObject({
    tool: z.literal('lessons.suggest'),
    rule: z.string().trim().min(1).max(LESSON_RULE_MAX_CHARS),
    /** `global` — every ferret should follow it; `repo` — it is about this project. */
    scope: ProposalCategorySchema,
  }),
]);
export type AgentLessonToolCall = z.infer<typeof AgentLessonToolCallSchema>;
export type AgentLessonToolName = AgentLessonToolCall['tool'];

export const AgentLessonToolResultSchema = z.strictObject({
  summary: z.string().min(1),
  proposalId: z.string().min(1).optional(),
  /** The lesson's strength after this filing. */
  count: z.number().int().positive().optional(),
  outcome: z.enum(['filed', 'merged', 'previously-rejected']),
});
export type AgentLessonToolResult = z.infer<typeof AgentLessonToolResultSchema>;
