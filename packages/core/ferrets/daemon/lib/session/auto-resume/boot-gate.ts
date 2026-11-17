/**
 * The ready signal between the auto-resume boot pass and the turn watch's vanished-pane observers.
 *
 * Only a settle the boot pass lands is recorded as owed an auto-resume (the boot exit recorder), so a ferret the sweep (or
 * a look's failure notice) settled `terminal_gone` FIRST would be stopped and never resumed. The observers therefore stay
 * quiet until the pass has closed its recorder: they may be registered early (so a slow registry load does not leave the
 * sweep not existing), but none of their ticks settles anything before that.
 *
 * One object, opened once, and opened for good: a pass that fails, or has nothing to do, opens it too, so a daemon whose
 * pass stopped early still gets its sweep. Opening twice is the same as once.
 */
export class BootPassGate {
  private closedRecorder = false;

  /** Whether the boot pass has closed its recorder: the observers' ticks may settle from now on. */
  get open(): boolean {
    return this.closedRecorder;
  }

  /** The boot pass closed its recorder (or ended without one). */
  release(): void {
    this.closedRecorder = true;
  }
}

/** The ONE gate of this daemon, made by whichever of the two features registers first and shared through `late`. */
export function sharedBootPass(late: { bootPass?: BootPassGate }): BootPassGate {
  const shared = late.bootPass ?? new BootPassGate();
  late.bootPass = shared;
  return shared;
}
