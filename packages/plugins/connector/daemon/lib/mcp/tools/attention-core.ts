/**
 * The agenda, as the connector reads it: who raised an item, whether it is open for the owner, which items a name means, and
 * how a spoken answer becomes the response an ask accepts — or why it cannot. Pure, over what `FleetGateway` reads.
 */
import { type AgendaItem, type AgendaKind, type AgendaResponse, agendaWakeAt } from '@ferretry/core-asks/contract';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import { clip, oneLine } from '../format.ts';
import { type OpenAgendaItem, ToolFailure } from '../gateway.ts';
import { matchName } from '../names.ts';
import { callsignOf, resolveFerret } from './ferrets.ts';
import type { ToolEnvironment } from './spec.ts';

export function askerOf(item: AgendaItem, byId: ReadonlyMap<string, FerretSummary>): string {
  if (item.raisedBy === 'human') return 'you';
  if (item.raisedBy === 'daemon') return 'Ferretry';
  const session = byId.get(item.raisedBySession);
  return session === undefined ? (item.raisedByName ?? 'a ferret') : callsignOf(session);
}

/** True when the item sits on this ferret's board or the ferret raised it. */
export const belongsTo = (entry: OpenAgendaItem, wanted: FerretSummary): boolean =>
  entry.sessionId === wanted.id || (entry.item.raisedBy === 'agent' && entry.item.raisedBySession === wanted.id);

/**
 * True while an item is put away: snoozed, and not yet due. A snoozed item whose time has come is listed, even
 * before the daemon's minute timer has woken it.
 */
export const isAsleep = (item: AgendaItem, now: number): boolean => {
  const wake = agendaWakeAt(item);
  return item.parked?.reason === 'snoozed' && wake !== null && Date.parse(wake) > now;
};

/**
 * "Open for the owner now": not parked, or snoozed with its time come. The ONE predicate that decides what
 * list_attention shows, which items answer_attention may close, and which items count when two share an id.
 */
export const openForOwner = (item: AgendaItem, now: number): boolean =>
  item.parked === undefined || (item.parked.reason === 'snoozed' && !isAsleep(item, now));

/**
 * The items that carry `id`, narrowed to one ferret's when the caller names one. Shared by every tool that takes an
 * item id, so `get_attention` and `answer_attention` find the same item from the same words. A ferret the caller
 * NAMES is always honoured: when it has no such item the answer is a refusal, never another ferret's item that
 * happens to carry the same id. `counts` says which items are candidates at all: reading and snoozing see every
 * parked item, answering only the ones {@link openForOwner}.
 */
export async function itemsNamed(
  env: ToolEnvironment,
  items: readonly OpenAgendaItem[],
  id: string,
  ferret: string | undefined,
  counts: (item: AgendaItem) => boolean,
): Promise<OpenAgendaItem[]> {
  const found = items.filter(entry => entry.item.id === id && counts(entry.item));
  if (ferret === undefined) return found;
  const wanted = await resolveFerret(env.gateway, ferret, 'act');
  const mine = found.filter(entry => belongsTo(entry, wanted));
  if (mine.length === 0) throw new ToolFailure(`${callsignOf(wanted)} has no open item ${id}.`);
  return mine;
}

function optionsOf(item: AgendaItem): readonly string[] {
  return item.ask?.kind === 'multiple-choice' ? item.ask.options.map(option => option.label) : [];
}

/**
 * Text a ferret wrote, as one short line: the WHOLE raw text goes through the redaction door first and is cut
 * after, so a credential that spans the cutoff is never left as a fragment.
 */
const shortClean = async (env: ToolEnvironment, text: string, max: number): Promise<string> =>
  clip(oneLine(await env.clean(text)), max);

/** An item's name, cleaned then cut: its title, else its summary. */
export const itemName = async (env: ToolEnvironment, item: AgendaItem, max: number): Promise<string> =>
  await shortClean(env, item.title ?? item.subject, max);

/** One open item as a line a voice reads: id, who asks, title, the question, its options, and when only the app can answer it. */
export async function attentionLine(
  env: ToolEnvironment,
  item: AgendaItem,
  byId: ReadonlyMap<string, FerretSummary>,
): Promise<string> {
  const options = optionsOf(item);
  const choices = options.length === 0 ? '' : ` Options: ${options.join(', ')}.`;
  const appOnly = needsTheApp(item) ? ' Only the Ferretry app can answer this one.' : '';
  return `!${item.id} — from ${askerOf(item, byId)} — ${await itemName(env, item, 80)} — ${await shortClean(env, item.why, 240)}${choices}${appOnly}`;
}

