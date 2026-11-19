/**
 * The kinds of thing a harness's setup holds, one onboarding page each (owner: settings, model set, the instructions file,
 * skills, MCP). `kindGroups` answers what the scan found of ONE kind, from the same model the r9 wizard draws, so a page and the
 * wizard can never disagree about an id. Pure: names and ids only.
 */
import { type ImportItemId, importItemId } from '../../../contract/index.ts';
import { becomes } from './mapping-words.ts';
import type { FoundGroup, GroupKey, ToolModel } from './model.ts';

export const IMPORT_KINDS = ['settings', 'model-set', 'instructions', 'skills', 'mcp'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** The scan groups each kind is made of. Settings carries the environment keys with it (locked ones included). */
const GROUPS_OF: Readonly<Record<Exclude<ImportKind, 'model-set'>, readonly GroupKey[]>> = {
  settings: ['settings', 'env'],
  instructions: ['instructions'],
  skills: ['skill'],
  mcp: ['mcp'],
};

/**
 * What the scan found of one kind. The model set is derived from the settings (the models they name) and from Codex's
 * profiles (each one a model and an effort): it is offered as ONE item when settings were found, plus each Codex profile.
 */
export function kindGroups(model: ToolModel, kind: ImportKind): readonly FoundGroup[] {
  if (kind !== 'model-set') return model.groups.filter(group => GROUPS_OF[kind].includes(group.key));
  const derived: readonly FoundGroup[] = model.groups.some(group => group.key === 'settings')
    ? [
        {
          key: 'modelSet',
          title: 'Model set',
          items: [
            {
              id: importItemId(model.harness, 'model-set'),
              label: 'The models your settings name',
              becomes: becomes(model.harness, 'model-set'),
            },
          ],
        },
      ]
    : [];
  return [...derived, ...model.groups.filter(group => group.key === 'profile')];
}

/** Every id the person can tick on one kind's page. */
export const kindItemIds = (model: ToolModel, kind: ImportKind): readonly ImportItemId[] =>
  kindGroups(model, kind).flatMap(group => group.items.flatMap(item => (item.id === null ? [] : [item.id])));

/** Whether the scan found anything for a kind: a page with nothing to show skips itself. */
export const kindFound = (model: ToolModel, kind: ImportKind): boolean => kindItemIds(model, kind).length > 0;

/** The ids left out on one kind's page, for the skip list a page hands on: the kind's ids that are not ticked. */
export const kindSkips = (
  model: ToolModel,
  kind: ImportKind,
  ticked: ReadonlySet<ImportItemId>,
): readonly ImportItemId[] => kindItemIds(model, kind).filter(id => !ticked.has(id));
