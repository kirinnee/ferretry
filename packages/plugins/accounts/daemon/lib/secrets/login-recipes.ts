import { randomBytes } from 'node:crypto';
import { MAX_ASK_DETAIL_LENGTH as MAX_AGENDA_DETAIL_LENGTH } from '@ferretry/core-asks/contract';
import {
  type AccountId,
  type AccountSummary,
  type LoginRecipeProposal,
  type LoginRecipeProposed,
  type Place,
  placeKeys,
  placeWords,
  recipeDiff,
  type SignInId,
  type SignInSummary,
} from '../../../contract/routes/index.ts';
import type { AuditSink, ClockPort } from '../local-ports.ts';
import { proposalTarget } from './proposal-target.ts';

/** The accounts and sign-ins, never a value (today's `AccountListing`, `lib/secrets/accounts.ts`). */
export interface AccountListing {
  readonly accounts: readonly AccountSummary[];
  readonly signIns: readonly SignInSummary[];
}

/**
 * THE ACCOUNT STORE, as the recipe policy needs it: where a proposal is filed (on one sign-in) and where the owner
 * answers one. accounts-a's `AccountDirectory` (today's `lib/secrets/accounts.ts`) is this, method for method.
 */
export interface RecipeAccounts {
  list(): Promise<AccountListing>;
  proposeSignIn(
    id: SignInId,
    proposal: LoginRecipeProposal,
  ): Promise<{ readonly applied: boolean; readonly dropped: readonly LoginRecipeProposal[] }>;
  /** Remembers the ask a proposal was raised on, so settling it closes that ask. */
  proposalCardSignIn(id: SignInId, proposalId: string, agendaItemId: string): Promise<void>;
  decideSignIn(
    id: SignInId,
    proposalId: string,
    decision: 'approve' | 'decline',
  ): Promise<{ readonly signIn: SignInSummary; readonly proposal: LoginRecipeProposal }>;
}

/**
 * LOGIN RECIPES, as policy (docs/input-requests.md, "Login recipes"). The directory stores a recipe and its
 * proposals; this decides what may be written and who is told.
 *
 * - A recipe NEVER HOLDS A VALUE. Every recipe text, the owner's or a ferret's, is run through the daemon's own
 *   redactor before it is stored: text in which any vault secret, saved login or just-typed value is found is
 *   refused, and a redactor that cannot run refuses too (fail closed).
 * - A PROPOSAL IS A FERRET'S WORDS. It comes only from the ferret's own `account_propose` call (never from page text:
 *   the daemon never reads a recipe off a page), is filed on ONE SIGN-IN and waits on the owner, who sees the diff on an
 *   agenda card. The card approves nothing: approving is the owner-only route, so no agenda answer a ferret could steer
 *   changes a recipe. Only an owner who turned auto-apply on for that ONE sign-in lets a proposal apply at once, and
 *   that is audited. Every applied change bumps the sign-in's `recipeVersion`.
 */

/** A proposal always names one canonical sign-in. */
export type RecipeProposalTarget = { readonly signIn: SignInId };

/** Whether a text holds any value the daemon masks: the redactor would change it. Rejects when it cannot tell. */
export interface RecipeValueCheck {
  redact(text: string): Promise<string>;
}

/** The asks, as a proposal needs them: raise its ask, close it once the owner answered (`sign-in-approval/asks.ts`). */
export interface RecipeAgendaPort {
  raise(
    sessionId: string,
    card: {
      readonly sourceRef: string;
      /** The sign-in the proposal is filed on: the ask names it and the proposal, never the account. */
      readonly signIn: SignInId;
      readonly subject: string;
      readonly context: string;
      readonly howToResolve: string;
    },
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }>;
  close(sessionId: string, id: string, note: string): Promise<void>;
}

export interface LoginRecipePorts {
  /** The account store: where a proposal is filed (on one sign-in) and where the owner answers one. */
  readonly accounts: RecipeAccounts;
  /**
   * The refusal a target that is not one sign-in is thrown as: accounts-a passes `(refusal, words) => new
   * LoginEntryError(refusal, words)` so the account routes answer it as today.
   */
  readonly refuse: (refusal: string, words: string) => Error;
  readonly values: RecipeValueCheck;
  readonly agenda: RecipeAgendaPort;
  readonly audit: Pick<AuditSink, 'record'>;
  readonly clock: ClockPort;
  readonly newId?: () => string;
}

