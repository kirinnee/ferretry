/**
 * A FERRET'S TWO NAMES, as every Agenda row draws them (copied from today's `shell/session-title.ts` and
 * `shell/sessions-bar-model.ts`): with a task, the task over the ferret's callsign; with none, the folder it works in
 * over the callsign, else the callsign alone. And the Interactive / Agents filter over them. Pure.
 */

import type { FerretView } from './ferret-view.ts';
import { displayCallsign, parseTaskName } from '../shell.ts';

type TitledConfig = Pick<FerretView['config'], 'name' | 'cwd' | 'teammate' | 'id'>;

/** The last segment of a folder path. */
const baseName = (path: string): string => path.replace(/\/+$/u, '').split('/').pop() ?? '';

/** THE TASK A FERRET WAS GIVEN, or `''` when it has none. */
const sessionTask = (name?: string | null): string => parseTaskName(name).task;

/** A ferret's two names: the task (else its folder, else its callsign) over the callsign. */
const sessionTitles = (config: TitledConfig): { readonly title: string; readonly ferret: string | null } => {
  const callsign = displayCallsign(config.teammate);
  const task = sessionTask(config.name);
  if (task !== '' && task !== callsign) return { title: task, ferret: callsign === '' ? null : callsign };
  const folder = config.cwd ? baseName(config.cwd) : '';
  if (folder !== '') return { title: folder, ferret: callsign === '' ? null : callsign };
  return { title: callsign || config.id, ferret: null };
};

/** A row's two names. */
export const sessionsBarNames = (view: FerretView): { readonly title: string; readonly ferret: string | null } =>
  sessionTitles(view.config);

/** Which ferrets a list shows: all, the owner's interactive ones, or the agents. */
export type ModeFilter = 'all' | 'interactive' | 'auto';

export const matchesMode = (view: FerretView, mode: ModeFilter): boolean => mode === 'all' || view.config.mode === mode;
