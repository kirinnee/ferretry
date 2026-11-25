/**
 * `state/connector/calls.jsonl`: one line per WRITE tool call (docs/mcp-connector.md "Storage"). The arguments arrive already
 * redacted and cut to 500 characters, so the line says WHAT was done, never a secret; the access token appears only as the
 * first 12 hex characters of its digest.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

/** How a tool call ended: it did what was asked, it failed, or it was refused (by a gate, the tool or the daemon). */
export const CONNECTOR_TOOL_OUTCOMES = ['ok', 'error', 'refused'] as const;
export type ConnectorToolOutcome = (typeof CONNECTOR_TOOL_OUTCOMES)[number];

export const ConnectorCallLineSchema = z.strictObject({
  format: z.literal(1),
  at: InstantSchema,
  tool: z.string().min(1).max(64),
  grantId: z.string().regex(/^cg_[a-z0-9]{10}$/u),
  tokenId: z.string().regex(/^[a-f0-9]{12}$/u),
  args: z.record(z.string(), z.unknown()),
  outcome: z.enum(CONNECTOR_TOOL_OUTCOMES),
});
export type ConnectorCallLine = z.infer<typeof ConnectorCallLineSchema>;
