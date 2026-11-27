/**
 * PROJECT SETUP SURVIVES A RELAUNCH (C59 O8-13). The setup flow's last page ("Add your projects") is a device page: a person
 * who leaves it without answering (closes the tab, loses the connection) must land back on it when the app is opened again,
 * until they press Next (the device ledger holds it) or Skip for now (the device's later list holds it).
 *
 * The one fact that is new is "this device was SHOWN project setup, for this machine". It is kept in the existing device
 * ledger (`../../lib/client-ledger.ts`) as one more step key, `onboarding.project-setup`, so there is no second store: its
 * `daemons` say which machine to resume on. It is written only when the page is truly drawn (never for a machine that already
 * has a project: that page passes over before it draws), so a machine that was never asked is never sent back to it.
 */
import { clientStepKey } from '../../../contract/step-host.ts';
import { type Instant } from '@ferretry/std';
import { type LedgerStorage, readLedger, recordClientStep } from '../../lib/index.ts';
import { readLater } from './client-later.ts';

/** The page that is the flow's last: `<plugin>.<step>`. */
export const PROJECT_SETUP_STEP = 'projects.folders';

/**
 * The folders the person picked on the project page but never saved are kept in this browser's storage, one draft per machine
 * (projects' `folders-step.tsx` owns the key and the format). Skip for now and the end of the run end the draft: it is removed
 * here, without reading it, so a later run on this machine starts with no leftover paths.
 */
export const forgetProjectDraft = (storage: LedgerStorage | undefined, daemon: string): void => {
  try {
    storage?.removeItem?.(`fy.projects.setup-folders.${daemon}`);
  } catch {
    // Storage that refuses leaves the draft where it is.
  }
};

/** The ledger entry that says project setup was shown (`onboarding.project-setup`). */
const SHOWN = { plugin: 'onboarding', step: 'project-setup' } as const;

/** Records that project setup was drawn for `daemon` on this device. False when storage refuses. */
export const markProjectSetupShown = (storage: LedgerStorage | undefined, daemon: string, at: Instant): boolean =>
  recordClientStep(storage, SHOWN.plugin, SHOWN.step, daemon, at);

/**
 * The machine whose project setup this device left unfinished, or undefined: it was shown, and was neither answered
 * (Next: on the ledger) nor skipped (Skip for now: on the later list).
 */
export function unfinishedProjectSetup(storage: LedgerStorage | undefined): string | undefined {
  const steps = readLedger(storage).steps;
  const shown = steps[clientStepKey(SHOWN.plugin, SHOWN.step)];
  if (shown === undefined) return undefined;
  if (Object.hasOwn(steps, PROJECT_SETUP_STEP) || readLater(storage).has(PROJECT_SETUP_STEP)) return undefined;
  return shown.daemons.at(-1);
}
