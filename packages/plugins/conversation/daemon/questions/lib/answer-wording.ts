/**
 * Whether a request id has the shape the app minted before #771: `question:<daemon>:<session>:<tool>`,
 * one id per QUESTION. The current app adds a digest of the answer as a fifth part, so one id is one
 * answer. A stale app that re-sends a changed answer under its old id is refused as a reused id — and
 * the remedy for that is a reload, not anything about the answer.
 */
export function isQuestionScopedRequestId(requestId: string): boolean {
  return /^question:[^:]+:[^:]+:[^:]+$/u.test(requestId);
}

/**
 * For a multi-question form a drive stopped part-way through, before submitting it: nothing has reached
 * the agent, and the form is still open on the pane with what was answered so far. The person can send
 * the same answer again to resume it, or finish it in the Console.
 */
export function answerPaused(progress: { readonly stoppedAt: number; readonly answered: readonly boolean[] }): string {
  const total = progress.answered.length;
  const done = progress.answered.filter(Boolean).length;
  return `Stopped at question ${progress.stoppedAt + 1} of ${total} (${done} of ${total} answered). Nothing was sent yet and the form is still open: resume to answer the rest, or finish it in the Console tab.`;
}
