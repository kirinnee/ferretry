/**
 * THE PAGE'S HALF OF AN ONBOARDING STEP. The shell (the setup flow) draws one page at a time and hands it a `StepHost`
 * as `PanelProps.step`; the page tells the host what it decided and never imports the shell. The interface itself lives
 * in the kernel contract beside `OnboardingEntry` (the kernel's `PanelProps` carries it, and a contract may import only the
 * kernel leaf), and this file is where onboarding's own words about it are kept.
 *
 * What the shell guarantees, so no page can break the flow:
 *   1. A page mounts under a loading cover until it calls `ready()` or `skip()`; after {@link STEP_SILENCE_MS} of
 *      silence the cover offers "Skip this step", so a broken page never blocks.
 *   2. Conditions belong to the page: it reads its own plugin's routes and its `segment`, then `skip('not-needed')`.
 *   3. A client step already on the device's ledger is skipped before it mounts (`already-set`).
 *   4. `done()` on a daemon step POSTs `done`; on a client step it writes the device ledger. Nothing else does.
 */
export type { StepHost, StepSegmentMemory } from '@ferretry/kernel/contract';

/** How long a page may stay silent before the loading cover offers to skip it. */
export const STEP_SILENCE_MS = 10_000;

/** Why a page decided not to show. */
export type StepSkipWhy = 'not-needed' | 'already-set';

/** One thing a page told its host, in the order it told it (what `StepHarness` records). */
export type StepCall =
  | { readonly kind: 'ready' }
  | { readonly kind: 'skip'; readonly why: StepSkipWhy }
  | { readonly kind: 'done' }
  | { readonly kind: 'busy'; readonly label: string | null }
  | { readonly kind: 'remember'; readonly patch: Readonly<Record<string, string | number | boolean | undefined>> }
  | { readonly kind: 'next' }
  | { readonly kind: 'back' };

/** The key a client step has on the device ledger and in a panel's `subject`: `<plugin>.<stepId>`. */
export const clientStepKey = (plugin: string, step: string): string => `${plugin}.${step}`;
