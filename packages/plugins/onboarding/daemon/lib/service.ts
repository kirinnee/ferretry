/**
 * The OnboardingApi over the kernel ports: state through `StatePort`, time through `Clock`, redraws through `Events`.
 * Everything is injected; nothing here reads a clock or a file by itself.
 */
import type { Clock, EventsPort, OnboardingEntry, StatePort } from '@ferretry/kernel/contract';
import {
  ONBOARDING_PROGRESS,
  OnboardingChanged,
  type OnboardingApi,
  type OnboardingView,
  type Progress,
  type StepAnswerRequest,
  type StepView,
} from '../../contract/index.ts';
import { answeredKeys, EMPTY_PROGRESS, findEntry, joinProgress, splitStepKey, viewOf, withAnswer } from './steps.ts';

export interface OnboardingServiceDeps {
  /** The snapshot's steps, asked on every call: the snapshot is not frozen until the build ends. */
  readonly entries: () => readonly OnboardingEntry[];
  readonly state: StatePort;
  readonly clock: Clock;
  readonly events: EventsPort;
}

/** `progress.json` could not be read; the sentence is the store's own (§9.3). */
export class ProgressDamaged extends Error {
  constructor(readonly sentence: string) {
    super(sentence);
    this.name = 'ProgressDamaged';
  }
}

export class OnboardingService implements OnboardingApi {
  constructor(private readonly deps: OnboardingServiceDeps) {}

  async view(): Promise<OnboardingView> {
    return viewOf(this.deps.entries(), await this.#progress());
  }

  async answer(plugin: string, step: string, answer: StepAnswerRequest): Promise<StepView | undefined> {
    const entries = this.deps.entries();
    if (findEntry(entries, plugin, step) === undefined) return undefined;
    const at = this.deps.clock.now();
    const written = await this.deps.state.update(ONBOARDING_PROGRESS, current =>
      withAnswer(current, plugin, step, answer, at),
    );
    if (!written.ok) throw new ProgressDamaged(written.error.sentence);
    this.deps.events.publish(OnboardingChanged, { plugin, step });
    return joinProgress(entries, written.value).find(view => view.plugin === plugin && view.id === step);
  }

  async reset(): Promise<void> {
    const before = await this.#progress();
    await this.deps.state.write(ONBOARDING_PROGRESS, EMPTY_PROGRESS as Progress);
    for (const key of answeredKeys(before)) {
      const parts = splitStepKey(key);
      if (parts !== undefined) this.deps.events.publish(OnboardingChanged, parts);
    }
  }

  async #progress(): Promise<Progress | undefined> {
    const read = await this.deps.state.read(ONBOARDING_PROGRESS);
    if (!read.ok) throw new ProgressDamaged(read.error.sentence);
    return read.value;
  }
}
