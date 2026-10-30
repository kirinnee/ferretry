import { isPlaceholderSessionName, type SessionView } from '@ferretry/protocol';
import { displayCallsign } from '../lib/callsign.ts';
import { baseName } from '../lib/fleet-grouping.ts';
import { parseTaskName } from './task-name.ts';

type TitledConfig = Pick<SessionView['config'], 'name' | 'cwd' | 'teammate' | 'id'>;

/**
 * THE TASK A SESSION WAS GIVEN, or `''` when it has none. The daemon names an unnamed interactive session
 * with the bare mode word until a card or a first message titles it; that word says nothing about the work,
 * so it is no task. The daemon owns the title (its card, else its first message); this only refuses the
 * placeholder.
 */
export const sessionTask = (name?: string | null): string =>
  isPlaceholderSessionName(name ?? '') ? '' : parseTaskName(name).task;

/**
 * A session's two names. With a task: the task, over the ferret. With none: the folder it works in — the
 * closest thing it has to a subject — over the ferret, else the ferret alone. NEVER the mode word.
 */
export const sessionTitles = (config: TitledConfig): { readonly title: string; readonly ferret: string | null } => {
  const callsign = displayCallsign(config.teammate);
  const task = sessionTask(config.name);
  if (task !== '' && task !== callsign) return { title: task, ferret: callsign === '' ? null : callsign };
  const folder = config.cwd ? baseName(config.cwd) : '';
  if (folder !== '') return { title: folder, ferret: callsign === '' ? null : callsign };
  return { title: callsign || config.id, ferret: null };
};

/** The one-line name for a sentence or an accessible label: the title, nothing else. */
export const sessionLabel = (config: TitledConfig): string => sessionTitles(config).title;
