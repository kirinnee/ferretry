/** Type-level tests (§8): compiled by `tsc --noEmit`, never run. Each negative case is an `@ts-expect-error`. */
import type { CallContext } from '@ferretry/kernel/contract';
import { STEP_UP_ACTS, type ClaimFreshStepUp, type ClaimStoredProof, type StepUpAct } from '../../contract/index.ts';

declare const claim: ClaimFreshStepUp;
declare const claimStored: ClaimStoredProof;
declare const call: CallContext;

// a machine-skippable act is asked the short way
claim(STEP_UP_ACTS.addDevice);
claim();
// an every-caller act names its subject, of its own kind
claim(STEP_UP_ACTS.addTwoFactorKey, 'st_0123456789abcdef01234567');
// @ts-expect-error an every-caller act cannot be asked the short way
claim(STEP_UP_ACTS.addTwoFactorKey);
// @ts-expect-error a plain string is not a step-up act ref
claim('add-2fa-key', 'st_0123456789abcdef01234567');
// @ts-expect-error a subject of another act's kind
claim(STEP_UP_ACTS.addTwoFactorKey, 'tps_0123456789abcdef01234567');
// @ts-expect-error a stored-proof act is never claimed as a fresh step-up
claim(STEP_UP_ACTS.approveSignInRule, 'srs_0123456789abcdef01234567');
claimStored(STEP_UP_ACTS.approveSignInRule, 'srs_0123456789abcdef01234567', new Uint8Array());
// @ts-expect-error only a stored-proof act is claimed as one
claimStored(STEP_UP_ACTS.approveTaskPlan, 'tps_0123456789abcdef01234567', new Uint8Array());

// the standing is on the call, merged into the kernel's CallStanding
const actor: string | undefined = call.actor;
void actor;
// @ts-expect-error a step-up act ref is not any string
const notAnAct: StepUpAct = 'add-device';
void notAnAct;
