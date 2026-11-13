import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { InputTarget, InputTargetFacts } from './targets.ts';

/**
 * SECURE COPY, as the Vault sees it (docs/secure-copy.md). The Vault owns how a paste is asked and delivered (an input
 * request whose value comes from a handle: the card, the observed destination, the one guarded write); ACCOUNTS owns the
 * copies themselves and the owner's pre-approval rules. So the dependency is inverted, as for the phone approval: the
 * Vault declares the hook below, Accounts PROVIDES it, and the Vault never imports Accounts. No provider bound: no
 * copy exists, a paste is refused ("there is no live copy"), and no rule matches (every paste asks the owner).
 *
 * THE VALUE CROSSES THIS SEAM ONCE, in {@link SecureCopyProvider.open}: called at the write, after every check that can
 * refuse without typing, and its answer goes only to the target's `type`. It is the one place a copy leaves Accounts.
 * Every other member answers facts, ids and sentences.
 *
 * What the Vault is told about a copy is parsed at the Vault's boundary against its own strict schema (`unknown` here),
 * so a provider that sent a field a ferret may not see would be refused rather than shown.
 */
export interface SecureCopyProvider {
  /** What the daemon recorded about a LIVE copy of this session (`CopyMeta`), or nothing: never the value. */
  describe(sessionId: string, name: string): unknown;
  /** The live copy's value, for the one write; nothing once it was discarded or expired. */
  open(sessionId: string, name: string): string | undefined;
  /** A paste of it was typed. */
  used(sessionId: string, name: string): void;
  /**
   * A sentence when this paste may not go to `target` now, or nothing: a person has taken the page over. Asked when the
   * paste is raised, and again right before the write, so a takeover that lands while the card waits ends the paste.
   */
  refusal(sessionId: string, name: string, target: InputTarget): Promise<string | undefined>;
  /**
   * The id of the owner's pre-approval rule that allows this paste, with its use TAKEN (so two pastes can never both
   * spend a rule's last use), or nothing: the owner is asked. `from` is the copy's origin as the daemon saw it.
   */
  reserve(sessionId: string, from: unknown, facts: InputTargetFacts, profile?: string): string | undefined;
  /** The paste a rule was reserved for was not typed: its use is given back. */
  release(ruleId: string): void;
  /** It was typed. */
  spent(ruleId: string): void;
}

/** The one key `input.secure-copy` is provided under. */
export const SECURE_COPY_KEY = 'copy' as const;

/** Provided by Accounts and nobody else (`takers`): a copy and the rules that pre-approve its paste are Accounts'. */
export const InputSecureCopies = defineHook('input.secure-copy', {
  mode: 'provide',
  key: z.literal(SECURE_COPY_KEY),
  value: z.custom<SecureCopyProvider>(),
  takers: ['accounts'],
});
