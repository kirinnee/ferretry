/** Claude's directory encoding, copied from daemon/src/lib/session/transcript/claude-path.ts. */
function claudeProjectDirectory(cwd: string): string {
  return cwd.replaceAll(/[^a-zA-Z0-9]/gu, '-');
}

/** The filename is the identity; never select a transcript by recency. */
export function claudeTranscriptPath(cwd: string, conversation: string): string {
  return `projects/${claudeProjectDirectory(cwd)}/${conversation}.jsonl`;
}

/** S45: a conversation id is one plain name at every boundary. */
export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value);
}
