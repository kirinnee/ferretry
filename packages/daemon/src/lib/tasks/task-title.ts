export const MAX_TASK_TITLE_WORDS = 5;

export const TASK_TITLE_GUIDANCE =
  'Keep the task title to 5 words or fewer; move scope and implementation detail into the description.';

export const taskTitleWordCount = (title: string): number => {
  const trimmed = title.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
};

/** Returns a human-facing creation error, or null when the title is short enough. */
export const taskTitleIssue = (title: string): string | null => {
  const count = taskTitleWordCount(title);
  return count <= MAX_TASK_TITLE_WORDS ? null : `task title has ${count} words; ${TASK_TITLE_GUIDANCE}`;
};
