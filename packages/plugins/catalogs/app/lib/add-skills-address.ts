/**
 * The address of the Add skills page and what rides on it. The path names the ferret; the ferret's place (folder,
 * harness, runtime, where its skills come from) rides in the query because it is not Catalogs' to read: the Skills tab
 * that opened the page knew it and handed it over (`skills.add`, Skills' contract/slots.ts).
 */

import type { SkillsAddSlotProps } from '@ferretry/plugin-skills/contract';
import type { SessionPlace } from '../features/add-skills/add-skills-model.ts';

export interface AddSkillsPlace extends SessionPlace {
  /** Where the skills the ferret sees come from. */
  readonly scopes: readonly string[];
}

/** The query that carries the slot's props to the page. */
export function placeQuery(props: SkillsAddSlotProps): string {
  const query = new URLSearchParams({ folder: props.folder, harness: props.harness, scopes: props.scopes.join(',') });
  if (props.runtime !== undefined) query.set('runtime', props.runtime);
  return `?${query.toString()}`;
}

/** The place a query names; the slot's `claude-code` is the `claude` an install target names, and anything else reads as it. */
export function readPlace(search: string): AddSkillsPlace {
  const query = new URLSearchParams(search);
  const folder = query.get('folder');
  return {
    cwd: folder === null || folder === '' ? undefined : folder,
    harness: query.get('harness') === 'codex' ? 'codex' : 'claude',
    runtime: query.get('runtime') ?? undefined,
    scopes: (query.get('scopes') ?? '').split(',').filter(scope => scope !== ''),
  };
}
