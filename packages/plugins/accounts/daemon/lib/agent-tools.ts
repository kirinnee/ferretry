/**
 * ACCOUNTS' AGENT TOOLS beside `account_hint`: `account_propose` and `task_plan` (v4's `account.propose` and
 * `task.plan`, `agent-tools/service.ts`).
 *
 * Both are a ferret's: the session is the credential's, never a word in the input, so a call can name no other
 * session. Neither answers a value. A refusal is a result with `isError` and a plain sentence the model can act on,
 * as every other tool's is.
 *
 * NOT HERE: `secure_copy`, `secure_list`, `secure_discard` and `secure_paste`. See the manifest's note: the copy
 * service has no masking, command or page seam on 5.0 yet, and a copy that cannot be masked must not be offered.
 */
import { ferretOf, isFerretCall } from '@ferretry/core-gate/contract';
import type { ToolHandler, ToolResult } from '@ferretry/kernel/manifest';
import {
  type AccountProposeInput,
  AccountProposeInputSchema,
  taskPlanAgentView,
  TaskPlanToolInputSchema,
} from '../../contract/routes/index.ts';
import { LoginEntryError } from './accounts.ts';
import { type LoginRecipeService, RecipeValueError } from './secrets/login-recipes.ts';
import { SecureCopyError } from './secure-copy/errors.ts';
import { SignInRuleSuggestionError, type SignInRuleSuggestions } from './sign-in-rules/index.ts';
import type { TaskPlanService } from './task-plans/index.ts';

const fail = (text: string): ToolResult => ({ text, isError: true });

const plural = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

/** The ferret behind a call, or the sentence saying only a ferret may make it. */
const ferretFor = (call: Parameters<ToolHandler>[0], what: string): string | ToolResult => {
  const ferret = isFerretCall(call) ? ferretOf(call) : undefined;
  return ferret === undefined ? fail(`Only an agent ${what}.`) : ferret;
};

export interface AccountAgentToolServices {
  readonly plans: Pick<TaskPlanService, 'propose'>;
  readonly recipes: Pick<LoginRecipeService, 'propose'>;
  readonly suggestions: Pick<SignInRuleSuggestions, 'suggest'>;
}

/** `task_plan`: one card for the owner to pre-approve up to ten sign-ins and pastes (docs/agent-tools.md). */
function taskPlanTool({ plans }: AccountAgentToolServices): ToolHandler {
  return async (call, input) => {
    const ferret = ferretFor(call, 'asks for sign-ins and pastes to be approved in advance');
    if (typeof ferret !== 'string') return ferret;
    const parsed = TaskPlanToolInputSchema.safeParse(input ?? {});
    if (!parsed.success) return fail(`the plan is not usable: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    try {
      const plan = await plans.propose(ferret, parsed.data);
      return {
        text: `Asked the owner to approve ${plural(plan.lines.length, 'line')} in advance (!${plan.agendaItemId}). Keep raising browser_request_input / terminal_request_input as usual: covered sign-ins and pastes are filled for you once the owner approves; anything else still asks.`,
        data: { taskPlan: taskPlanAgentView(plan) },
      };
    } catch (error) {
      if (error instanceof SecureCopyError) return fail(error.message);
      return fail('The plan could not be raised right now; try again later.');
    }
  };
}

/**
 * The standing-rule half of `account_propose`. `only`: it is the whole call, so a refusal is the call's refusal;
 * otherwise (a recipe was filed too) a refusal is a sentence beside what was filed.
 */
async function suggestRule(
  suggestions: AccountAgentToolServices['suggestions'],
  ferret: string,
  call: AccountProposeInput,
  only: boolean,
): Promise<{ readonly words: string; readonly refused?: true }> {
  try {
    const made = await suggestions.suggest(ferret, { signIn: call.signIn, why: call.why });
    return {
      words: `Suggested a standing rule for ${made.host} (!${made.agenda}); the owner decides, and you will not hear back. Do not ask again.`,
    };
  } catch (error) {
    if (error instanceof SignInRuleSuggestionError)
      return only ? { words: error.message, refused: true } : { words: `No rule was suggested: ${error.message}` };
    return only
      ? { words: 'The suggestion could not be raised right now; try again later.', refused: true }
      : { words: 'The suggestion could not be raised right now.' };
  }
}

/** `account_propose`: a recipe for one sign-in and/or a standing-rule suggestion; the owner decides both. */
function accountProposeTool({ recipes, suggestions }: AccountAgentToolServices): ToolHandler {
  return async (call, input) => {
    const ferret = ferretFor(call, 'proposes a recipe or a standing rule');
    if (typeof ferret !== 'string') return ferret;
    const parsed = AccountProposeInputSchema.safeParse(input ?? {});
    if (!parsed.success)
      return fail(parsed.error.issues[0]?.message ?? 'name the sign-in (signIn), as account_hint lists it');
    const { recipe, preapprove, signIn, why } = parsed.data;
    let filed: string | undefined;
    let data: ToolResult['data'];
    if (recipe !== undefined) {
      try {
        const proposed = await recipes.propose(ferret, { signIn }, recipe, why);
        const { signIn: _same, ...answer } = proposed;
        const where = `${proposed.login} [${proposed.signIn}]`;
        filed =
          proposed.state === 'applied'
            ? `The recipe of ${where} was updated (the owner allows that for this sign-in).`
            : `Proposed a recipe for ${where}${proposed.agendaItemId === undefined ? '' : ` (!${proposed.agendaItemId})`}; the owner approves or declines it. You do not need to wait.`;
        data = { recipe: { ...answer } };
      } catch (error) {
        if (error instanceof LoginEntryError || error instanceof RecipeValueError) return fail(error.message);
        return fail('The recipe could not be filed right now; try again later.');
      }
    }
    if (preapprove !== true) return { text: filed ?? '', ...(data === undefined ? {} : { data }) };
    const suggested = await suggestRule(suggestions, ferret, parsed.data, recipe === undefined);
    if (suggested.refused === true) return fail(suggested.words);
    return {
      text: [filed, suggested.words].filter(word => word !== undefined).join(' '),
      ...(data === undefined ? {} : { data }),
    };
  };
}

/** The handlers, keyed by the tool names the manifest declares. */
export function accountAgentTools(services: AccountAgentToolServices): {
  readonly account_propose: ToolHandler;
  readonly task_plan: ToolHandler;
} {
  return { account_propose: accountProposeTool(services), task_plan: taskPlanTool(services) };
}
