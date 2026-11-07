import { randomBytes } from 'node:crypto';
import {
  type AccountSummary,
  type LoginEntryId,
  type LoginEntrySummary,
  type LoginRecipeProposal,
  type LoginRecipeProposed,
  type SignInId,
  type SignInSummary,
  AgendaIdSchema,
  MAX_AGENDA_DETAIL_LENGTH,
  type Place,
  placeKeys,
  placeWords,
  recipeDiff,
} from '@ferretry/protocol';
import type { AgendaService } from '../agenda/service.ts';
import type { AgendaActor } from '../agenda/state-machine.ts';
import type { AuditSink } from '../audit/types.ts';
import type { ClockPort } from '../ports.ts';
import { type AccountDirectory, type AccountListing, LoginEntryError } from './accounts.ts';
import type { LoginDirectory } from './logins.ts';
import { proposalTarget } from './proposal-target.ts';

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

/**
 * Which sign-in a proposal is for: named (`{ signIn }`), or an account's ONLY sign-in (the older `{ login }`, from
 * `login.propose` and `account.propose { login }`). Both go through {@link LoginRecipeService.propose}, ONE path.
 */
export type RecipeProposalTarget = { readonly signIn: SignInId } | { readonly login: LoginEntryId };

/** Whether a text holds any value the daemon masks: the redactor would change it. Rejects when it cannot tell. */
export interface RecipeValueCheck {
  redact(text: string): Promise<string>;
}

/** The agenda, as a proposal needs it: raise its card, close it once the owner answered. */
export interface RecipeAgendaPort {
  raise(
    sessionId: string,
    card: {
      readonly sourceRef: string;
      readonly subject: string;
      readonly context: string;
      readonly howToResolve: string;
    },
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }>;
  close(sessionId: string, id: string, note: string): Promise<void>;
}

export interface LoginRecipePorts {
  /** The saved-login projection, for an older client's answer to a proposal by account (`/v1/secrets/logins/…`). */
  readonly logins: Pick<LoginDirectory, 'list' | 'decide'>;
  /** The account store: where a proposal is filed (on one sign-in) and where the owner answers one. */
  readonly accounts: Pick<AccountDirectory, 'list' | 'proposeSignIn' | 'proposalCardSignIn' | 'decideSignIn'>;
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

  /**
   * WHICH SIGN-IN a proposal is for, and its account: the one named, or — for the older `{ login }` — the account's ONLY
   * sign-in. An account that signs in nowhere, or at several places, is refused: the ferret names the sign-in.
   */
  async resolve(
    target: RecipeProposalTarget,
  ): Promise<{ readonly signIn: SignInSummary; readonly account: AccountSummary }> {
    const found = proposalTarget(
      await this.ports.accounts.list(),
      'signIn' in target ? { signIn: target.signIn } : { login: target.login },
    );
    if (!found.ok) throw new LoginEntryError(found.refusal, found.words);
    return { signIn: found.signIn, account: found.account };
  }

  /**
   * A FERRET proposes a recipe for one SIGN-IN after signing in there: the older `{ login }` is resolved to the
   * account's only sign-in FIRST ({@link resolve}), and every check below runs once, on that canonical sign-in. The text
   * is checked for values; then it applies at once only if the owner allowed that for THIS sign-in, and otherwise
   * waits on a card.
   */
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
   * The entries as they may be SERVED: every recipe, proposal and reason masked through the redactor NOW, so a value
   * kept after the text was written is a mask, never the value. A redactor that fails drops the texts (fail closed).
   */
  async scrubbed(entries: readonly LoginEntrySummary[]): Promise<readonly LoginEntrySummary[]> {
    return await Promise.all(entries.map(async entry => await this.scrubbedEntry(entry)));
  }

  /** An account listing as it may be SERVED: every sign-in's recipe and proposals masked, as {@link scrubbed}. */
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
   * The OWNER answers a proposal; its card closes either way. An approval is checked for values again: one the owner
   * kept after the proposal was made must not become the recipe.
   */
  async decide(id: LoginEntryId, proposalId: string, decision: 'approve' | 'decline'): Promise<LoginEntrySummary> {
    if (decision === 'approve') {
      const waiting = (await this.ports.logins.list())
        .find(each => each.id === id)
        ?.proposals?.find(proposal => proposal.id === proposalId);
      if (waiting !== undefined) await this.assertNoValue(waiting.recipe);
    }
    const { entry, proposal } = await this.ports.logins.decide(id, proposalId, decision);
    await this.closeCard(proposal, decision === 'approve' ? 'Approved: the recipe was updated.' : 'Declined.');
    const [served] = await this.scrubbed([entry]);
    return served ?? entry;
  }

  /**
   * The OWNER answers a proposal on one sign-in; its card closes either way. An approval is checked for values again,
   * as {@link decide} does.
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
    id: LoginEntryId,
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

const RECIPE_CARD_ACTOR: AgendaActor = { kind: 'daemon', cause: 'login-recipe' };

/**
 * A proposal's card on the owner's agenda: a `task` ("look at this"), whose answers change nothing. The owner
 * approves or declines on the login's Recipe in Settings, or with `fy account site recipe`, and the card closes.
 */
export class RecipeAgendaAdapter implements RecipeAgendaPort {
  constructor(private readonly agenda: Pick<AgendaService, 'raise' | 'resolve'>) {}

  async raise(
    sessionId: string,
    card: {
      readonly sourceRef: string;
      readonly subject: string;
      readonly context: string;
      readonly howToResolve: string;
    },
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
    const outcome = await this.agenda.raise(
      sessionId,
      {
        source: 'question',
        sourceRef: card.sourceRef,
        kind: 'task',
        subject: card.subject,
        why: card.subject,
        context: card.context,
        howToResolve: card.howToResolve,
      },
      RECIPE_CARD_ACTOR,
    );
    if (!outcome.ok) return { ok: false, message: outcome.error.message };
    return outcome.item === undefined
      ? { ok: false, message: 'the agenda kept no card for this proposal' }
      : { ok: true, id: outcome.item.id };
  }

  async close(sessionId: string, id: string, note: string): Promise<void> {
    const parsed = AgendaIdSchema.safeParse(id);
    if (!parsed.success) return;
    await this.agenda.resolve(sessionId, parsed.data, RECIPE_CARD_ACTOR, note).catch(() => undefined);
  }
}
