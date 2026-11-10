/**
 * HALF B OF ACCOUNTS' DAEMON (standing sign-in rules, task plans, login recipes, secure copy and the sign-in-approval
 * asks), as one piece the composition root folds into `implementDaemon(manifest, { build })`. Half a owns
 * `daemon/index.ts` and builds the services from `ctx`; this file only turns the built services into the half's
 * keyed routes, hooks and subscriber, so neither half edits the other's wiring.
 */
import type { RouteHandler } from '@ferretry/kernel/contract';
import { routeHandlers } from './lib/http/routes.ts';
import { type CopyListing, type RuleProgramHomes, secureCopyRoutes } from './lib/runtime/mounts/secure-copy.ts';
import { phoneApprovalRoutes } from './lib/runtime/mounts/phone-approvals.ts';
import { signInRuleRoutes } from './lib/runtime/mounts/sign-in-rules.ts';
import { taskPlanRoutes } from './lib/runtime/mounts/task-plans.ts';
import { PhoneApprovalHook } from './lib/phone-approval/provider.ts';
import type { PhoneApprovalService } from './lib/phone-approval/service.ts';
import type { PasteRuleService, PasteRuleStages } from './lib/secure-copy/index.ts';
import { signInApprovalSource } from './lib/sign-in-approval/asks.ts';
import type { SignInRuleService, SignInRuleSuggestions } from './lib/sign-in-rules/index.ts';
import { type DevicesChangedPayload, onDevicesChanged } from './lib/sign-in-rules/wiring.ts';
import { type AccountsStagedAct, type StagedStepUp, stepUpStages } from './lib/step-up-stages.ts';
import type { TaskPlanService } from './lib/task-plans/index.ts';

/** What Ferrets says of a ferret that changed (`ferrets.changed`): only the part an approval reads. */
interface FerretsChangedPayload {
  readonly ferret: string;
  readonly state?: string | undefined;
  readonly gone?: true | undefined;
}

/** The services half b serves, built by the composition root. */
export interface HalfBServices {
  readonly rules: SignInRuleService;
  readonly suggestions: SignInRuleSuggestions;
  readonly plans: TaskPlanService;
  /** Approve on your phone (docs/input-requests.md): the RAM store, its watch and its owner routes. */
  readonly phone: PhoneApprovalService;
  readonly copies: CopyListing;
  readonly pasteRules: PasteRuleService;
  readonly pasteRuleStages: PasteRuleStages;
  readonly homes?: RuleProgramHomes;
  /** Where a failed purge after a device change is reported (never thrown into Access's revocation). */
  readonly purgeFailed?: (error: unknown) => void;
}

/** What half b hands the composition root: every key matches a manifest declaration. */
export interface HalfB {
  readonly routes: Readonly<Record<string, RouteHandler>>;
  readonly hooks: {
    readonly 'ask.sources:sign-in-approval': typeof signInApprovalSource;
    /** The Vault's `push: true` raise and `input_wait` on a `pa_` id, answered by the approval service. */
    readonly 'input.phone-approval:phone': PhoneApprovalHook;
  };
  readonly subscribers: {
    readonly 'access.devices-changed': (payload: DevicesChangedPayload) => Promise<void>;
    /** A ferret that ended takes its waiting approvals with it. */
    readonly 'ferrets.changed': (payload: FerretsChangedPayload) => Promise<void>;
  };
  /** TODO(contract): `step-up.stages:<act>` once Access's contract on this base declares `StepUpStages`. */
  readonly stepUpStages: Readonly<Record<AccountsStagedAct, StagedStepUp>>;
}

export function halfB(services: HalfBServices): HalfB {
  return {
    routes: routeHandlers([
      ...signInRuleRoutes(services.rules, services.suggestions),
      ...taskPlanRoutes(services.plans),
      ...phoneApprovalRoutes(services.phone),
      ...secureCopyRoutes(
        services.copies,
        services.pasteRules,
        services.plans,
        services.pasteRuleStages,
        services.homes,
      ),
    ]),
    hooks: {
      'ask.sources:sign-in-approval': signInApprovalSource,
      'input.phone-approval:phone': new PhoneApprovalHook(services.phone),
    },
    subscribers: {
      'access.devices-changed': onDevicesChanged(services.rules, services.purgeFailed),
      'ferrets.changed': async ({ ferret, state, gone }) => {
        // Ended is stopped or gone, as the Vault reads it: a ferret that merely changed state keeps its approvals.
        if (gone === true || state === 'stopped') await services.phone.ferretEnded(ferret);
      },
    },
    stepUpStages: stepUpStages({
      plans: services.plans,
      pasteRules: services.pasteRuleStages,
      rules: services.rules,
    }),
  };
}
