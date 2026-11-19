/**
 * THE STEPPER'S STATE FOR ONE MACHINE: remembered facts at first (so a reload draws at once), the machine's own answer
 * behind them, a re-read only when a step changed on the machine or the person comes back to the tab. No timer.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { onboardingScreen } from '../../onboarding-screen.ts';
import { readStepperFacts } from './stepper-facts.ts';
import { allDone, deriveSteps, hasOpenStep, type StepperFacts, type StepperStep } from './stepper-model.ts';
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

  const read = useCallback(() => {
    void readStepperFacts(client, locked).then(next => {
      setFacts(next);
    });
  }, [client, locked]); // an unlock changes the passkey fact with no step changing on the machine

  useEffect(() => {
    read();
    const stopSteps = onboardingScreen(client as PluginClient).subscribe(read);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopSteps();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [client, read]);

  const steps = useMemo(() => (facts === undefined ? undefined : deriveSteps(facts)), [facts]);
  // A step opening again ends an old dismissal: the stepper has something to say.
  const open = steps !== undefined && hasOpenStep(steps);
  useEffect(() => {
    if (facts === undefined) return;
    const effective = open ? false : dismissed;
    if (open && dismissed) setDismissed(false);
    writeStepperMemory(storage(), daemon, { facts, dismissed: effective });
  }, [facts, dismissed, open, storage, daemon]);

  const dismiss = useCallback(() => setDismissed(true), []);
  const visible = steps !== undefined && (open || (allDone(steps) && !dismissed));
  return { steps, visible, dismiss };
}
