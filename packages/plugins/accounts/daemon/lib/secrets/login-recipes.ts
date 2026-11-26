import { createHash, randomBytes } from 'node:crypto';
import {
  type AccountId,
  type AccountSummary,
  type LoginRecipeProposal,
  type LoginRecipeProposed,
  type Place,
  placeKeys,
  placeWords,
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

/** The ask a proposal was raised on: the board it LANDED on (a sub-ferret's lands on its lead's) and its id there. */
export interface RecipeAsk {
  readonly ferret: string;
  readonly id: string;
}

/** Judges an approval on the very snapshot it is applied to: a throw leaves the sign-in as it was. */
export type RecipeGuard = (signIn: SignInSummary, proposal: LoginRecipeProposal) => void;

/**
 * THE ACCOUNT STORE, as the recipe policy needs it: where a proposal is filed (on one sign-in) and where the owner
 * answers one. accounts-a's `AccountDirectory` (today's `lib/secrets/accounts.ts`) is this, method for method.
 */
interface RecipeAccounts {
  list(): Promise<AccountListing>;
  proposeSignIn(
    id: SignInId,
    proposal: LoginRecipeProposal,
  ): Promise<{ readonly applied: boolean; readonly dropped: readonly LoginRecipeProposal[] }>;
  /** Remembers the ask a proposal was raised on, so settling it closes that ask. */
  proposalCardSignIn(id: SignInId, proposalId: string, ask: RecipeAsk): Promise<void>;
  /** Answers one proposal; `guard` runs on the SAME snapshot the answer is applied to, before anything changes. */
  decideSignIn(
    id: SignInId,
    proposalId: string,
    decision: 'approve' | 'decline',
    guard?: RecipeGuard,
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
interface RecipeValueCheck {
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
  ): Promise<{ ok: true; id: string; ferret: string } | { ok: false; message: string }>;
  /** Closes the ask `id` on the board `ferret`, the one it landed on (which may not be the proposer's). */
  close(ferret: string, id: string, note: string): Promise<void>;
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

export class RecipeValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeValueError';
  }
}

const STALE_PIN = 'this is not the proposal you were shown; reload it and read it again before approving';

/** JSON with every object's keys in order, so one value always spells the same. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, each: unknown) =>
    typeof each === 'object' && each !== null && !Array.isArray(each)
      ? Object.fromEntries(Object.entries(each).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : each,
  );

/**
 * A proposal's pin: a SHA-256 over what an approval would write AND where it would write it (the sign-in's account, place
 * and method), so approving one means approving exactly that text at exactly the place the card named. Retargeting the
 * sign-in after the card was drawn changes the pin.
 */
function proposalPin(signIn: SignInSummary, proposal: LoginRecipeProposal): string {
  return createHash('sha256')
    .update(
      stable([
        signIn.id,
        signIn.account,
        signIn.place,
        signIn.method,
        proposal.id,
        proposal.base ?? null,
        proposal.recipe,
      ]),
    )
    .digest('hex');
}

/** What the owner is told when the redactor cannot mask a proposal: the card says it cannot show it, and offers no Approve. */
const UNSHOWN = 'The change could not be shown here; see it in Settings.';

/** What an agenda ask says of a proposal: the change itself is read behind the owner-only accounts read, never here. */
const CARD_CONTEXT = 'A ferret proposed a sign-in recipe change — review it here';

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
      // A FIXED sentence: asks are every ferret's to read (non-Warden asks pass through ferret reads), so the recipe lines and the
      // ferret's reason stay behind the owner-only accounts read the card is drawn from.
      context: CARD_CONTEXT,
      howToResolve: `Approve or decline it in Settings › Accounts, on the account's ${placeName(signIn.place)} › Recipe, or at the machine: \`fy account site recipe approve ${signIn.id} ${proposal.id}\`.`,
    });
    if (!card.ok) return { ...answer, state: 'pending' };
    await this.ports.accounts.proposalCardSignIn(signIn.id, proposal.id, card).catch(() => undefined);
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

  private async scrubbedEntry<T extends SignInSummary>(entry: T): Promise<T> {
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
                // The pin is of the text ON FILE; the text served beside it is that text masked.
                pin: proposalPin(entry, proposal),
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
      // Nothing can mask the texts, so none is served; a proposal still on file stays on file, with no pin and no text,
      // which the card reads as "could not be shown" and never as "already answered".
      const unshown = (entry.proposals ?? []).map(proposal => ({
        id: proposal.id,
        recipe: UNSHOWN,
        why: UNSHOWN,
        unreadable: true as const,
        sessionId: proposal.sessionId,
        proposedAt: proposal.proposedAt,
      }));
      return { ...bare, ...(unshown.length === 0 ? {} : { proposals: unshown }) } as T;
    }
  }

  /**
   * The OWNER answers a proposal on one sign-in; its ask closes either way. An approval is checked for values again:
   * one the owner kept after the proposal was made must not become the recipe.
   */
  async decideSignIn(
    id: SignInId,
    proposalId: string,
    decision: 'approve' | 'decline',
    pin?: string,
  ): Promise<SignInSummary> {
    const accounts = this.ports.accounts;
    if (decision === 'approve') {
      const waiting = (await accounts.list()).signIns
        .find(each => each.id === id)
        ?.proposals?.find(proposal => proposal.id === proposalId);
      if (waiting !== undefined) await this.assertNoValue(waiting.recipe);
    }
    // What the owner approves is what they were shown, and where: the pin is checked against the sign-in and proposal as
    // they stand in the very snapshot the answer is applied to, so no edit can slip in between the check and the write.
    const guard =
      decision === 'approve' && pin !== undefined
        ? (signIn: SignInSummary, waiting: LoginRecipeProposal): void => {
            if (pin !== proposalPin(signIn, waiting)) throw this.ports.refuse('stale_proposal', STALE_PIN);
          }
        : undefined;
    const { signIn, proposal } = await accounts.decideSignIn(id, proposalId, decision, guard);
    await this.closeCard(proposal, decision === 'approve' ? 'Approved: the recipe was updated.' : 'Declined.');
    return await this.scrubbedEntry(signIn);
  }

  private async closeCard(proposal: LoginRecipeProposal, note: string): Promise<void> {
    if (proposal.agendaItemId === undefined) return;
    // The ask is numbered on the board it LANDED on, which for a sub-ferret's proposal is not the proposer's: the stored board
    // is the only one closed, and an id with no board beside it is never looked up on the proposer's.
    if (proposal.agendaSession === undefined) return;
    await this.ports.agenda.close(proposal.agendaSession, proposal.agendaItemId, note).catch(() => undefined);
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
