/**
 * THE `sign-in-approval` ASK SOURCE (§2.3, F640 re-cut on 5.0): every question Accounts puts to the owner is an ask of
 * this one source, raised by the DAEMON only, naming an id and never an account or a value.
 *
 * Today these were agenda cards with a daemon-only ref (`taskPlan`, `signInRuleSuggestion`, a recipe proposal's
 * `task`); `packages/daemon/src/lib/{task-plans,sign-in-rules}/agenda-adapter.ts` and `RecipeAgendaAdapter` raised them.
 * Here the same three ports are answered through `AsksApi`, so:
 *
 * - a ferret can never raise one: the ref is set here, on a source the ferret's `fy ask` does not reach (Asks raises a
 *   ferret's ask under its own `ferret` source);
 * - THE ASK APPROVES NOTHING. Asks' generic answer is owner-only and is never read as an approval here: a plan is
 *   approved on its own routes (ticks and a passkey), a rule suggestion only opens the create sheet with nothing ticked,
 *   and a recipe proposal is approved only by the owner-only proposal route (I140). So the source declares no form.
 */
import {
  type AskDraft,
  AskIdSchema,
  type AskSourceSpec,
  type AsksApi,
  type CloseReason,
  EntryIdSchema,
  type SourceKey,
} from '@ferretry/core-asks/contract';
import { z } from 'zod';
import { SignInApprovalRefSchema } from '../../../contract/index.ts';
import { LoginRecipeProposalIdSchema, SignInIdSchema } from '../../../wire/index.ts';
import type { RecipeAgendaPort } from '../secrets/login-recipes.ts';
import type { SignInRuleSuggestionAgendaPort, SignInRuleSuggestionCard } from '../sign-in-rules/suggestions.ts';
import type { TaskPlanAgendaPort, TaskPlanCard } from '../task-plans/service.ts';

export const SIGN_IN_APPROVAL_SOURCE = 'sign-in-approval' as SourceKey;

/**
 * The refs this source raises: the contract's, plus a ferret's recipe proposal (F640: "approve a suggested sign-in recipe
 * in chat"), which names the sign-in and the proposal only.
 *
 * TODO(contract): `SignInApprovalRefSchema` has no `recipe-proposal` kind; add
 * `{ kind: 'recipe-proposal', signIn, proposal }` to Accounts' contract and the manifest's `ask.sources` take, then
 * register the contract schema alone.
 */
export const SignInApprovalAskRefSchema = z.union([
  SignInApprovalRefSchema,
  z.strictObject({ kind: z.literal('recipe-proposal'), signIn: SignInIdSchema, proposal: LoginRecipeProposalIdSchema }),
]);
export type SignInApprovalAskRef = z.infer<typeof SignInApprovalAskRefSchema>;

/** What Accounts registers under `ask.sources:sign-in-approval`. No form: an answer here approves nothing. */
export const signInApprovalSource: AskSourceSpec = {
  schema: SignInApprovalAskRefSchema,
  title: 'Sign-in approval',
  form: false,
};

/** One raise: the daemon's words only; the ferret this ask is about, so its sitrep shows it. */
interface Raise {
  readonly ref: SignInApprovalAskRef;
  readonly entry: string;
  readonly kind: 'permission' | 'task';
  readonly subject: string;
  readonly context: string;
  readonly howToResolve: string;
}

type Raised = { ok: true; id: string } | { ok: false; message: string };

/** The raise and close every adapter below shares. Asks' refusals come back as words, never thrown into the service. */
export class SignInApprovalAsks {
  constructor(private readonly asks: Pick<AsksApi, 'raise' | 'close'>) {}

  async raise(ferret: string, raise: Raise): Promise<Raised> {
    const entry = EntryIdSchema.safeParse(raise.entry);
    if (!entry.success) return { ok: false, message: 'this approval has no id an ask can name' };
    const draft: AskDraft = {
      source: SIGN_IN_APPROVAL_SOURCE,
      ref: raise.ref,
      entry: entry.data,
      kind: raise.kind,
      subject: raise.subject,
      why: raise.subject,
      context: raise.context,
      howToResolve: raise.howToResolve,
      raisedBy: { kind: 'daemon' },
      ferret,
    };
    try {
      return { ok: true, id: await this.asks.raise(draft) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'the ask could not be raised' };
    }
  }

  /**
   * Closes one ask. TODO(contract): `AsksApi.close` takes a reason, not today's closing words ("Approved: the recipe
   * was updated."); the words are dropped until Asks takes a note.
   */
  async close(id: string, reason: CloseReason): Promise<void> {
    const parsed = AskIdSchema.safeParse(id);
    if (!parsed.success) return;
    await this.asks.close(parsed.data, reason).catch(() => undefined);
  }
}

/** A task plan's ask: the daemon words the ask and every line; the ferret's reason rides in the context. */
export class TaskPlanAsksAdapter implements TaskPlanAgendaPort {
  constructor(private readonly asks: SignInApprovalAsks) {}

  async raise(sessionId: string, card: TaskPlanCard): Promise<Raised> {
    // One ask per plan, under the plan's own ref: its paste lines are answered on the plan, never a second ask.
    return await this.asks.raise(sessionId, {
      ref: { kind: 'task-plan', planId: card.planId },
      entry: card.planId,
      kind: 'permission',
      subject: card.ask,
      context: card.context,
      howToResolve: card.howToResolve,
    });
  }

  async close(_sessionId: string, id: string, note: string): Promise<void> {
    await this.asks.close(id, note === 'The task plan expired.' ? 'expired' : 'withdrawn');
  }
}

/** A ferret's standing-rule suggestion: opens the owner's create sheet with nothing ticked; the daemon closes it. */
export class SignInRuleSuggestionAsksAdapter implements SignInRuleSuggestionAgendaPort {
  constructor(private readonly asks: SignInApprovalAsks) {}

  async raise(sessionId: string, card: SignInRuleSuggestionCard): Promise<Raised> {
    return await this.asks.raise(sessionId, {
      ref: { kind: 'rule-suggestion', suggestion: card.suggestionId },
      entry: card.suggestionId,
      kind: 'permission',
      subject: card.ask,
      context: card.context,
      howToResolve: card.howToResolve,
    });
  }

  async close(_sessionId: string, id: string, _note: string): Promise<void> {
    await this.asks.close(id, 'expired');
  }
}

/** A ferret's recipe proposal: names the place and the sign-in's id, never the account; approving is the owner route. */
export class RecipeAsksAdapter implements RecipeAgendaPort {
  constructor(private readonly asks: SignInApprovalAsks) {}

  async raise(
    sessionId: string,
    card: {
      readonly sourceRef: string;
      readonly signIn: string;
      readonly subject: string;
      readonly context: string;
      readonly howToResolve: string;
    },
  ): Promise<Raised> {
    const signIn = SignInIdSchema.safeParse(card.signIn);
    const proposal = LoginRecipeProposalIdSchema.safeParse(card.sourceRef);
    if (!signIn.success || !proposal.success) return { ok: false, message: 'this proposal has no id an ask can name' };
    return await this.asks.raise(sessionId, {
      ref: { kind: 'recipe-proposal', signIn: signIn.data, proposal: proposal.data },
      entry: card.sourceRef,
      kind: 'task',
      subject: card.subject,
      context: card.context,
      howToResolve: card.howToResolve,
    });
  }

  async close(_sessionId: string, id: string, note: string): Promise<void> {
    await this.asks.close(id, note === 'Replaced by a newer recipe proposal.' ? 'superseded' : 'answered');
  }
}
