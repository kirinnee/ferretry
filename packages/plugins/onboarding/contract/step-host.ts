/**
 * THE PAGE'S HALF OF AN ONBOARDING STEP. The shell (the setup flow) draws one page at a time and hands it a `StepHost`
 * as `PanelProps.step`; the page tells the host what it decided and never imports the shell. The interface itself lives
 * in the kernel contract beside `OnboardingEntry` (the kernel's `PanelProps` carries it, and a contract may import only the
 * kernel leaf), and this file is where onboarding's own words about it are kept.
 *
 * What the shell guarantees, so no page can break the flow:
 *   1. A page mounts under a loading cover until it calls `ready()` or `skip()`; after {@link STEP_SILENCE_MS} of
 *      silence the cover offers "Skip this step", so a broken page never blocks.
 *      This holds for a step that declares `stepHost: true` in its manifest entry (its page is written against this host).
 *      A step that declares nothing is a LEGACY page, not yet written against `StepHost` (it never calls `ready()`): the
 *      shell draws it with no cover and Next enabled, and records done on Next (rule 5), so it is never trapped.
 *   2. Conditions belong to the page: it reads its own plugin's routes and its `segment`, then `skip('not-needed')`.
 *   3. A client step already on the device's ledger is skipped before it mounts (`already-set`).
 *   4. `done()` on a daemon step POSTs `done`; on a client step it writes the device ledger. Nothing else does.
 *   5. NEXT IS THE ANSWER (O4's one rule): when the person presses the shell's Next on a page that reported `ready()` but never
 *      called `done()`, the shell records the page's defaults as done (once; a page that already called `done()` is not
 *      recorded twice). A page therefore never has to call `done()` just to let Next work, and Next is never held back for
 *      want of a `done()`: only `ready()` (and a `busy()` act in flight) lock it. A page that must not be answered by
 *      default calls `skip()` instead, or holds the person with `busy()`. `Later` records `later` instead of `done`.
 *   6. THE SHELL OWNS THE FRAME (O4's one seam rule): the shell wraps every page in `StepPageFrame` (the title from the manifest,
 *      the segment progress, the Back / Next footer, the Later button, the loading cover and the "Only on <machine>" chip). A
 *      page returns ONLY its body (cards, a short list, a form, its own demo) and NEVER renders `StepPageFrame`, a title, a
 *      progress bar or Back/Next/Later buttons itself: a page that does would draw two frames and two footers. A page that
 *      needs the footer's state uses `busy()` / `next()` / `back()` / `skip()` on the host.
 *   7. `notNeeded()` IS A RUN-ONLY SKIP: "this page is not needed for THIS run, given the answers so far" (the plugin's
 *      segment memory). Unlike `skip()` it is NOT recorded on the machine while the run is going, it survives nothing (a
 *      reload starts with no marks and asks again), and the page is neither counted by the progress bar nor landed on. The
 *      run passes over a marked page in both directions: forward goes to the next page that is not marked, and Back goes to
 *      the last page actually shown. WHENEVER the plugin's segment memory changes (a `remember()` that alters a value),
 *      every mark of that plugin on the page on screen and the pages after it is cleared, so those pages are asked again and a
 *      page that is still not needed calls `notNeeded()` again when it mounts. A mark behind the page on screen stays (the run
 *      cannot go back to it without a change on an earlier page). That is why a page whose need depends on an answer the
 *      person can still revise (the import mode) calls `notNeeded()`, never `skip()`: a skip is persisted and final, so
 *      Back -> change the answer could never bring the page back. `skip()` stays for a fact nothing in the run can change.
 *      ONE write, at the END of the run: a machine step that was passed over and never asked since is recorded `skipped`
 *      then (a step left `pending` there reopens the first run on every later visit and keeps the machine incomplete). That
 *      write does not make the step answered in the run: Back -> change the answer -> Next still records `done` over it.
 *      WHEN IT IS HONOURED: `notNeeded()` is honoured ONLY when a page calls it on MOUNT, before it has drawn its own content
 *      (before any `ready()` or `busy(label)` in that visit): the page is passing over. A page that has been SHOWN (it drew a
 *      question or a chooser) can NEVER become not needed in that visit: the shell ignores the call, a selection on such a page
 *      changes local state and the segment memory only, and only its own footer Next moves on and records. A page that was shown
 *      always enters the Back trail, and a selection or tick (arrow keys included) never writes and never navigates. A page
 *      never draws a question only to hide or replace itself from the answer: it keeps drawing, and never calls `notNeeded()`
 *      from the answer. A page whose need rests on an answer the run no longer holds (the plugin's memory is empty after a
 *      reload) does not ask it again inside itself: it draws its ordinary page with every default ticked, and Next answers it
 *      like any other. "Not needed" therefore only ever follows an answer given earlier in the SAME unbroken run.
 *   8. NEXT SAVES THE CHOICE (r11 O1): a page that writes registers what Next must save with `commit(save)` (again whenever its
 *      pick changes; `commit(null)` clears it) INSTEAD of drawing its own Save / Use / Keep button. The shell's Next runs it
 *      under `busy('Saving…')`: resolved → `done()` is recorded and the flow moves on; rejected with an Error → the page
 *      stays, the error's message is shown on it, and Next stays enabled so pressing it again runs the save again. A page never
 *      calls `busy()` just to hold Next for a pending pick (rule 5: only `ready()` and an act in flight lock it). `Later`
 *      never runs the commit, and Back drops it: nothing is saved by leaving a page. A page with no commit behaves as before.
 *   9. A PAGE WITH ITS OWN ANSWER HOLDS NEXT: a page whose primary act is its own button (an import waiting for "Import", a GitHub
 *      page with nothing connected) calls `holdNext(true)`; the footer then draws no Next, so Back, Later and the page's own
 *      button are the only exits, and `holdNext(false)` (or leaving the page) brings Next back. It never disables Next: a hidden
 *      Next cannot be pressed past an answer the page did not name.
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
  | { readonly kind: 'notNeeded' }
  | { readonly kind: 'done' }
  | { readonly kind: 'busy'; readonly label: string | null }
  | { readonly kind: 'commit' }
  | { readonly kind: 'holdNext'; readonly held: boolean }
  | { readonly kind: 'remember'; readonly patch: Readonly<Record<string, string | number | boolean | undefined>> }
  | { readonly kind: 'next' }
  | { readonly kind: 'back' };

/** The key a client step has on the device ledger and in a panel's `subject`: `<plugin>.<stepId>`. */
export const clientStepKey = (plugin: string, step: string): string => `${plugin}.${step}`;
