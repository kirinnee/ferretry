/**
 * THE MODELS PANEL'S LIST: every model the fleet knows, found by a few words and grouped under the catalog
 * it comes from. Pure: models and a filter in, groups out.
 */

import type { PackFleetModel } from '@ferretry/protocol';

export interface ModelGroup {
  readonly provider: string;
  readonly label: string;
  readonly models: readonly PackFleetModel[];
}

const searchable = (model: PackFleetModel): string =>
  [model.label, model.id, model.provider, model.providerLabel, model.harness, model.description ?? '']
    .join('\n')
    .toLocaleLowerCase();

/** Whether every word of `filter` appears somewhere in the model's names or description. */
export const modelMatches = (model: PackFleetModel, filter: string): boolean => {
  const words = filter.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const haystack = searchable(model);
  return words.every(word => haystack.includes(word));
};

/** The models that match, grouped by catalog in the order each catalog first appears. */
export function groupModels(models: readonly PackFleetModel[], filter: string): readonly ModelGroup[] {
  const groups = new Map<string, { label: string; models: PackFleetModel[] }>();
  for (const model of models) {
    if (!modelMatches(model, filter)) continue;
    const group = groups.get(model.provider) ?? { label: model.providerLabel, models: [] };
    group.models.push(model);
    groups.set(model.provider, group);
  }
  return [...groups].map(([provider, group]) => ({ provider, label: group.label, models: group.models }));
}

/** A model's key in a list: the same id under two CLIs is two rows. */
export const modelRowKey = (model: PackFleetModel): string =>
  `${model.provider}\u0000${model.harness}\u0000${model.id}`;

/** A description belongs to the catalog and the id, whatever CLI runs it. */
export const descriptionKey = (model: PackFleetModel): string => `${model.provider}\u0000${model.id}`;
