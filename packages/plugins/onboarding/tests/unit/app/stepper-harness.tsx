/** A fake machine and storage for the stepper hook: answers the reads from a facts table, tells when a step changed. */
import { act } from 'react';
import { StepperView } from '../../../app/features/stepper/stepper-view.tsx';
import type { StepperStorage } from '../../../app/features/stepper/stepper-memory.ts';
import { useStepper } from '../../../app/features/stepper/use-stepper.ts';

type Held = {
  passkey?: boolean;
  name?: boolean;
  /** Every harness step of the onboarding (Claude Code, Codex) has been answered, not left pending. */
  setup?: boolean;
  /** A project is registered. */
  project?: boolean;
  /** A conversation was ever made (a project is not needed: the person works projectless). Off unless stated. */
  conversation?: boolean;
  /** Every ferret ever made is archived: the live list is empty, the archive is not. */
  archivedFerret?: boolean;
};

const answersFor = (held: Held): Record<string, unknown> => {
  const has = (key: keyof Held): boolean => held[key] !== false;
  return {
    'GET /v1/passkeys': { passkeys: has('passkey') ? [{ id: 'k' }] : [] },
    'GET /v1/config/file': { exists: has('name'), text: has('name') ? 'name: "Studio"\n' : '' },
    'GET /v1/onboarding': {
      steps: [
        { plugin: 'claude-code', id: 'harness', state: has('setup') ? 'done' : 'pending' },
        { plugin: 'codex', id: 'harness', state: has('setup') ? 'found' : 'pending' },
      ],
      complete: has('setup'),
    },
    'GET /v1/projects': has('project') ? [{ id: 'p' }] : [],
    'GET /v1/ferrets': held.conversation === true && held.archivedFerret !== true ? [{ id: 'f' }] : [],
    'GET /v1/archived-sessions': {
      count: held.conversation === true && held.archivedFerret === true ? 2 : 0,
      sessions: [],
    },
  };
};

export class StepperHarness {
  readonly storage: StepperStorage;
  #held: Held;
  #calls = 0;
  readonly #listeners = new Set<() => void>();
  readonly #silent: boolean;
  #holdPasskey: Promise<void> | undefined;
  #releasePasskey: () => void = () => undefined;

  private constructor(held: Held, storage: StepperStorage | undefined, silent: boolean) {
    this.#held = held;
    this.#silent = silent;
    const map = new Map<string, string>();
    this.storage = storage ?? {
      getItem: key => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
    };
  }

  static answering(held: Held, storage?: StepperStorage): StepperHarness {
    return new StepperHarness(held, storage, false);
  }

  /** A machine that has not answered yet (a reload's first frame). */
  static silent(storage: StepperStorage): StepperHarness {
    return new StepperHarness({}, storage, true);
  }

  calls = (): number => this.#calls;

  /** The passkey read answers only once `releasePasskey` is called (the others answer at once): a slow read among quick ones. */
  holdPasskey(): this {
    this.#holdPasskey = new Promise(resolve => {
      this.#releasePasskey = resolve;
    });
    return this;
  }

  releasePasskey(): void {
    this.#releasePasskey();
  }

  change(held: Held): void {
    this.#held = held;
    for (const listener of this.#listeners) listener();
  }

  async settle(): Promise<void> {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  }

  async dismiss(container: HTMLElement): Promise<void> {
    await act(async () => {
      container.querySelector<HTMLElement>('[data-first-run-stepper-dismiss]')?.click();
    });
  }

  readonly #client = {
    call: (async (route: string) => {
      this.#calls += 1;
      if (this.#silent) return await new Promise(() => undefined);
      if (route === 'GET /v1/passkeys') await this.#holdPasskey;
      return answersFor(this.#held)[route];
    }) as never,
    subscribe: ((_event: unknown, listener: () => void) => {
      this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    }) as never,
  };

  readonly Component = ({ locked = false }: { readonly locked?: boolean }): React.ReactNode => {
    const reading = useStepper(this.#client, 'd1', locked, () => this.storage);
    return reading.visible && reading.steps !== undefined ? (
      <StepperView onDismiss={reading.dismiss} steps={reading.steps} />
    ) : null;
  };
}