/** What carries a recipe a route serves: a saved login, or a sign-in. */
interface RecipeBearing {
  readonly recipe?: string | undefined;
  readonly recipeBy?: 'ferret' | undefined;
  readonly recipeVersion?: number | undefined;
  readonly proposals?: readonly LoginRecipeProposal[] | undefined;
}

export class RecipeValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeValueError';
  }
}

const HOLDS_VALUE = 'a recipe never holds a value, and this one contains a saved or secret value; take it out';

export class LoginRecipeService {
  constructor(private readonly ports: LoginRecipePorts) {}

  /** Refuses a recipe in which the redactor finds any value. A redactor that fails refuses as well. */
  async assertNoValue(recipe: string): Promise<void> {
    let scrubbed: string;
    try {
      scrubbed = await this.ports.values.redact(recipe);
    } catch {
      throw new RecipeValueError('Ferretry could not check the recipe for values, so it was not kept');
    }
    if (scrubbed !== recipe) throw new RecipeValueError(HOLDS_VALUE);
  }

  /** Resolve the canonical sign-in and its account. */
  async resolve(
    target: RecipeProposalTarget,
  ): Promise<{ readonly signIn: SignInSummary; readonly account: AccountSummary }> {
    const found = proposalTarget(await this.ports.accounts.list(), target);
    if (!found.ok) throw this.ports.refuse(found.refusal, found.words);
    return { signIn: found.signIn, account: found.account };
  }

  /** A ferret proposes steps for one sign-in; only its explicit auto-apply permission applies them. */
  async propose(
    sessionId: string,
    target: RecipeProposalTarget,
    recipe: string,
    why: string,
  ): Promise<LoginRecipeProposed & { readonly signIn: SignInId }> {
    const { signIn, account } = await this.resolve(target);
    await this.assertNoValue(recipe);
    await this.assertNoValue(why);
    const proposal: LoginRecipeProposal = {
      id: this.ports.newId?.() ?? `rp_${randomBytes(8).toString('hex')}`,
      recipe,
      ...(signIn.recipe === undefined ? {} : { base: signIn.recipe }),
      why,
      sessionId,
      proposedAt: this.ports.clock.now(),
    };
    const filed = await this.ports.accounts.proposeSignIn(signIn.id, proposal);
    for (const dropped of filed.dropped) await this.closeCard(dropped, 'Replaced by a newer recipe proposal.');
    const answer = { id: proposal.id, login: account.id, signIn: signIn.id } as const;
    if (filed.applied) {
      await this.record(account.id, 'login-recipe-auto', proposal.id, sessionId, signIn.id);
      return { ...answer, state: 'applied' };
    }
    // Agenda text is every ferret's to read: the card names the place and the sign-in's id, never the account's label.
    const card = await this.ports.agenda.raise(sessionId, {
      sourceRef: proposal.id,
      signIn: signIn.id,
      subject: `Recipe change ${placeWords(signIn.place)}`,
      // The card shows the CURRENT recipe too, which may hold a value kept after it was written: masked like any read.
      context: await this.masked(cardContext(signIn.recipe, recipe, why)),
      howToResolve: `Approve or decline it in Settings › Accounts, on the account's ${placeName(signIn.place)} › Recipe, or at the machine: \`fy account site recipe approve ${signIn.id} ${proposal.id}\`.`,
    });
    if (!card.ok) return { ...answer, state: 'pending' };
    await this.ports.accounts.proposalCardSignIn(signIn.id, proposal.id, card.id).catch(() => undefined);
    return { ...answer, state: 'pending', agendaItemId: card.id };
  }

  /**
   * An account listing as it may be SERVED: every recipe, proposal and reason masked through the redactor NOW, so a value
   * kept after the text was written is a mask, never the value. A redactor that fails drops the texts (fail closed).
   */
  async scrubbedAccounts(listing: AccountListing): Promise<AccountListing> {
    return {
      accounts: listing.accounts,
      signIns: await Promise.all(listing.signIns.map(async signIn => await this.scrubbedEntry(signIn))),
    };
  }

