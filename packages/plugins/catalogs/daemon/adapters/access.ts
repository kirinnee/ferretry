import type { AccessApi } from '@ferretry/plugin-access/contract';
import type { PasskeyVerifierPort } from '../lib/member-passkeys/types.ts';

/** Today's verifier verdict was flat; Access's contract wraps the same facts in `value`. */
export function memberVerifier(access: AccessApi): PasskeyVerifierPort {
  return {
    async verifyRegistration(input) {
      const verdict = await access.passkeys.verifyRegistration(input);
      return verdict.ok ? { ok: true, ...verdict.value } : verdict;
    },
    async verifyAssertion(input) {
      // TODO(Access contract): the parity port includes -8 as well as -7/-257 (approved, already on port-access).
      const verdict = await access.passkeys.verifyAssertion(
        input as Parameters<AccessApi['passkeys']['verifyAssertion']>[0],
      );
      return verdict.ok ? { ok: true, ...verdict.value } : verdict;
    },
  };
}
