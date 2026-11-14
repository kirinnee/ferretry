/**
 * HALF B OF ACCOUNTS' DAEMON (standing sign-in rules, task plans, login recipes, secure copy and the sign-in-approval
 * asks), as one piece the composition root folds into `implementDaemon(manifest, { build })`. Half a owns
 * `daemon/index.ts` and builds the services from `ctx`; this file only turns the built services into the half's
 * keyed routes, hooks and subscriber, so neither half edits the other's wiring.
 */
import type { RouteHandler } from '@ferretry/kernel/contract';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import { routeHandlers } from './lib/http/routes.ts';
import { type CopyListing, type RuleProgramHomes, secureCopyRoutes } from './lib/runtime/mounts/secure-copy.ts';
import { phoneApprovalRoutes } from './lib/runtime/mounts/phone-approvals.ts';
import { signInRuleRoutes } from './lib/runtime/mounts/sign-in-rules.ts';
import { taskPlanRoutes } from './lib/runtime/mounts/task-plans.ts';
import { PhoneApprovalHook } from './lib/phone-approval/provider.ts';
import type { PhoneApprovalService } from './lib/phone-approval/service.ts';
import type { PasteRuleService, PasteRuleStages, SecureCopyHook } from './lib/secure-copy/index.ts';
import { signInApprovalSource } from './lib/sign-in-approval/asks.ts';
import type { SignInRuleService, SignInRuleSuggestions } from './lib/sign-in-rules/index.ts';
import { type DevicesChangedPayload, onDevicesChanged } from './lib/sign-in-rules/wiring.ts';
import type { StagedStepUp } from '@ferretry/plugin-access/contract';
import { type AccountsStagedAct, stepUpStages } from './lib/step-up-stages.ts';
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
  /** What the Vault's input bridge reads of the copies and rules (`input.secure-copy:copy`). */
  readonly secureCopyHook: SecureCopyHook;
  /** The agent's four secure-copy tools, by the names the manifest declares. */
  readonly secureCopyTools: {
    readonly secure_copy: ToolHandler;
    readonly secure_list: ToolHandler;
    readonly secure_discard: ToolHandler;
    readonly secure_paste: ToolHandler;
  };
  /** A ferret ended: whatever it held (copies, page records) is let go. */
  readonly sessionEnded: (ferret: string) => void;
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
    /** The Vault's paste: the copies it draws from, the owner's rules, and the takeover check. */
    readonly 'input.secure-copy:copy': SecureCopyHook;
  };
  readonly tools: HalfBServices['secureCopyTools'];
  readonly subscribers: {
    readonly 'access.devices-changed': (payload: DevicesChangedPayload) => Promise<void>;
    /** A ferret that ended takes its waiting approvals with it. */
    readonly 'ferrets.changed': (payload: FerretsChangedPayload) => Promise<void>;
  };
  /** The `step-up.stages:<act>` providers for the three acts half b stages, provided by `../index.ts`. */
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
      'input.secure-copy:copy': services.secureCopyHook,
    },
    tools: services.secureCopyTools,
    subscribers: {
      'access.devices-changed': onDevicesChanged(services.rules, services.purgeFailed),
      'ferrets.changed': async ({ ferret, state, gone }) => {
        // Ended is stopped or gone, as the Vault reads it: a ferret that merely changed state keeps its approvals.
        if (gone === true || state === 'stopped') {
          services.sessionEnded(ferret);
          await services.phone.ferretEnded(ferret);
        }
      },
    },
    stepUpStages: stepUpStages({
      plans: services.plans,
      pasteRules: services.pasteRuleStages,
      rules: services.rules,
    }),
  };
}
