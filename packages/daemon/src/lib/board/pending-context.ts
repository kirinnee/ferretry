/**
 * The lead's PENDING CONTEXT (`board-design.md` §2.8): quiet board lines a ferret hears at the start of its
 * next turn, batched into one `[board] …` line. Appending never starts a turn and never interrupts.
 *
 * U5 (activity) owns the implementation; U7's `fy signal done` is a caller. Until U5 lands the daemon wires
 * {@link NoPendingContext} from `./stubs.ts`.
 */

/** One quiet line. `key` coalesces repeats (`F413:done`); `text` has no `[board] ` prefix. */
export interface QuietItem {
  readonly key: string;
  readonly text: string;
  readonly at: string;
}

export interface PendingContext {
  append(sessionId: string, items: readonly QuietItem[]): Promise<void>;
}
