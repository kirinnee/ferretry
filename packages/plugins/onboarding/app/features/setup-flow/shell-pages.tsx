/**
 * THE TWO PAGES ONBOARDING DRAWS ITSELF (the other plugins' pages are theirs): "Name this machine" (a daemon step) and
 * "Appearance" (a client step). Both are the shell's own pieces, reused whole so the settings and the first run never
 * disagree about what naming a machine or choosing a look does.
 */
import { DeviceAppearance, type NameDecision, NameThisMachine } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import { type ReactNode, useCallback, useEffect } from 'react';

/** The machine's name. A machine that already has one of the owner's skips the page; saving or skipping moves on. */
/** What the name step's decision means to the flow: asking shows the page, an already-named machine skips it, an answer moves on. */
export function routeNameDecision(step: StepHost, decision: NameDecision): void {
  if (decision === 'asking') step.ready();
  else if (decision === 'named') step.skip('already-set');
  else {
    step.done();
    step.next();
  }
}

/** The machine's name. A machine that already has one of the owner's skips the page; saving or skipping moves on. */
export function NamePage({
  daemon,
  step,
}: {
  readonly daemon: string;
  readonly step: StepHost | undefined;
}): ReactNode {
  const decided = useCallback(
    (decision: NameDecision): void => (step === undefined ? undefined : routeNameDecision(step, decision)),
    [step],
  );
  // The flow's own page title is "Name this machine", so the form draws no second one. A save in flight holds the footer: Next, Back and Later wait, so the page cannot be left under it.
  const working = useCallback((busy: boolean): void => step?.busy(busy ? 'Saving the name…' : null), [step]);
  return <NameThisMachine daemon={daemon} onDecided={decided} onBusy={working} heading={false} />;
}

/** Mode and theme tiles, the same component Settings › Appearance draws. */
export function AppearancePage({ step }: { readonly step: StepHost | undefined }): ReactNode {
  useEffect(() => step?.ready(), [step]);
  return <DeviceAppearance />;
}
