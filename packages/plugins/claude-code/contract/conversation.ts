/**
 * WHICH TRANSCRIPT IS A FERRET'S OWN, as Claude Code proves it.
 *
 * A ferret's agent home (`agent-homes/<ferret>`) is bound to ONE Claude conversation by `conversation.json`
 * (`{ format: 1, id, cwd }`), written at every start and resume. Its transcript is then exactly
 * `<home>/projects/<cwd encoded>/<id>.jsonl` — never one found by guessing or by recency. Declared in the contract so
 * the one other writer (the v4 → v5 converter, which carries a v4 ferret's conversation into its home) writes exactly
 * what the harness reads.
 */
import { z } from 'zod';

/** The binding's file name inside the ferret's agent home. */
export const CLAUDE_CODE_CONVERSATION_FILE = 'conversation.json';

/** S45: a conversation id is one plain name at every boundary. */
export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value);
}

/** The binding: the conversation a ferret's home is assigned and the folder it runs in (absolute). */
export const ClaudeConversationBindingSchema = z.object({
  format: z.literal(1),
  id: z.string().refine(isConversationId, 'a conversation id is one plain name'),
  cwd: z.string().startsWith('/'),
});
export type ClaudeConversationBinding = z.infer<typeof ClaudeConversationBindingSchema>;

/** Claude's directory encoding, copied from daemon/src/lib/session/transcript/claude-path.ts. */
function claudeProjectDirectory(cwd: string): string {
  return cwd.replaceAll(/[^a-zA-Z0-9]/gu, '-');
}

/** The transcript of `conversation` run in `cwd`, relative to the agent home. The filename is the identity. */
export function claudeTranscriptPath(cwd: string, conversation: string): string {
  return `projects/${claudeProjectDirectory(cwd)}/${conversation}.jsonl`;
}
