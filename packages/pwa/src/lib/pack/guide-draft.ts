/**
 * THE MODELS GUIDE WHILE IT IS BEING EDITED: a list of use cases, each with its candidates best first,
 * changed one step at a time — moved up or down, added, removed, a field replaced. Nothing here writes
 * a file; `pack-files.ts` does, from the finished list.
 *
 * Pure: every step answers a new list and leaves the old one as it was.
 */

import {
  type GuideCandidate,
  type GuideUseCase,
  MAX_GUIDE_CANDIDATES,
  MAX_GUIDE_USE_CASES,
  type PackFleetModel,
} from '@ferretry/protocol';

/** The list with the item at `index` moved by `delta`; unchanged when that would leave the list. */
export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): readonly T[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(index, 1) as [T];
  next.splice(target, 0, moved);
  return next;
}

export const replaceItem = <T>(items: readonly T[], index: number, item: T): readonly T[] =>
  items.map((current, at) => (at === index ? item : current));

export const removeItem = <T>(items: readonly T[], index: number): readonly T[] =>
  items.filter((_, at) => at !== index);

export const canAddUseCase = (useCases: readonly GuideUseCase[]): boolean => useCases.length < MAX_GUIDE_USE_CASES;
export const canAddCandidate = (useCase: GuideUseCase): boolean => useCase.candidates.length < MAX_GUIDE_CANDIDATES;

/** A new, empty use case with an id no other use case has. */
export function blankUseCase(useCases: readonly GuideUseCase[]): GuideUseCase {
  const taken = new Set(useCases.map(useCase => useCase.id));
  let number = useCases.length + 1;
  while (taken.has(`use-case-${number}`)) number += 1;
  return { id: `use-case-${number}`, title: 'New use case', description: '', candidates: [] };
}

export const BLANK_CANDIDATE: GuideCandidate = Object.freeze({ provider: '', model: '', why: '' });

/** The keywords as one comma-separated line, for a single text field. */
export const keywordsText = (keywords: readonly string[] | undefined): string => (keywords ?? []).join(', ');

/** A comma-separated line back into keywords; blanks dropped, so a trailing comma is harmless. */
export const parseKeywords = (text: string): readonly string[] =>
  text
    .split(',')
    .map(word => word.trim())
    .filter(word => word !== '');

/**
 * The candidate after its model is chosen from the fleet: the provider is that model's catalog, the
 * CLI is named only when the catalog lists the same id for both, and an effort the model does not
 * offer is dropped.
 */
export function candidateWithModel(
  candidate: GuideCandidate,
  model: PackFleetModel,
  models: readonly PackFleetModel[],
): GuideCandidate {
  const harnesses = new Set(
    models.filter(entry => entry.provider === model.provider && entry.id === model.id).map(entry => entry.harness),
  );
  const { harness: _harness, effort, ...rest } = candidate;
  return {
    ...rest,
    provider: model.provider,
    model: model.id,
    ...(harnesses.size > 1 ? { harness: model.harness } : {}),
    ...(effort !== undefined && model.efforts.includes(effort) ? { effort } : {}),
  };
}

/** Whether the edited guide differs from the one in effect. */
export const guideChanged = (draft: readonly GuideUseCase[], saved: readonly GuideUseCase[]): boolean =>
  JSON.stringify(draft) !== JSON.stringify(saved);