/** "A12", "!A12", "a 12", "12" → "A12"; undefined when it is none of those. */
export function parseAttentionRef(raw: string): string | undefined {
  const match = /^\s*!?\s*a?\s*0*([1-9][0-9]{0,8})\s*$/iu.exec(raw);
  return match === null ? undefined : `A${match[1]}`;
}

type AnswerShape =
  | { readonly kind: 'response'; readonly response: AgendaResponse }
  | { readonly kind: 'done' }
  | { readonly kind: 'refuse'; readonly sentence: string; readonly refused: boolean };

const YES = ['yes', 'yep', 'yeah', 'ok', 'okay', 'approve', 'approved', 'allow', 'allowed', 'good', 'sure'];
const NO = ['no', 'nope', 'reject', 'rejected', 'deny', 'denied', 'refuse'];
const bare = (text: string): string => text.toLowerCase().replace(/[^a-z]/gu, '');

/** The card kinds a spoken answer may close: a plain question, a choice, a yes/no, a review, a to-do, a note. */
const PLAIN_KINDS: readonly (AgendaKind | undefined)[] = [
  undefined,
  'task',
  'yesno',
  'permission',
  'choice',
  'review',
  'reply',
  'info',
];

/**
 * What makes an item an act only the OWNER does in the app, whatever its ask says: a held configuration change
 * (`confirms`), a card's task asks (`cardAsks`), a task plan, a paste plan, a phone
 * approval, a 2FA seed, a sign-in rule, a form (`fields`), a typed value (`input`), a machine notice's cards.
 * Each of those is approved with a passkey or its own form, and a voice answer must never stand in for it.
 *
 * The primary defence is the daemon's boundary, which refuses these when the caller arrives governed; this is
 * the second, so the connector would not even TRY, and so it never reads like it could.
 */
const OWNER_ONLY_FIELDS = [
  'confirms',
  'cardAsks',
  'input',
  'copyPlan',
  'taskPlan',
  'phoneApproval',
  'twoFactorSeed',
  'signInRuleSuggestion',
  'signInRuleSuspended',
  'cards',
  'fields',
] as const satisfies readonly (keyof AgendaItem)[];

const OWNER_ONLY_SENTENCE = 'That one needs your passkey in the Ferretry app.';

/**
 * True for any item a spoken answer may not close. An ALLOW-list of plain asks, not a list of bad ones: an item
 * is answerable only when its kind is one of {@link PLAIN_KINDS} AND it carries none of the owner-only fields,
 * so a kind or field added later is refused until someone decides a voice may answer it.
 */
export function needsTheApp(item: AgendaItem): boolean {
  if (!PLAIN_KINDS.includes(item.kind)) return true;
  return OWNER_ONLY_FIELDS.some(field => item[field] !== undefined);
}

/** How a spoken answer becomes the response this item's ask accepts — or why it cannot. Pure. */
export function shapeAnswer(item: AgendaItem, answer: string): AnswerShape {
  if (item.kind === 'input')
    return {
      kind: 'refuse',
      sentence: 'That one asks for a value that can only be typed in the Ferretry app.',
      refused: true,
    };
  if (needsTheApp(item)) return { kind: 'refuse', sentence: OWNER_ONLY_SENTENCE, refused: true };
  const ask = item.ask;
  if (ask === undefined || ask.kind === 'task') return { kind: 'done' };
  switch (ask.kind) {
    case 'open-question':
      return { kind: 'response', response: { kind: 'open-question', answer } };
    case 'permission': {
      const word = bare(answer);
      if (YES.includes(word)) return { kind: 'response', response: { kind: 'permission', decision: 'approve' } };
      if (NO.includes(word)) return { kind: 'response', response: { kind: 'permission', decision: 'reject' } };
      return { kind: 'refuse', sentence: 'That is a permission request. Say approve or reject.', refused: false };
    }
    case 'answer-review': {
      if (YES.includes(bare(answer))) return { kind: 'response', response: { kind: 'answer-review', verdict: 'good' } };
      return { kind: 'response', response: { kind: 'answer-review', verdict: 'clarify', clarification: answer } };
    }
    case 'multiple-choice': {
      const labels = ask.options.map(option => option.label);
      const result = matchName(answer, labels, label => ({ exact: [label], names: [] }));
      if (result.kind === 'one')
        return { kind: 'response', response: { kind: 'multiple-choice', choice: result.item } };
      return { kind: 'refuse', sentence: `Pick one of these: ${labels.join(', ')}.`, refused: false };
    }
  }
}
