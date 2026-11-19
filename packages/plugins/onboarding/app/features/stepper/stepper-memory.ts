/**
 * WHAT THIS DEVICE REMEMBERS OF ONE MACHINE'S STEPPER: the last facts it read, and whether the person dismissed it.
 *
 * The facts are kept ONLY so a reload draws the same stepper at once instead of popping in after the reads (one draw per
 * state); the machine's fresh answer replaces them as soon as it arrives, and nothing here is ever the reason a step is
 * done. A dismissal is the person's own and lasts until a step is open again (a new login removed, say): the stepper then
 * has something to say and says it. Damaged or foreign storage reads as nothing remembered.
 */
import { localKey } from '@ferretry/app';
import { STEP_IDS, type StepperFacts, UNKNOWN_FACTS } from './stepper-model.ts';

export interface StepperStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StepperRemembered {
  readonly facts: StepperFacts;
  readonly dismissed: boolean;
}

const FORMAT = 1;
export const stepperKey = (daemon: string): string => localKey('onboarding', 'stepper', daemon);

/** `localStorage`, or nothing: private modes throw on the property itself. */
export const browserStepperStorage = (): StepperStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: StepperStorage }).localStorage;
    return candidate !== undefined && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

const FACT_KEYS = STEP_IDS.filter((id): id is Exclude<(typeof STEP_IDS)[number], 'pair'> => id !== 'pair');
const isFact = (value: unknown): value is boolean | undefined => value === undefined || typeof value === 'boolean';

export const readStepperMemory = (
  storage: StepperStorage | undefined,
  daemon: string,
): StepperRemembered | undefined => {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(stepperKey(daemon));
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as { format?: unknown; facts?: Record<string, unknown>; dismissed?: unknown };
    if (parsed.format !== FORMAT || typeof parsed.facts !== 'object' || parsed.facts === null) return undefined;
    const facts = { ...UNKNOWN_FACTS } as { -readonly [K in keyof StepperFacts]: boolean | undefined };
    for (const key of FACT_KEYS) {
      const value = parsed.facts[key] ?? undefined;
      if (!isFact(value)) return undefined;
      facts[key] = value;
    }
    return { facts, dismissed: parsed.dismissed === true };
  } catch {
    return undefined;
  }
};

export const writeStepperMemory = (
  storage: StepperStorage | undefined,
  daemon: string,
  remembered: StepperRemembered,
): void => {
  if (storage === undefined) return;
  try {
    storage.setItem(
      stepperKey(daemon),
      JSON.stringify({ format: FORMAT, facts: remembered.facts, dismissed: remembered.dismissed }),
    );
  } catch {
    /* a full or refused store is an ordinary browser condition: the stepper simply starts blank next time */
  }
};
