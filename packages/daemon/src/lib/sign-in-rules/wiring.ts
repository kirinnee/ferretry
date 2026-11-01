import type { PasskeysChangedListener } from '../step-up/passkeys-changed.ts';
import type { RuleListing } from './drift.ts';
import type { SignInRuleService } from './service.ts';

/**
 * HOW THE DAEMON KEEPS THE RULES TOLD (docs/secrets.md, "Standing sign-in rules"): every committed account change, every
 * passkey change and every device revocation reaches the rule service, which suspends what no longer holds. The three
 * hooks are made here, in one call the composition root makes, so a test can prove each is connected.
 */

/** The account store, as it hands its committed listing to a follower. */
export interface SignInRuleAccountFollow {
  followRulesWith(follow: (after: RuleListing) => Promise<void>): void;
}

/** The passkeys-changed signal, as a listener subscribes. */
export interface SignInRulePasskeySignal {
  subscribe(listener: PasskeysChangedListener): () => void;
}

/**
 * THE RULES AS PAIRING PURGES A REVOKED DEVICE (`PairingService` `deviceState`). Pairing is built before the rules, so it
 * is handed this one first; {@link connectSignInRules} attaches the service. Before then, there is nothing to suspend.
 */
export class SignInRuleDevicePurge {
  #rules: SignInRuleService | undefined;

  attach(rules: SignInRuleService): void {
    this.#rules = rules;
  }

  async forgetDevice(deviceId: string): Promise<void> {
    await this.#rules?.forgetDevice(deviceId);
  }
}

/** Connects the rule service to the account store, the passkeys-changed signal and pairing's device purge. */
export function connectSignInRules(
  rules: SignInRuleService,
  hooks: {
    readonly accounts: SignInRuleAccountFollow;
    readonly passkeys: SignInRulePasskeySignal;
    readonly devices: SignInRuleDevicePurge;
  },
): void {
  hooks.accounts.followRulesWith(async after => await rules.accountsChanged(after));
  hooks.passkeys.subscribe(async change => await rules.passkeysChanged(change));
  hooks.devices.attach(rules);
}
