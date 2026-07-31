/** The wire schema enforces the same ceiling; this exists to say *why* before a round trip. */
const MAX_TASK_TITLE_WORDS = 5;

export const TASK_TITLE_GUIDANCE =
  'Keep the task title to 5 words or fewer; move scope and implementation detail into the description.';

function taskTitleWordCount(title: string): number {
  const trimmed = title.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

/** A human-facing refusal for a title that is too long, or null when the title is fine. */
export function taskTitleIssue(title: string): string | null {
  const count = taskTitleWordCount(title);
  return count <= MAX_TASK_TITLE_WORDS ? null : `task title has ${count} words; ${TASK_TITLE_GUIDANCE}`;
}
