import { randomBytes } from 'node:crypto';
import {
  type LoginEntryId,
  type LoginEntrySummary,
  type LoginRecipeProposal,
  type LoginRecipeProposed,
  AgendaIdSchema,
  MAX_AGENDA_DETAIL_LENGTH,
  recipeDiff,
} from '@ferretry/protocol';
import type { AgendaService } from '../agenda/service.ts';
import type { AgendaActor } from '../agenda/state-machine.ts';
import type { AuditSink } from '../audit/types.ts';
import type { ClockPort } from '../ports.ts';
import { type LoginDirectory, LoginEntryError } from './logins.ts';

/**
 * LOGIN RECIPES, as policy (docs/input-requests.md, "Login recipes"). The directory stores a recipe and its
 * proposals; this decides what may be written and who is told.
 *
 * - A recipe NEVER HOLDS A VALUE. Every recipe text, the owner's or a ferret's, is run through the daemon's own
 *   redactor before it is stored: text in which any vault secret, saved login or just-typed value is found is
 *   refused, and a redactor that cannot run refuses too (fail closed).
 * - A PROPOSAL IS A FERRET'S WORDS. It comes only from the ferret's own `login_propose` call (never from page text:
 *   the daemon never reads a recipe off a page) and waits on the owner, who sees the diff on an agenda card. The card
 *   approves nothing: approving is the owner-only route, so no agenda answer a ferret could steer changes a recipe.
 *   Only an owner who turned auto-apply on for that ONE login lets a proposal apply at once, and that is audited.
 */

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
  readonly logins: Pick<LoginDirectory, 'list' | 'put' | 'propose' | 'proposalCard' | 'decide'>;
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
   * A FERRET proposes a recipe for one login after a sign-in. The login must exist; the text is checked for values;
   * then it applies at once only if the owner allowed that for this login, and otherwise waits on a card.
   */
  async propose(sessionId: string, id: LoginEntryId, recipe: string, why: string): Promise<LoginRecipeProposed> {
    const entry = (await this.ports.logins.list()).find(each => each.id === id);
    if (entry === undefined) throw new LoginEntryError('unknown_login', `there is no saved login ${id}`);
    await this.assertNoValue(recipe);
    await this.assertNoValue(why);
    const proposal: LoginRecipeProposal = {
      id: this.ports.newId?.() ?? `rp_${randomBytes(8).toString('hex')}`,
      recipe,
      ...(entry.recipe === undefined ? {} : { base: entry.recipe }),
      why,
      sessionId,
      proposedAt: this.ports.clock.now(),
    };
    const filed = await this.ports.logins.propose(id, proposal);
    for (const dropped of filed.dropped) await this.closeCard(dropped, 'Replaced by a newer recipe proposal.');
    if (filed.applied) {
      await this.record(id, 'login-recipe-auto', proposal.id, sessionId);
      return { id: proposal.id, login: id, state: 'applied' };
    }
    const card = await this.ports.agenda.raise(sessionId, {
      sourceRef: proposal.id,
      subject: `Recipe change for '${entry.label}'`,
      // The card shows the CURRENT recipe too, which may hold a value kept after it was written: masked like any read.
      context: await this.masked(cardContext(entry.recipe, recipe, why)),
      howToResolve: `Approve or decline it in Settings › Accounts › ${entry.label} › Recipe, or at the machine: \`fy account recipe approve ${id} ${proposal.id}\`.`,
    });
    if (!card.ok) return { id: proposal.id, login: id, state: 'pending' };
    await this.ports.logins.proposalCard(id, proposal.id, card.id).catch(() => undefined);
    return { id: proposal.id, login: id, state: 'pending', agendaItemId: card.id };
  }

  /**
   * The entries as they may be SERVED: every recipe, proposal and reason masked through the redactor NOW, so a value
   * kept after the text was written is a mask, never the value. A redactor that fails drops the texts (fail closed).
   */
  async scrubbed(entries: readonly LoginEntrySummary[]): Promise<readonly LoginEntrySummary[]> {
    return await Promise.all(entries.map(async entry => await this.scrubbedEntry(entry)));
  }

  private async scrubbedEntry(entry: LoginEntrySummary): Promise<LoginEntrySummary> {
    if (entry.recipe === undefined && entry.proposals === undefined) return entry;
    const { recipe: _recipe, recipeBy: _by, proposals: _proposals, ...bare } = entry;
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
        ...(recipe === undefined || entry.recipeBy === undefined ? {} : { recipeBy: entry.recipeBy }),
        ...(proposals === undefined ? {} : { proposals }),
      };
    } catch {
      return bare;
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

  private async closeCard(proposal: LoginRecipeProposal, note: string): Promise<void> {
    if (proposal.agendaItemId === undefined) return;
    await this.ports.agenda.close(proposal.sessionId, proposal.agendaItemId, note).catch(() => undefined);
  }

  private async record(id: LoginEntryId, action: string, proposal: string, session: string): Promise<void> {
    await this.ports.audit
      .record({
        event: 'secrets.changed',
        actor: { kind: 'host' },
        subject: id,
        outcome: 'succeeded',
        detail: { action, proposal, session, by: 'agent' },
      })
      .catch(() => undefined);
  }
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
 * approves or declines on the login's Recipe in Settings, or with `fy account recipe`, and the card closes.
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
