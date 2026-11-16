/**
 * TEST FIXTURE: the two types of today's `packages/daemon/src/lib/session/harness/cleanup.ts` (owners:
 * claude-code+codex) the fixture's quirk service reads. The cleanup itself drives a pane and is not copied: the tests
 * hand the service a cleanup that answers whatever they want.
 */
export type PickerCleanupOutcome =
  /** The pane is provably back at an idle prompt. */
  | { readonly kind: 'settled' }
  /** The pane cannot be confirmed idle. The caller must quarantine the session. */
  | { readonly kind: 'unconfirmed'; readonly reason: string };

/** The one call the quirk service makes of today's `CodexPickerCleanup`. */
export interface CodexPickerCleanup {
  dismiss(session: string): Promise<PickerCleanupOutcome>;
}
