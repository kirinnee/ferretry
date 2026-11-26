/**
 * The address of the Add skills page and what rides on it. The path names the ferret; the ferret's place (folder,
 * harness, runtime, where its skills come from) rides in the query because it is not Catalogs' to read: the Skills tab
 * that opened the page knew it and handed it over (`skills.add`, Skills' contract/slots.ts).
 */

import { FerretSkillsInventorySchema, type SkillsAddSlotProps } from '@ferretry/plugin-skills/contract';
import { installHarnessOfKey } from '../../contract/wire/index.ts';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type SessionPlace, UNKNOWN_HARNESS } from '../features/add-skills/add-skills-model.ts';

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

/**
 * The harness an address names: the slot's harness key (`claude-code`) is the word an install target names (`claude`). None named
 * is no harness (the page picks the only one the machine runs, or asks); a key Catalogs has no layout for is `unknown`, which
 * is refused, never read as Claude.
 */
function harnessOf(key: string | null): Pick<SessionPlace, 'harness' | 'unsupportedKey'> {
  if (key === null || key === '') return { harness: undefined };
  const harness = installHarnessOfKey(key);
  return harness === undefined ? { harness: UNKNOWN_HARNESS, unsupportedKey: key } : { harness };
}

/** The place a query names. */
export function readPlace(search: string): AddSkillsPlace {
  const query = new URLSearchParams(search);
  const folder = query.get('folder');
  return {
    cwd: folder === null || folder === '' ? undefined : folder,
    ...harnessOf(query.get('harness')),
    runtime: query.get('runtime') ?? undefined,
    scopes: (query.get('scopes') ?? '').split(',').filter(scope => scope !== ''),
  };
}

const FERRET_INVENTORY_ROUTE = 'GET /v1/ferrets/:ferretId/skills/inventory' as const;

/**
 * The query for a ferret whose place nobody handed over (the Actions menu knows the ferret, not where it works): Skills'
 * own read of what that ferret sees. A daemon that will not say leaves the page to its defaults (no folder, no harness).
 */
export async function placeQueryOfFerret(client: Pick<PluginClient, 'call'>, ferret: string): Promise<string> {
  try {
    const inventory = FerretSkillsInventorySchema.parse(
      await client.call(FERRET_INVENTORY_ROUTE, { params: { ferretId: ferret } }),
    );
    return placeQuery({
      ferret,
      folder: inventory.folder,
      harness: inventory.harness,
      ...(inventory.runtime === undefined ? {} : { runtime: inventory.runtime }),
      scopes: [...new Set(inventory.skills.map(skill => skill.scope))],
    });
  } catch {
    return '';
  }
}
