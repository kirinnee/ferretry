/**
 * THE PASSKEY STEP-UP SURFACE (`docs/design/zero-trust.md` B2).
 *
 * Eight routes. Seven are for a paired DEVICE, inside a session its key opened: what this device holds, the
 * three ceremonies (register a passkey, unlock, step up) with their options. The eighth is the owner's
 * re-opened window. The browser runs WebAuthn; the daemon issues the challenge and verifies the answer, so
 * a relay carrying these records can neither forge an assertion nor replay one.
 *
 * NO CAPABILITY DEMAND, deliberately. These routes are how a device PROVES itself, and gating the proof
 * behind a grant would let a switched-off capability lock the owner out of the very ceremony that
 * re-opens it. What they hand out is bounded instead: a step-up is fifteen minutes for one running copy
 * of the app, it widens nothing a grant refused, and adding a passkey has its own ceremony — never a
 * step-up, and never authorized by one (see `StepUpService`).
 *
 * WHO the caller is comes from the session — `request.principal`, stamped by the kernel after the session mode verified the
 * device key — and WHERE it arrived from the boundary's own proof. Neither is ever read from a body.
 */

import {
  type ApiResponse,
  type ApiRoute,
  arrivedOnHost,
  errorResponse,
  jsonResponse,
  type MachineSkippableStepUpAct,
  PasskeyOptionsRequestSchema,
  PasskeyRegistrationOptionsSchema,
  PasskeyRegistrationSchema,
  PasskeysViewSchema,
  PasskeyViewSchema,
  PasskeyWindowOpenedSchema,
  PasskeyWindowRequestSchema,
  parseBody,
  type RouteContext,
  STEP_UP_ACTS,
  StepUpAssertionSchema,
  StepUpGrantedSchema,
  StepUpOptionsRequestSchema,
  StepUpOptionsSchema,
  type StepUpRefusal,
  stepUpRefusalCode,
  UnlockGrantedSchema,
} from '../wire.ts';
import type { StepUpCaller, StepUpOutcome, StepUpService } from '../step-up/index.ts';

/** The staged subjects every-caller acts bind to (Gate's stage id schemas). */
type TwoFactorStageId = `st_${string}`;
type TaskPlanStageId = `tps_${string}`;
type SignInRuleStageId = `srs_${string}`;
type PasteRuleStageId = `prs_${string}`;

/**
 * The refusal a stage that is not waiting gets, per staging owner (today's `STAGE_REFUSALS.twoFactor.code`,
 * `STAGE_REFUSALS.taskPlan.code`, `STAGE_REFUSALS.signInRule.code` with its words, and
 * `STAGE_REFUSALS.pasteRule.code` with its words), verbatim. Accounts, Ferrets and Vault own them; a plugin
 * contract may not import theirs, so the four codes and two sentences are copied here.
 */
const STAGE_REFUSALS = {
  twoFactor: { code: 'stage_not_found' },
  taskPlan: { code: 'stage_not_found' },
  signInRule: { code: 'stage_not_found', words: 'That approval timed out or was already answered. Start it again.' },
  pasteRule: {
    code: 'paste_rule_stage_not_found',
    words:
      'That paste rule is not waiting for a passkey any more: it was approved, dropped or timed out. Add it again.',
  },
} as const;

/**
 * The device and page a session's principal names: the kernel-stamped holder, and the session as the step-up's app
 * session (the kernel's `SessionPrincipal` carries no separate app-session id yet).
 */
export function sessionDevice(
  context: RouteContext,
): { readonly deviceId: string; readonly appSession: string } | undefined {
  const principal = context.request.principal;
  return principal?.kind === 'device' ? { deviceId: principal.holder, appSession: principal.session } : undefined;
}

/** The status and sentence for each refusal. A sentence names the person's next step, never a value. */
const REFUSALS: Readonly<Record<StepUpRefusal, { readonly status: number; readonly message: string }>> = {
  'not-a-device': { status: 400, message: 'a passkey belongs to a paired device, and this caller is not one' },
  'origin-not-allowed': {
    status: 403,
    message: 'this copy of the app is not one this machine serves; add its origin to corsOrigins on the machine',
  },
  'registration-closed': {
    status: 403,
    message:
      'a new passkey can only be added within ten minutes of pairing, by confirming with a passkey this device already holds, or after the owner runs `fy passkey window <device>` at the machine',
  },
  'too-many-passkeys': { status: 409, message: 'this device already holds as many passkeys as it may' },
  'no-passkey': { status: 404, message: 'this copy of the app has no passkey for this machine' },
  'not-verified': { status: 401, message: 'that passkey confirmation did not check out; try again' },
  'rotation-required': {
    status: 403,
    message:
      "this device's key is due for replacement, and this machine replaces it with the next passkey confirmation",
  },
  'not-at-machine': {
    status: 403,
    message: 'only the owner at the machine can re-open a passkey window; run `fy passkey window <device>` there',
  },
  'unknown-device': { status: 404, message: 'no paired device has that id; `fy pair` lists none, so pair it first' },
};

