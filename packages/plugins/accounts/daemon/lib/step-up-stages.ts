/**
 * WHAT ACCESS ASKS ACCOUNTS WHEN A DEVICE WANTS A PASSKEY CHALLENGE FOR A STAGED ACT (G83/G84; lead decision, Access
 * `step-up.stages:<act>`). Today the step-up options route read each stage's binding directly
 * (`runtime/mounts/step-up.ts`: `plans.boundSubjectOf`, `pasteRules.boundSubjectOf`, `rules.challengeOf`); here each is
 * provided under its act, so Access issues a challenge only for a stage that is waiting, and only stamped with the
 * subject (or, for a rule, the challenge derived from its body) the commit will check. Answering `undefined` makes
 * Access refuse with `stage_not_found` and issue nothing.
 *
 * TODO(contract): Access's contract on this base has no `StepUpStages` hook or `StagedStepUp` type (they are on
 * `rebuild/port-access` d97009056); this local copy is bound to `step-up.stages:<act>` once that lands. Its
 * `STAGED_STEP_UP_ACTS` has no `allow-profile-targets`, which today stages through the paste rules too
 * (`kind: 'profile-targets'`); until it does, only `kind` passed by Access selects it.
 */
import type { PasteRuleStageId, SignInRuleStageId, TaskPlanStageId } from '../../contract/routes/index.ts';
import type { PasteRuleStageKind } from '../../contract/routes/index.ts';

/** The acts Accounts stages (Access's `StagedStepUpAct`, less `add-2fa-key`, which half a provides). */
export type AccountsStagedAct = 'approve-task-plan' | 'approve-sign-in-rule' | 'approve-paste-rule';

/** Access's `StagedStepUp`, as its contract on `rebuild/port-access` declares it. */
export interface StagedStepUp {
  subjectOf?(stage: string, deviceId: string, kind?: 'rule' | 'profile-targets'): string | undefined;
  challengeOf?(stage: string, deviceId: string): Uint8Array | undefined;
}

/** The three stage stores, as the step-up options read them. */
export interface StageBindings {
  readonly plans: { boundSubjectOf(stage: TaskPlanStageId): string | undefined };
  readonly pasteRules: {
    boundSubjectOf(stage: PasteRuleStageId, kind: PasteRuleStageKind, deviceId: string): string | undefined;
  };
  readonly rules: { challengeOf(stage: SignInRuleStageId, deviceId: string): Uint8Array | undefined };
}

/**
 * The `step-up.stages:<act>` providers, each answering exactly what today's step-up options route read: the stage id is
 * taken as given (`body.subject as …`), and an id that is not a waiting stage of that act finds nothing.
 */
export function stepUpStages(bindings: StageBindings): Readonly<Record<AccountsStagedAct, StagedStepUp>> {
  return {
    // A task plan's selection: bound to the stage and its canonical selection (`taskPlanApprovalSubject`).
    'approve-task-plan': {
      subjectOf: stage => bindings.plans.boundSubjectOf(stage as TaskPlanStageId),
    },
    // A paste rule's stage is answered only to the device it waits on, and only for its own kind (secrev-1334 L1).
    'approve-paste-rule': {
      subjectOf: (stage, deviceId, kind = 'rule') =>
        bindings.pasteRules.boundSubjectOf(stage as PasteRuleStageId, kind, deviceId),
    },
    // A standing rule's challenge is DERIVED from its staged body, so the kept assertion commits to those bytes.
    'approve-sign-in-rule': {
      challengeOf: (stage, deviceId) => bindings.rules.challengeOf(stage as SignInRuleStageId, deviceId),
    },
  };
}
