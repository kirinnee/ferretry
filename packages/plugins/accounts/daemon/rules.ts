/**
 * HALF B of Accounts' daemon (standing sign-in rules, task plans, recipes, secure copy), BUILT here from the context
 * and half a's store, then handed to `halfB()` (accounts-b's `./half-b.ts`), which turns the services into the keyed
 * routes, the ask source, the device subscriber and the step-up stage providers. Today's `bin/fyd.ts` composition,
 * copied, with each port bound to what 5.0 offers.
 *
 * WHERE A PORT'S OWNER IS NOT ON THIS BASE YET, ITS STAND-IN FAILS CLOSED, and each is a seam in the report:
 * - passkeys and stored proofs use Access's approved additive reads (a local adapter until its port reaches the base).
 *   A missing or unreadable provider verifies nothing. Gate keeps the service's complete audit evidence.
 * - secure copies (the Vault's child runner and folders): no copy exists, so the copy routes list none.
 * - the passkeys-changed signal and pairing's purge: Access's `DevicesChanged` subscriber is the one live path.
 */
import { auditKind } from '@ferretry/core-gate/contract';
import { accountSecurity } from './adapters/pending-security.ts';
import { randomUUID } from 'node:crypto';
import type { StateFileDef } from '@ferretry/kernel/contract';
import { seconds } from '@ferretry/std';
import type { DaemonContext } from '@ferretry/kernel/manifest';
import { AccountKeySchema } from '../contract/routes/index.ts';
import type manifest from '../manifest.ts';
import { FilePasteRuleStore, FileSignInRuleStore, kernelStateDocument } from './adapters/index.ts';
import type { AccountsCore } from './accounts.ts';
import { type HalfB, halfB } from './half-b.ts';
import { LoginEntryError } from './lib/accounts.ts';
import type { AuditSink } from './lib/local-ports.ts';
import { LoginRecipeService } from './lib/secrets/login-recipes.ts';
import { PasteRuleService, PasteRuleStages } from './lib/secure-copy/index.ts';
import {
  RecipeAsksAdapter,
  SignInApprovalAsks,
  SignInRuleSuggestionAsksAdapter,
  TaskPlanAsksAdapter,
} from './lib/sign-in-approval/asks.ts';
import { SignInRuleService, SignInRuleSuggestions } from './lib/sign-in-rules/index.ts';
import { connectSignInRules, SignInRuleDevicePurge, TERMINAL_RULES_OFFERED } from './lib/sign-in-rules/wiring.ts';
import { TaskPlanService } from './lib/task-plans/index.ts';
import type { RecipeMasking } from './routes/accounts.ts';

type AccountsContext = DaemonContext<typeof manifest>;

/** How often RAM-only stages, suggestions and plans are swept (today's `INPUT_REQUEST_SWEEP_MS`). */
const SWEEP_EVERY = seconds(15);

export interface RulesHalf extends HalfB {
  /** The recipe masking half a's routes and `account_hint` serve through (I133). */
  readonly recipes: RecipeMasking;
}

const stateFile = (ctx: AccountsContext, name: string): StateFileDef => {
  const file = ctx.manifest.data.state.find(each => each.name === name);
  if (file === undefined) throw new Error(`accounts declares no state file ${name}`);
  return file;
};

export function buildRules(ctx: AccountsContext, core: AccountsCore): RulesHalf {
  const { kernel } = ctx;
  const accounts = core.logins.accounts;
  const clock = { now: () => kernel.clock.nowMs() };
  const isoClock = { now: () => kernel.clock.now() as string };
  const redact = async (text: string): Promise<string> => await kernel.redaction.read(scope => scope.text(text));
  const audit: AuditSink = {
    // TODO(gate contract): cause is approved additively; preserve it at the call until Gate accepts it.
    record: async entry => await ctx.needs.gate.audit({ ...entry, event: auditKind(entry.event) }),
  };
  const id = (): string => randomUUID().replaceAll('-', '');
  const security = accountSecurity(ctx.uses.access);
  const terminalRules = () => TERMINAL_RULES_OFFERED;
  const asks = new SignInApprovalAsks(ctx.needs.asks);

  const pasteRules = new PasteRuleService({
    store: new FilePasteRuleStore(kernelStateDocument(kernel.state, stateFile(ctx, 'copy-rules'))),
    clock,
    ids: { ruleId: id },
    warn: message => kernel.log.warn(`secure copy: ${message}`),
  });
  const plans = new TaskPlanService({
    agenda: new TaskPlanAsksAdapter(asks),
    rules: pasteRules,
    accounts: {
      listing: async () => await accounts.list(),
      keyOf: async account => {
        const key = AccountKeySchema.safeParse((await accounts.seedTarget(account).catch(() => undefined))?.key);
        return key.success ? key.data : undefined;
      },
    },
    passkeys: security.passkeys,
    redact,
    // Asks takes no reply note on a raised ask yet: the plan's own words stay in its context.
    tell: async () => undefined,
    audit,
    clock,
    ids: { planId: id },
  });
  const rules = new SignInRuleService({
    store: new FileSignInRuleStore(kernelStateDocument(kernel.state, stateFile(ctx, 'sign-in-rules'))),
    accounts: { listing: async () => await accounts.keyedList() },
    proofs: security.proofs,
    passkeys: security.passkeys,
    audit,
    clock,
    warn: message => kernel.log.warn(`sign-in rules: ${message}`),
    terminalRules,
  });
  const suggestions = new SignInRuleSuggestions({
    accounts: { listing: async () => await accounts.keyedList() },
    agenda: new SignInRuleSuggestionAsksAdapter(asks),
    redact,
    audit,
    clock,
    terminalRules,
  });
  connectSignInRules(rules, {
    accounts,
    passkeys: { subscribe: () => () => undefined },
    devices: new SignInRuleDevicePurge(),
  });
  // An orderly stop writes a suspension or a use whose write failed earlier (S118, S123); what a crash before any
  // write lands still loses is declared (docs/secrets.md).
  kernel.lifecycle.onStop(async () => await rules.flush());
  const recipes = new LoginRecipeService({
    accounts,
    refuse: (refusal, words) => new LoginEntryError(refusal as LoginEntryError['refusal'], words),
    values: { redact },
    agenda: new RecipeAsksAdapter(asks),
    audit,
    clock: isoClock,
  });
  const pasteRuleStages = new PasteRuleStages({ rules: pasteRules, clock });

  kernel.jobs.add({
    id: 'accounts.paste-rules',
    schedule: { onceAfterStart: true },
    run: async () => pasteRules.load(),
  });
  kernel.jobs.add({ id: 'accounts.sign-in-rules', schedule: { onceAfterStart: true }, run: async () => rules.load() });
  kernel.jobs.add({
    id: 'accounts.sweep-stages',
    schedule: { every: SWEEP_EVERY },
    run: async () => {
      plans.sweep();
      suggestions.sweep();
      rules.sweep();
      await rules.sweepRules().catch(() => undefined);
    },
  });

  const half = halfB({
    rules,
    suggestions,
    plans,
    copies: { list: () => [] },
    pasteRules,
    pasteRuleStages,
    purgeFailed: error =>
      kernel.log.warn('sign-in rules: a device purge failed', {
        why: error instanceof Error ? error.message : String(error),
      }),
  });
  return { ...half, recipes };
}
