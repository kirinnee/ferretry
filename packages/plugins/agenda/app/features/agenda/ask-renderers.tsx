/**
 * THE PART OF AN ASK ANOTHER PLUGIN DRAWS (§5.2): an ask whose answer is not the Agenda's to take — a staged 2FA seed,
 * an approve-on-phone, a ferret's task or paste plan, a sign-in rule suggestion, a typed value for a prompt — is
 * answered with its owner's own controls, through that owner's routes. Today the inbox imported each owner's card
 * (`TwoFactorSeedHost`, `PhoneApprovalHost`, `TaskPlanHost`, `CopyPlanHost`, `SignInRuleSuggestionHost`,
 * `InputCardHost`); here each is mounted by its RENDERER KEY, so the owner draws it and this half imports none of
 * them. A notice's cards are drawn by {@link AgendaCardsHost}, its Start and Close through a host's board.
 *
 * - `ask:sign-in-approval` is Accounts': the value names the ref's kind (`two-factor-seed`, `phone-approval`,
 *   `task-plan`, `copy-plan`, `rule-suggestion`), or is the ref the daemon's
 *   Asks port kept on the item (`askRef`: a `recipe-proposal`) with the ask's words, the shape Accounts' renderer reads.
 * - `ask:input` is the owner of input requests (Vault contributes it): where Vault is not installed, an input card shows
 *   its words and the answer row only.
 *
 * Nothing owns the key (or there is no shell): nothing extra is drawn and the card keeps its own words.
 */

import type { ReactNode } from 'react';
import type { AgendaItem, AskOnScreen } from '@ferretry/core-asks/contract';
import type { AgendaInbox } from '../../hooks/use-agenda-inbox.ts';
import type { InboxCard } from '../../lib/agenda-inbox.ts';
import { inboxWho } from '../../lib/agenda-inbox-list.ts';
import { RendererView } from '../../shell.ts';
import { AgendaCardsHost } from './agenda-cards-host.tsx';

/** Accounts' renderer for the asks its sign-ins, plans and phone approvals raise. */
const SIGN_IN_APPROVAL_RENDERER = 'ask:sign-in-approval';
/** The obligation prefix of an ask Accounts raised: `ask:sign-in-approval:<entry>`. */
const SIGN_IN_APPROVAL_OBLIGATION = 'ask:sign-in-approval:';

/** The input-request owner's renderer for a value typed into a prompt. */
export const INPUT_RENDERER = 'ask:input';

/** An input request's id: 32 hex digits, the id the input form routes by. */
const REQUEST_ID = /^[0-9a-f]{32}$/u;

/**
 * The input request an `input` card was raised for: the item's own `input` when it has one, else the entry its
 * obligation names (`ask:input:<request id>`, how the Asks port raises it). `undefined` when it names none.
 */
const inputRequestOf = (item: AgendaItem): string | undefined => {
  if (item.input !== undefined) return item.input.requestId;
  const entry = item.sourceRef?.startsWith('ask:input:') === true ? item.sourceRef.slice('ask:input:'.length) : '';
  return REQUEST_ID.test(entry) ? entry : undefined;
};

/** Who an ask is from, for the renderer that draws part of it: the ferret's id and spoken name, and its project. */
export interface AskFrom {
  readonly ferret: string;
  readonly ferretName: string;
  readonly projectId?: string | undefined;
}

const onScreen = (item: AgendaItem, ref: AskOnScreen['ref'], from: AskFrom): AskOnScreen => ({
  ref,
  subject: item.subject,
  ...(item.why === undefined || item.why === null ? {} : { why: item.why }),
  ...(item.context === undefined || item.context === null ? {} : { context: item.context }),
  ferret: from.ferret,
  ferretName: from.ferretName,
  ...(from.projectId === undefined ? {} : { projectId: from.projectId }),
});

/** Which owner draws this item's own part, and with what; `undefined` for an item the Agenda answers alone. */
export const askRendererFor = (
  item: AgendaItem,
  from: AskFrom,
): { readonly key: string; readonly value: AskOnScreen; readonly slot: 'plan' | 'input' } | undefined => {
  if (item.taskPlan !== undefined)
    return {
      key: SIGN_IN_APPROVAL_RENDERER,
      slot: 'plan',
      value: onScreen(item, { kind: 'task-plan', planId: item.taskPlan.planId }, from),
    };
  if (item.signInRuleSuggestion !== undefined)
    return {
      key: SIGN_IN_APPROVAL_RENDERER,
      slot: 'plan',
      value: onScreen(item, { kind: 'rule-suggestion', suggestion: item.signInRuleSuggestion.suggestion }, from),
    };
  if (item.copyPlan !== undefined)
    return {
      key: SIGN_IN_APPROVAL_RENDERER,
      slot: 'plan',
      value: onScreen(item, { kind: 'copy-plan', planId: item.copyPlan.planId }, from),
    };
  if (item.phoneApproval !== undefined)
    return {
      key: SIGN_IN_APPROVAL_RENDERER,
      slot: 'plan',
      value: onScreen(item, { kind: 'phone-approval', id: item.phoneApproval.id }, from),
    };
  if (item.twoFactorSeed !== undefined)
    return {
      key: SIGN_IN_APPROVAL_RENDERER,
      slot: 'plan',
      value: onScreen(item, { kind: 'two-factor-seed', stage: item.twoFactorSeed.stage }, from),
    };
  // An ask Accounts raised through Asks: the daemon's own ref (a recipe proposal, a plan...) is the ref its card is drawn from.
  if (item.askRef !== undefined && item.sourceRef?.startsWith(SIGN_IN_APPROVAL_OBLIGATION) === true)
    return { key: SIGN_IN_APPROVAL_RENDERER, slot: 'plan', value: onScreen(item, item.askRef, from) };
  if (item.kind === 'input') {
    const request = inputRequestOf(item);
    return {
      key: INPUT_RENDERER,
      slot: 'input',
      value: onScreen(item, request === undefined ? { kind: 'input' } : { kind: 'input', request }, from),
    };
  }
  return undefined;
};

/**
 * The form an `input` card is answered with, the owner's card of a plan or approval, or the cards of a notice; nothing
 * for any other kind (or a machine that is not paired here).
 */
export const askFormFor = (
  inbox: AgendaInbox,
  card: InboxCard,
  onNavigate: (to: string) => void,
): { readonly inputForm?: ReactNode; readonly planForm?: ReactNode; readonly cardsForm?: ReactNode } => {
  const connection = inbox.connectionFor(card.daemonId);
  if (connection === undefined) return {};
  if (card.item.cards !== undefined)
    return { cardsForm: <AgendaCardsHost cards={card.item.cards} connection={connection} onNavigate={onNavigate} /> };
  const who = inboxWho(card);
  const owned = askRendererFor(card.item, {
    ferret: card.view.config.id,
    ferretName: who.ferret,
    projectId: card.view.config.projectId,
  });
  if (owned === undefined) return {};
  const drawn = <RendererView daemon={connection.daemonId} rendererKey={owned.key} value={owned.value} />;
  return owned.slot === 'input' ? { inputForm: drawn } : { planForm: drawn };
};
