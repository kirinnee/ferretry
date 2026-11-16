import type { FerretSummary } from '../../contract/index.ts';
import { displayCallsign } from './callsign.ts';

/** The fields a ferret's two names are made from. */
export type TitledFerret = Pick<FerretSummary, 'id' | 'name' | 'folder' | 'title'>;

/** The last segment of a folder path, whichever separator it uses. */
const baseName = (path: string): string =>
  path
    .split(/[\\/]/u)
    .filter(part => part !== '')
    .at(-1) ?? '';

/**
 * THE TASK A FERRET WAS GIVEN, or `''` when it has none. Ferrets keeps the task title beside the record (`title`); a
 * ferret started without one has none, and its callsign is not a task.
 */
export const ferretTask = (ferret: Pick<FerretSummary, 'title'>): string => (ferret.title ?? '').trim();

/**
 * A ferret's two names. With a task: the task, over the ferret. With none: the folder it works in, the closest thing it
 * has to a subject, over the ferret, else the ferret alone.
 */
export const ferretTitles = (ferret: TitledFerret): { readonly title: string; readonly ferret: string | null } => {
  const callsign = displayCallsign(ferret.name);
  const task = ferretTask(ferret);
  if (task !== '' && task !== callsign) return { title: task, ferret: callsign === '' ? null : callsign };
  const folder = baseName(ferret.folder);
  if (folder !== '') return { title: folder, ferret: callsign === '' ? null : callsign };
  return { title: callsign || ferret.id, ferret: null };
};

/** The one-line name for a sentence or an accessible label: the title, nothing else. */
export const ferretLabel = (ferret: TitledFerret): string => ferretTitles(ferret).title;
