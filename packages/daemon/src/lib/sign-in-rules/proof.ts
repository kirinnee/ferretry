import {
  canonicalSignInRule,
  type SignInRuleBody,
  type SignInRuleProof,
  type SignInRuleStageId,
  type StoredStepUpProof,
  signInRuleChallenge,
  signInRuleSubject,
} from '@ferretry/protocol';

/**
 * A STORED RULE'S PROOF, CHECKED OFFLINE (docs/design/zero-trust.md, "Stored passkey proofs"). The challenge is never
 * read from the record: it is DERIVED again from the body's canonical bytes, the stage and the nonce, so a body edited
 * on disk, or a proof copied onto other bytes, derives another challenge and fails the signature check.
 */

/** The registry, as a rule's proof is checked against it. */
export interface SignInRuleProofPort {
  /**
   * Whether the passkey registry still holds `credentialId` for `deviceId`. Rejects when it cannot tell. `false`
   * means the passkey that approved the rule is gone (its device was forgotten, or the passkey was removed).
   */
  holds(deviceId: string, credentialId: string): Promise<boolean>;
  /**
   * `StepUpService.verifyStoredProof`: the device must still be PAIRED, then every WebAuthn check but the counter, at the
   * passkey's own origin, against the challenge handed in. Rejects when the registry cannot be read.
   */
  verify(proof: StoredStepUpProof, expectedChallenge: Uint8Array): Promise<boolean>;
}

/** What a check found: it holds, the approving passkey or device is gone, it does not verify, or nobody could tell. */
export type SignInRuleProofCheck = 'ok' | 'passkey-removed' | 'proof-invalid' | 'unknown';

/**
 * The challenge an `approve-sign-in-rule` passkey for this body, at this stage and nonce, was (or must be) made over:
 * `signInRuleChallenge(nonce, signInRuleSubject(stage, canonicalSignInRule(body)))`. `undefined` when any part is not
 * well formed: nothing is ever derived from a body that does not parse or a nonce never drawn.
 */
export function ruleChallenge(body: SignInRuleBody, stage: SignInRuleStageId, nonce: string): Uint8Array | undefined {
  const canonical = canonicalSignInRule(body);
  if (!canonical.ok) return undefined;
  try {
    return signInRuleChallenge(nonce, signInRuleSubject(stage, canonical.text));
  } catch {
    return undefined;
  }
}

/** The assertion alone, as the step-up service checks it: the record's proof without its stage and nonce. */
export function assertionOf(proof: SignInRuleProof): StoredStepUpProof {
  return {
    deviceId: proof.deviceId,
    credentialId: proof.credentialId,
    clientDataJSON: proof.clientDataJSON,
    authenticatorData: proof.authenticatorData,
    signature: proof.signature,
  };
}

/**
 * ONE RECORD'S PROOF NOW: the proof must name the device the signed body names, the registry must still hold its
 * credential (`passkey-removed` otherwise), and the device must still be paired and the assertion verify against the
 * challenge derived again from the body (`proof-invalid` otherwise). A registry that cannot be read is `unknown`:
 * never a pass.
 */
export async function checkRuleProof(
  record: { readonly body: SignInRuleBody; readonly proof: SignInRuleProof },
  port: SignInRuleProofPort,
): Promise<SignInRuleProofCheck> {
  const { body, proof } = record;
  if (proof.deviceId !== body.approvedBy.deviceId) return 'proof-invalid';
  const challenge = ruleChallenge(body, proof.stage, proof.nonce);
  if (challenge === undefined) return 'proof-invalid';
  try {
    if (!(await port.holds(proof.deviceId, proof.credentialId))) return 'passkey-removed';
    return (await port.verify(assertionOf(proof), challenge)) ? 'ok' : 'proof-invalid';
  } catch {
    return 'unknown';
  }
}
