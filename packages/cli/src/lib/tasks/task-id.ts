import { type TaskId, TaskIdSchema } from '@ferretry/protocol';
import { refuse } from './errors';

/**
 * `#F12`, `&f12` and ` f12 ` all name the same task; `F12` is the canonical wire form.
 * Returns null rather than throwing so callers can phrase their own refusal.
 */
function normalizeTaskId(value: string): TaskId | null {
  const candidate = value.trim().replace(/^[#&]/u, '').toUpperCase();
  const parsed = TaskIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Normalize an id supplied on the command line, refusing with the shape the user should have typed. */
export function requireTaskId(value: string, label = 'task id'): TaskId {
  const id = normalizeTaskId(value);
  return id ?? refuse(`expected a ${label} like F21, got "${value}"`);
}

/** How a task is cited in prose, terminal output and markdown. */
export function taskReference(id: string): string {
  return `#${id}`;
}
