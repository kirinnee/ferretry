import type { AgentLessonToolResult } from '@ferretry/protocol';

/**
 * How the daemon's own sentence is shown: verbatim. It already says what happened — filed, merged
 * into an existing lesson (now N×), or previously rejected — because the daemon is the one that
 * knows which, and a second rendering here could only repeat or contradict it.
 */
export function renderLessonSuggestion(result: AgentLessonToolResult): string {
  return result.summary;
}