const refusal = (reason: StepUpRefusal): ApiResponse => {
  const { status, message } = REFUSALS[reason];
  return errorResponse(status, message, stepUpRefusalCode(reason));
};

const caller = (context: RouteContext): StepUpCaller => callerOf(context);

/** Who is asking, from the session and the carrier only (never a body). */
export const callerOf = (context: RouteContext): StepUpCaller => {
  const { request, credential, actor } = context;
  const device = sessionDevice(context);
  return {
    ...(device === undefined ? {} : { device }),
    ...(request.transcriptHash === undefined ? {} : { transcriptHash: request.transcriptHash }),
    hostLocal: arrivedOnHost(request, credential?.tokenClass === 'admin'),
    ...(actor === undefined ? {} : { actor }),
  };
};

const answer = <T>(outcome: StepUpOutcome<T>, parse: (value: T) => unknown, status = 200): ApiResponse =>
  outcome.ok ? jsonResponse(parse(outcome.value), status) : refusal(outcome.refusal);

/**
 * What the step-up options need of the staged 2FA seeds: what a proof for one is bound to, or nothing when it is not
 * waiting. Absent: this daemon stages none, so it issues no challenge for `add-2fa-key`.
 */
export interface StagedSeedBinding {
  boundSubjectOf(stage: TwoFactorStageId): string | undefined;
}

/**
 * What the step-up options need of the staged task-plan selections: what a proof for one is bound to, or nothing when
 * it is not waiting. Absent: this daemon stages none, so it issues no challenge for `approve-task-plan`.
 */
export interface StagedTaskPlanBinding {
  boundSubjectOf(stage: TaskPlanStageId): string | undefined;
}

/**
 * What the step-up options need of the staged standing sign-in rules: the challenge DERIVED from one's body
 * (`signInRuleChallenge(nonce, signInRuleSubject(stage, canonical))`, the nonce the rule service drew at stage time), or
 * nothing when it is not waiting FOR THIS DEVICE (`deviceId`, the session's proven device — never a body field). A
 * stage is answered only to the device it is waiting on, so another paired device that learns an `srs_` id gets no
 * challenge for it. The proof is kept bound to the stage; the challenge binds it to the bytes. Absent: this daemon
 * stages none, so it issues no challenge for `approve-sign-in-rule`.
 */
export interface StagedSignInRuleBinding {
  challengeOf(stage: SignInRuleStageId, deviceId: string): Uint8Array | undefined;
}

/**
 * What the step-up options need of the staged paste rules (owner decision !A244): what a proof for one is bound to, or
 * nothing when it is not waiting. Absent: this daemon stages none, so it issues no challenge for `approve-paste-rule`.
 */
export interface StagedPasteRuleBinding {
  boundSubjectOf(stage: PasteRuleStageId, kind: 'rule' | 'profile-targets', deviceId: string): string | undefined;
}

