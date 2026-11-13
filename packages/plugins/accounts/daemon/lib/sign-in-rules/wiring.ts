import type { DevicesChanged } from '@ferretry/plugin-access/contract';
import type { PayloadOf } from '@ferretry/kernel/contract';
import type { PasskeysChangedListener } from '../local-ports.ts';
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

/** What Access publishes when a device changes (its contract's `DevicesChanged`). */
export type DevicesChangedPayload = PayloadOf<typeof DevicesChanged>;

/**
 * A PAIRED DEVICE WAS REVOKED OR IDLE-EXPIRED (Access's `DevicesChanged`, lead decision for 5.0; today's pairing
 * `deviceState` purge and the passkeys-changed signal after it): every rule that device approved is suspended, and every
 * kept proof is checked again against the registry as it stands. EVERY PURGE IS ATTEMPTED even when an earlier one
 * fails, and a failure is reported, never thrown back into Access's revocation.
 */
export function onDevicesChanged(
  rules: Pick<SignInRuleService, 'forgetDevice' | 'passkeysChanged'>,
  failed: (error: unknown) => void = () => undefined,
): (payload: DevicesChangedPayload) => Promise<void> {
  return async ({ device, change }) => {
    if (change !== 'revoked' && change !== 'expired') return;
    await rules.forgetDevice(device).catch(failed);
    await rules.passkeysChanged({ cause: 'device-forgotten', deviceId: device }).catch(failed);
  };
}

/**
 * Owner decision !A226: this build offers standing rules for sudo, su and doas (today's `sign-in-rules-terminal.1`
 * feature beside `sign-in-rules.1`). There is no feature list in 5.0, so the composition root passes
 * `terminalRules: () => TERMINAL_RULES_OFFERED` to the rule service, the suggestions and the fills.
 */
export const TERMINAL_RULES_OFFERED = true;