  private async scrubbedEntry<T extends RecipeBearing>(entry: T): Promise<T> {
    if (entry.recipe === undefined && entry.proposals === undefined) return entry;
    const { recipe: _recipe, recipeBy: _by, recipeVersion: _version, proposals: _proposals, ...bare } = entry;
    try {
      const redact = async (text: string): Promise<string> => await this.ports.values.redact(text);
      const recipe = entry.recipe === undefined ? undefined : await redact(entry.recipe);
      const proposals =
        entry.proposals === undefined
          ? undefined
          : await Promise.all(
              entry.proposals.map(async proposal => ({
                ...proposal,
                recipe: await redact(proposal.recipe),
                why: await redact(proposal.why),
                ...(proposal.base === undefined ? {} : { base: await redact(proposal.base) }),
              })),
            );
      return {
        ...bare,
        ...(recipe === undefined ? {} : { recipe }),
        ...(recipe === undefined || entry.recipeVersion === undefined ? {} : { recipeVersion: entry.recipeVersion }),
        ...(recipe === undefined || entry.recipeBy === undefined ? {} : { recipeBy: entry.recipeBy }),
        ...(proposals === undefined ? {} : { proposals }),
      } as T;
    } catch {
      return bare as T;
    }
  }

  /** A text as it may be shown, or a fixed sentence when nothing can mask it. */
  private async masked(text: string): Promise<string> {
    return await this.ports.values.redact(text).catch(() => 'The change could not be shown here; see it in Settings.');
  }

  /**
   * The OWNER answers a proposal on one sign-in; its ask closes either way. An approval is checked for values again:
   * one the owner kept after the proposal was made must not become the recipe.
   */
  async decideSignIn(id: SignInId, proposalId: string, decision: 'approve' | 'decline'): Promise<SignInSummary> {
    const accounts = this.ports.accounts;
    if (decision === 'approve') {
      const waiting = (await accounts.list()).signIns
        .find(each => each.id === id)
        ?.proposals?.find(proposal => proposal.id === proposalId);
      if (waiting !== undefined) await this.assertNoValue(waiting.recipe);
    }
    const { signIn, proposal } = await accounts.decideSignIn(id, proposalId, decision);
    await this.closeCard(proposal, decision === 'approve' ? 'Approved: the recipe was updated.' : 'Declined.');
    return await this.scrubbedEntry(signIn);
  }

  private async closeCard(proposal: LoginRecipeProposal, note: string): Promise<void> {
    if (proposal.agendaItemId === undefined) return;
    await this.ports.agenda.close(proposal.sessionId, proposal.agendaItemId, note).catch(() => undefined);
  }

  private async record(
    id: AccountId,
    action: string,
    proposal: string,
    session: string,
    signIn: SignInId,
  ): Promise<void> {
    await this.ports.audit
      .record({
        event: 'secrets.changed',
        actor: { kind: 'host' },
        subject: id,
        outcome: 'succeeded',
        detail: { action, proposal, session, signIn, by: 'agent' },
      })
      .catch(() => undefined);
  }
}

/** A place as the Accounts screen names a site row: its first login domain, or its `tool@host`. */
function placeName(place: Place): string {
  return (place.kind === 'site' ? (place.domains[0] ?? place.match[0]) : placeKeys(place)[0]) ?? 'this place';
}

/** The lines that change, `- ` and `+ `, and the ferret's reason, cut to fit a card; the app shows the whole diff. */
export function cardContext(base: string | undefined, next: string, why: string): string {
  const reason = `The ferret says: ${why}`;
  const changed = recipeDiff(base, next)
    .filter(line => line.op !== ' ')
    .map(line => `${line.op} ${line.text}`.trimEnd());
  const room = MAX_AGENDA_DETAIL_LENGTH - reason.length - 64;
  const kept: string[] = [];
  let used = 0;
  for (const line of changed) {
    if (used + line.length + 1 > room) {
      kept.push(`… ${String(changed.length - kept.length)} more changed line(s): see the whole diff in Settings`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return `${kept.length === 0 ? 'No line changes.' : kept.join('\n')}\n\n${reason}`;
}
