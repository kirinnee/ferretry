/**
 * A JUST-PAIRED MACHINE WITH STEPS TO LOOK AT OPENS ITS STEPS PAGE BY ITSELF: Onboarding's device view (shell contract
 * S3), mounted once at the frame root. Onboarding owns this decision; the shell only mounts the view.
 *
 * - "Just paired" is a machine that joins the paired list while this tab is open. The machines already paired when the
 *   view first draws were not paired just now and are never opened (a reload does not send anyone to a steps page).
 * - It reads that machine's steps once, through Onboarding's own client there. Any step not looked at yet (`pending`)
 *   opens the page; a machine with nothing pending, a locked one (nothing may prompt) and a failed read open nothing.
 * - The first run owns the screen it draws: while the person is on `/onboarding` the journey's own last stage (Open
 *   your fleet) is the way to the same page, so nothing moves under them.
 * - Each machine is decided once. Opening is a navigation, never a write: nothing is answered or recorded. It REPLACES
 *   the entry Access navigated to (v4 went to setup instead of home), so Back never lands on a second one.
 * - As v4 did, a machine that is already set up (the steps answer says `setUp`: it has a runtime) and has no recorded
 *   step answers is skipped. The daemon reads that fact from Runtimes; Runtimes off means `setUp: false`.
 */

import { type DeviceViewProps, useDevicePaired, useEveryDaemon, useOptionalRouter } from '@ferretry/app';
import { useEffect, useRef } from 'react';
import { onboardingScreen } from '../onboarding-screen.ts';
import { stepsHref } from './steps-screen.tsx';

/** The first run's screen id (the manifest's `onboarding` screen): the journey that owns the address while it is open. */
const FIRST_RUN_SCREEN = 'onboarding';

export function createStepsOpener() {
  return function StepsOpener({ navigate }: DeviceViewProps): null {
    const paired = useDevicePaired().daemons;
    const rows = useEveryDaemon();
    const route = useOptionalRouter()?.route;
    const onFirstRun =
      route?.kind === 'screen' && route.screen.plugin === 'onboarding' && route.screen.id === FIRST_RUN_SCREEN;
    // The machines paired before this view first drew, then the ones it has decided about.
    const before = useRef<ReadonlySet<string> | null>(null);
    before.current ??= new Set(paired.map(machine => machine.daemon));
    const decided = useRef(new Set<string>());
    const where = useRef(onFirstRun);
    where.current = onFirstRun;
    const go = useRef(navigate);
    go.current = navigate;
    useEffect(() => {
      for (const row of rows) {
        const fresh = !(before.current?.has(row.daemon) ?? true);
        if (!fresh || decided.current.has(row.daemon) || row.locked || !row.online) continue;
        if (!paired.some(machine => machine.daemon === row.daemon)) continue;
        decided.current.add(row.daemon);
        onboardingScreen(row.client)
          .load()
          .then(
            view => {
              if (where.current || !view.steps.some(step => step.state === 'pending')) return;
              // v4 skipped a set-up machine that has no step answers recorded (every step still `pending`).
              if (view.setUp && view.steps.every(step => step.state === 'pending')) return;
              go.current(stepsHref(row.daemon), { replace: true });
            },
            () => {
              // A machine that cannot say what is left opens nothing: the Setup tab is still the way there.
            },
          );
      }
    }, [paired, rows]);
    return null;
  };
}
