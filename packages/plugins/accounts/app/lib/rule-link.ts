/**
 * THE APPROVAL A `#rules/<stage>` LINK OPENS (`ruleDeepLink`, printed by `fy rules add`), between the two places that
 * handle it: Accounts' device view, which the shell hands the fragment (shell contract S3) and which sends the page to
 * one machine's Secure copy tab, and that machine's Standing sign-in rules list, which highlights the row once it has
 * read the daemon's list. A link only picks WHICH row to show: it never reaches the daemon and never asks for a passkey;
 * the owner still taps Confirm on the row.
 *
 * One hold is made per app half (a bundle-level singleton in `../index.ts`) and handed to both views by construction; it keeps only the latest link.
 */

import type { SignInRuleStageId } from '../../contract/routes/index.ts';

/** A link whose stage the daemon no longer lists. */
export const RULE_LINKED_STAGE_GONE_WORDS = 'That approval timed out or was already answered.';

/** A `#rules/<stage>?machine=…` link for a machine this device is not paired with. */
export const RULE_LINKED_ELSEWHERE_WORDS =
  'That approval is not on this machine. Open the link on a device paired with the machine that asked.';

interface Held {
  readonly stage: SignInRuleStageId;
  readonly daemon: string;
}

export class RuleLinkHold {
  #held: Held | null = null;
  readonly #listeners = new Set<() => void>();

  /** The device view sent the page to `daemon`'s Secure copy tab for `stage` (replacing any earlier link). */
  hold(stage: SignInRuleStageId, daemon: string): void {
    this.#held = { stage, daemon };
    this.#notify();
  }

  /** The stage waiting for `daemon`'s list, if the link was sent there. */
  stageFor = (daemon: string | undefined): SignInRuleStageId | undefined =>
    this.#held !== null && this.#held.daemon === daemon ? this.#held.stage : undefined;

  /** `daemon`'s list has read the link: it is spent. */
  settle(daemon: string | undefined): void {
    if (this.#held === null || this.#held.daemon !== daemon) return;
    this.#held = null;
    this.#notify();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
