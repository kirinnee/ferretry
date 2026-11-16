import { ferretOf, isFerretCall } from '@ferretry/core-gate/contract';
import type { ToolHandler, ToolResult } from '@ferretry/kernel/manifest';
import {
  AccountProposeCallSchema,
  type LoginRecipeProposed,
  type SignInId,
  taskPlanAgentView,
} from '../../contract/routes/index.ts';
import { LoginEntryError } from './accounts.ts';
import { RecipeValueError } from './secrets/login-recipes.ts';
import { SecureCopyError } from './secure-copy/errors.ts';
import { SignInRuleSuggestionError } from './sign-in-rules/suggestions.ts';
import { TaskPlanError, type TaskPlanService } from './task-plans/service.ts';
import { ASK_REFERENCE_SIGIL } from '@ferretry/core-asks/contract';

/**
 * THE AGENT'S TWO ASKING TOOLS: `account_propose` (a recipe for a sign-in and/or a standing-rule suggestion) and
 * `task_plan` (sign-ins and pastes to pre-approve, on one card). Both only ASK: each raises a card for the owner and
 * changes nothing the owner has not allowed, so a ferret can widen nothing through either. The services behind them own
 * the caps, the value checks and the audit lines; this file is the call's door.
 *
 * A call is a FERRET's own: a call with no ferret behind it (a person's route) is refused, because a card is raised on a
 * ferret's agenda and a person has none. Every refusal is a sentence the agent can act on, and an error that is not one
 * of ours is a fixed sentence, never its message (a thrown error can quote what a page or a program said). Every word
 * that leaves goes through the vault redactor.
 */
export interface ProposalToolDeps {
  /** Files a recipe proposal on one sign-in (the recipe policy: no value, one card, owner approval). */
  readonly recipes: {
    propose(
      sessionId: string,
      target: { readonly signIn: SignInId },
      recipe: string,
      why: string,
    ): Promise<LoginRecipeProposed & { readonly signIn: SignInId }>;
  };
  /** Raises the owner's card for a suggested standing rule: a card and a line in memory, nothing more. */
  readonly suggestions: {
    suggest(
      sessionId: string,
      ask: { readonly signIn: SignInId; readonly why: string },
    ): Promise<{ readonly signIn: SignInId; readonly host: string; readonly agenda: string }>;
  };
  readonly plans: Pick<TaskPlanService, 'propose'>;
  /** The vault redactor, over every sentence on its way out. */
  readonly redact: (text: string) => Promise<string>;
}

const NOT_AN_AGENT = 'Only an agent asks the owner this way: a person can make the change themselves.';
const FAILED = 'The owner could not be asked right now; nothing was changed.';
const RECIPE_FAILED = 'The recipe could not be filed right now; try again later.';
const SUGGESTION_FAILED = 'The suggestion could not be raised right now; try again later.';

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** What a recipe proposal says it did, in words: updated at once (the owner's own switch for that sign-in) or waiting. */
const recipeWords = (proposed: LoginRecipeProposed & { readonly signIn: SignInId }): string => {
  const where = `${proposed.login} [${proposed.signIn}]`;
  return proposed.state === 'applied'
    ? `The recipe of ${where} was updated (the owner allows that for this sign-in).`
    : `Proposed a recipe for ${where}${proposed.agendaItemId === undefined ? '' : ` (${ASK_REFERENCE_SIGIL}${proposed.agendaItemId})`}; the owner approves or declines it. You do not need to wait.`;
};

/** One refused sentence, or the fixed one when the error is not one of the services' own. */
const refusalWords = (error: unknown, fallback: string): string => {
  if (
    error instanceof LoginEntryError ||
    error instanceof RecipeValueError ||
    error instanceof SignInRuleSuggestionError ||
    error instanceof SecureCopyError ||
    error instanceof TaskPlanError
  )
    return error.message;
  return fallback;
};

export function proposalTools(deps: ProposalToolDeps): {
  readonly account_propose: ToolHandler;
  readonly task_plan: ToolHandler;
} {
  const say = async (text: string, isError: boolean, data?: unknown): Promise<ToolResult> => {
    let words: string;
    try {
      words = await deps.redact(text);
    } catch {
      // Nothing can mask the words, so none of them is said: even a success is told as the fixed refusal.
      return { text: FAILED, isError: true };
    }
    return {
      text: words,
      ...(isError ? { isError: true } : {}),
      ...(data === undefined ? {} : { data: JSON.parse(JSON.stringify(data)) }),
    };
  };

  /** Runs one tool as a ferret's call; every refusal is a sentence, and nothing else leaves as an error. */
  const guarded =
    (work: (ferret: string, input: unknown) => Promise<ToolResult>): ToolHandler =>
    async (call, input) => {
      const ferret = isFerretCall(call) ? ferretOf(call) : undefined;
      if (ferret === undefined) return await say(NOT_AN_AGENT, true);
      try {
        return await work(ferret, input ?? {});
      } catch (error) {
        return await say(refusalWords(error, FAILED), true);
      }
    };

  const account_propose = guarded(async (ferret, input) => {
    const parsed = AccountProposeCallSchema.safeParse({ tool: 'account.propose', ...(input as object) });
    if (!parsed.success) {
      // A failed `safeParse` always carries at least one issue.
      const issue = parsed.error.issues[0] as (typeof parsed.error.issues)[number];
      return await say(`${issue.path.length === 0 ? '' : `${issue.path.join('.')}: `}${issue.message}`, true);
    }
    const call = parsed.data;
    let filed: LoginRecipeProposed | undefined;
    let words = '';
    if (call.recipe !== undefined) {
      let proposed: LoginRecipeProposed & { readonly signIn: SignInId };
      try {
        proposed = await deps.recipes.propose(ferret, { signIn: call.signIn }, call.recipe, call.why);
      } catch (error) {
        return await say(refusalWords(error, RECIPE_FAILED), true);
      }
      const { signIn: _signIn, ...recipe } = proposed;
      filed = recipe;
      words = recipeWords(proposed);
    }
    if (call.preapprove !== true) return await say(words, false, { recipe: filed });
    // A refusal of the suggestion is said in the summary when a recipe was filed in the same call, so the filed recipe
    // is not reported as failed; on its own it is the call's refusal.
    try {
      const made = await deps.suggestions.suggest(ferret, { signIn: call.signIn, why: call.why });
      const said = `Suggested a standing rule for ${made.host} (${ASK_REFERENCE_SIGIL}${made.agenda}); the owner decides, and you will not hear back. Do not ask again.`;
      return await say([words, said].filter(word => word !== '').join(' '), false, { recipe: filed });
    } catch (error) {
      const said = refusalWords(error, SUGGESTION_FAILED);
      if (filed === undefined) return await say(said, true);
      return await say(
        `${words} ${error instanceof SignInRuleSuggestionError ? `No rule was suggested: ${said}` : 'The suggestion could not be raised right now.'}`,
        false,
        { recipe: filed },
      );
    }
  });

  const task_plan = guarded(async (ferret, input) => {
    const plan = await deps.plans.propose(ferret, input as Parameters<TaskPlanService['propose']>[1]);
    return await say(
      `Asked the owner to approve ${plural(plan.lines.length, 'line')} in advance (${ASK_REFERENCE_SIGIL}${plan.agendaItemId}). Keep raising browser_request_input / terminal_request_input as usual: covered sign-ins and pastes are filled for you once the owner approves; anything else still asks.`,
      false,
      { taskPlan: taskPlanAgentView(plan) },
    );
  });

  return { account_propose, task_plan };
}
