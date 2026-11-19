/**
 * THE STEPPER'S STATE FOR ONE MACHINE: remembered facts at first (so a reload draws at once), the machine's own answers
 * folded in one fact at a time as each settles, a fresh batch only when a step changed on the machine, the person comes
 * back to the tab, or the machine locks or unlocks. No timer.
 *
 * ONLY THE LATEST BATCH COUNTS: starting a batch aborts the one before it, and an aborted batch is never heard again, so
 * an older answer (a locked read) can never overwrite a newer one (the same read after the unlock).
 *
 * WHEN IT SHOWS: only while a step is open. A machine that is already set up shows nothing at all, whatever this device
 * remembers; "This machine is set up" is said only to a device that saw the stepper open and then saw the last step done.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { onboardingScreen } from '../../onboarding-screen.ts';
import { readStepperFacts } from './stepper-facts.ts';
import {
  allDone,
  deriveSteps,
  hasOpenStep,
  type StepperFacts,
  type StepperStep,
  UNKNOWN_FACTS,
  withFact,
} from './stepper-model.ts';
import { browserStepperStorage, readStepperMemory, type StepperStorage, writeStepperMemory } from './stepper-memory.ts';

export interface StepperReading {
  /** `undefined` until something is known (nothing remembered, nothing read): nothing is drawn, so nothing pops in. */
  readonly steps: readonly StepperStep[] | undefined;
  /** Whether the stepper should be on screen at all. */
  readonly visible: boolean;
  readonly dismiss: () => void;
}

export function useStepper(
  client: Pick<PluginClient, 'call' | 'subscribe'>,
  daemon: string,
  locked: boolean,
  storage: () => StepperStorage | undefined = browserStepperStorage,
): StepperReading {
  const remembered = useMemo(() => readStepperMemory(storage(), daemon), [storage, daemon]);
  const [facts, setFacts] = useState<StepperFacts | undefined>(remembered?.facts);
  const [dismissed, setDismissed] = useState(remembered?.dismissed ?? false);
  const [seenOpen, setSeenOpen] = useState(remembered?.seenOpen ?? false);

  useEffect(() => {
    let batch: AbortController | undefined;
    const read = (): void => {
      batch?.abort();
      const mine = new AbortController();
      batch = mine;
      void readStepperFacts(client, locked, mine.signal, (key, fact) => {
        if (!mine.signal.aborted) setFacts(known => withFact(known ?? UNKNOWN_FACTS, key, fact));
      });
    };
    read();
    const stopSteps = onboardingScreen(client as PluginClient).subscribe(read);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      batch?.abort();
      stopSteps();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, locked]); // an unlock changes the passkey fact with no step changing on the machine

  const steps = useMemo(() => (facts === undefined ? undefined : deriveSteps(facts)), [facts]);
  // A step opening again ends an old dismissal: the stepper has something to say.
  const open = steps !== undefined && hasOpenStep(steps);
  useEffect(() => {
    if (facts === undefined) return;
    const effective = open ? false : dismissed;
    if (open && dismissed) setDismissed(false);
    if (open && !seenOpen) setSeenOpen(true);
    writeStepperMemory(storage(), daemon, { facts, dismissed: effective, seenOpen: seenOpen || open });
  }, [facts, dismissed, open, seenOpen, storage, daemon]);

  const dismiss = useCallback(() => setDismissed(true), []);
  const visible = steps !== undefined && (open || (allDone(steps) && seenOpen && !dismissed));
  return { steps, visible, dismiss };
}
