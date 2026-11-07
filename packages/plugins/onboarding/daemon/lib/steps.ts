/**
 * The first run's step list, pure (§6.1). A step is manifest metadata read from the post-build snapshot; this file
 * orders them, joins them with where each stands in `progress.json`, and says whether the run is complete.
 */
import type { OnboardingEntry } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import type { OnboardingView, Progress, StepAnswerRequest, StepState, StepView } from '../../contract/index.ts';

/** A step is stored as `<plugin>:<id>`. */
export const stepKey = (plugin: string, id: string): string => `${plugin}:${id}`;

export const EMPTY_PROGRESS: Progress = Object.freeze({ format: 1, steps: Object.freeze({}) });

/** By `order`, then plugin, then id: two steps with the same `order` never swap between reads. */
export function orderedSteps(entries: readonly OnboardingEntry[]): readonly OnboardingEntry[] {
  return [...entries].sort((a, b) => a.order - b.order || a.plugin.localeCompare(b.plugin) || a.id.localeCompare(b.id));
}

/** The snapshot's steps in order, each with its recorded state (`pending` when nothing was recorded). */
export function joinProgress(entries: readonly OnboardingEntry[], progress: Progress | undefined): readonly StepView[] {
  const recorded = progress?.steps ?? {};
  return orderedSteps(entries).map((entry): StepView => {
    const known = recorded[stepKey(entry.plugin, entry.id)];
    return {
      plugin: entry.plugin,
      id: entry.id,
      title: entry.title,
      order: entry.order,
      state: known?.state ?? 'pending',
      ...(known === undefined ? {} : { at: known.at }),
    };
  });
}

/** Complete = none pending. No steps at all is complete: there is nothing left to ask. */
export const isComplete = (steps: readonly StepView[]): boolean => steps.every(step => step.state !== 'pending');

export function viewOf(entries: readonly OnboardingEntry[], progress: Progress | undefined): OnboardingView {
  const steps = joinProgress(entries, progress);
  return { steps: [...steps], complete: isComplete(steps) };
}

export function findEntry(
  entries: readonly OnboardingEntry[],
  plugin: string,
  id: string,
): OnboardingEntry | undefined {
  return entries.find(entry => entry.plugin === plugin && entry.id === id);
}

/** `progress` with one step's answer recorded at `at`. Does not touch the other steps. */
export function withAnswer(
  progress: Progress | undefined,
  plugin: string,
  id: string,
  answer: StepAnswerRequest,
  at: Instant,
): Progress {
  return { format: 1, steps: { ...(progress?.steps ?? {}), [stepKey(plugin, id)]: { state: answer.state, at } } };
}

/** The keys of the steps that stand anywhere but `pending`: the ones a reset changes. */
export function answeredKeys(progress: Progress | undefined): readonly string[] {
  return Object.entries(progress?.steps ?? {})
    .filter(([, step]) => (step.state as StepState) !== 'pending')
    .map(([key]) => key);
}

/** Splits a stored key back into the plugin and the step id (both are lowercase slugs: no `:` inside). */
export function splitStepKey(key: string): { readonly plugin: string; readonly step: string } | undefined {
  const at = key.indexOf(':');
  return at <= 0 || at === key.length - 1 ? undefined : { plugin: key.slice(0, at), step: key.slice(at + 1) };
}
