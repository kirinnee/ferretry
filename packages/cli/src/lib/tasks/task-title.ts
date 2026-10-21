import { briefFileReference, deriveTaskTitle } from '@ferretry/protocol';

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

/**
 * The title a delegated brief earns from the file it points at ("Read /tmp/brief.md and follow it"),
 * when the brief itself is only that pointer. `undefined` when the brief names work itself, points at
 * nothing, or the file cannot be read — the daemon then titles it from the brief or a labelled hash.
 */
export async function titleFromReferencedBrief(
  brief: string,
  read: (path: string) => Promise<string>,
): Promise<string | undefined> {
  if (deriveTaskTitle(brief) !== null) return undefined;
  const path = briefFileReference(brief);
  if (path === null) return undefined;
  try {
    return deriveTaskTitle(await read(path)) ?? undefined;
  } catch {
    return undefined;
  }
}