export function stepUpRoutes(
  service: StepUpService,
  seeds?: StagedSeedBinding,
  plans?: StagedTaskPlanBinding,
  rules?: StagedSignInRuleBinding,
  pasteRules?: StagedPasteRuleBinding,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/passkeys',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      // The panel that offers the first passkey must load on a machine that asks for one on opening.
      unlockExempt: true,
      handle: async context => answer(await service.view(caller(context)), value => PasskeysViewSchema.parse(value)),
    },
    {
      method: 'POST',
      path: '/v1/passkeys/options',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      // Served before an unlock: a device that has just paired holds no passkey, so registering one is
      // how it gets in at all. The service's own rule (the first window, or one the owner re-opened) is
      // what bounds it, not the unlock.
      unlockExempt: true,
      handle: async context => {
        const body = await parseBody(context.request, PasskeyOptionsRequestSchema);
        return answer(await service.registrationOptions(caller(context), body.origin), value =>
          PasskeyRegistrationOptionsSchema.parse(value),
        );
      },
    },
    {
      method: 'POST',
      path: '/v1/passkeys',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      unlockExempt: true,
      handle: async context => {
        const body = await parseBody(context.request, PasskeyRegistrationSchema);
        return answer(await service.register(caller(context), body), value => PasskeyViewSchema.parse(value), 201);
      },
    },
    {
      method: 'POST',
      path: '/v1/step-up/options',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => {
        const body = await parseBody(context.request, StepUpOptionsRequestSchema);
        // Saving a 2FA seed binds its challenge, and so its proof, to the ONE staged save it names (its account and stage):
        // no proof stamped for the act is ever minted unbound, and only that stage's commit can spend it.
        if (body.act === STEP_UP_ACTS.addTwoFactorKey) {
          const bound =
            body.subject === undefined ? undefined : seeds?.boundSubjectOf(body.subject as TwoFactorStageId);
          if (bound === undefined)
            return errorResponse(
              404,
              'that 2FA key is not waiting to be saved: it was saved, dropped or timed out; stage it again',
              STAGE_REFUSALS.twoFactor.code,
            );
          return answer(await service.stepUpOptions(caller(context), body.origin, body.act, bound), value =>
            StepUpOptionsSchema.parse(value),
          );
        }
        // Approving a task plan's sign-in lines binds its challenge, and so its proof, to the ONE staged selection it
        // names (`taskPlanApprovalSubject(stage, canonical)`): only that stage's commit can spend it.
        if (body.act === STEP_UP_ACTS.approveTaskPlan) {
          const bound = body.subject === undefined ? undefined : plans?.boundSubjectOf(body.subject as TaskPlanStageId);
          if (bound === undefined)
            return errorResponse(
              404,
              'that task plan selection is not waiting for a passkey: stage it again from the plan card',
              STAGE_REFUSALS.taskPlan.code,
            );
          return answer(await service.stepUpOptions(caller(context), body.origin, body.act, bound), value =>
            StepUpOptionsSchema.parse(value),
          );
        }
        // Making a paste rule, or letting rules use programs in your own profile, binds its challenge, and so its proof,
        // to the ONE staged change it names, of that kind, waiting for THIS device (secrev-1334 L1): only that stage's
        // commit can spend it, and another paired device that learns a `prs_` id gets no challenge for it.
        if (body.act === STEP_UP_ACTS.approvePasteRule || body.act === STEP_UP_ACTS.allowProfileTargets) {
          const deviceId = sessionDevice(context)?.deviceId;
          const bound =
            body.subject === undefined || deviceId === undefined
              ? undefined
              : pasteRules?.boundSubjectOf(
                  body.subject as PasteRuleStageId,
                  body.act === STEP_UP_ACTS.approvePasteRule ? 'rule' : 'profile-targets',
                  deviceId,
                );
          if (bound === undefined)
            return errorResponse(404, STAGE_REFUSALS.pasteRule.words, STAGE_REFUSALS.pasteRule.code);
          return answer(await service.stepUpOptions(caller(context), body.origin, body.act, bound), value =>
            StepUpOptionsSchema.parse(value),
          );
        }
        // Approving a standing sign-in rule issues the challenge DERIVED from its staged body, so the assertion the
        // daemon keeps commits to those bytes. A stage that is not waiting — or a daemon that stages no rules — gets no
        // challenge at all, from anyone.
        if (body.act === STEP_UP_ACTS.approveSignInRule) {
          const stage = body.subject as SignInRuleStageId | undefined;
          const deviceId = sessionDevice(context)?.deviceId;
          const challenge =
            stage === undefined || deviceId === undefined ? undefined : rules?.challengeOf(stage, deviceId);
          if (stage === undefined || challenge === undefined)
            return errorResponse(404, STAGE_REFUSALS.signInRule.words, STAGE_REFUSALS.signInRule.code);
          return answer(await service.stepUpOptions(caller(context), body.origin, body.act, stage, challenge), value =>
            StepUpOptionsSchema.parse(value),
          );
        }
        return answer(
          await service.stepUpOptions(caller(context), body.origin, body.act as MachineSkippableStepUpAct | undefined),
          value => StepUpOptionsSchema.parse(value),
        );
      },
    },
    {
      method: 'POST',
      path: '/v1/step-up',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => {
        const body = await parseBody(context.request, StepUpAssertionSchema);
        return answer(await service.stepUp(caller(context), body), value => StepUpGrantedSchema.parse(value));
      },
    },
    // A CONFIRMATION ON OPENING (`unlockOnOpen`): the same ceremony on its own challenge, served to a
    // device the machine is otherwise refusing, so these two are the way in. Never a step-up.
    {
      method: 'POST',
      path: '/v1/unlock/options',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      unlockExempt: true,
      handle: async context => {
        const body = await parseBody(context.request, PasskeyOptionsRequestSchema);
        return answer(await service.unlockOptions(caller(context), body.origin), value =>
          StepUpOptionsSchema.parse(value),
        );
      },
    },
    {
      method: 'POST',
      path: '/v1/unlock',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      unlockExempt: true,
      handle: async context => {
        const body = await parseBody(context.request, StepUpAssertionSchema);
        return answer(await service.unlock(caller(context), body), value => UnlockGrantedSchema.parse(value));
      },
    },
    {
      // The owner's recovery path (B4): a browser is never at the machine, so a device that missed its
      // first window or lost its authenticator would otherwise never step up again. Two layers: the
      // boundary admits only the admin token, and the service still refuses anything but the owner on
      // loopback.
      method: 'POST',
      path: '/v1/passkeys/registration-window',
      minimum: 'admin-token',
      caller: 'person',
      noStore: true,
      handle: async context => {
        const body = await parseBody(context.request, PasskeyWindowRequestSchema);
        return answer(await service.reopenRegistration(caller(context), body.deviceId), value =>
          PasskeyWindowOpenedSchema.parse(value),
        );
      },
    },
  ];
}
