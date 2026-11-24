/**
 * The input modal's pure part: which pending card comes first, which is stale, which card a notification tap names,
 * and the one plain signal "an input modal is open".
 *
 * Nothing here reads, keeps or logs a value: a request is facts and prompts only (the value travels only in a deliver
 * body, `input-api.ts`), and a pairing code is not an input request at all, so it can never reach this modal.
 */
import { AgendaIdSchema } from '@ferretry/core-asks/contract';
import type { InputRequest } from '../../contract/index.ts';
import { asksCode } from './input-card.ts';

/** A card older than this was observed a while ago: opening it reads the request again at once. */
export const STALE_CARD_MS = 60_000;

/**
 * The page-wide signal that an input modal is on screen: this attribute on `<html>`, present while any machine's modal
 * is open and absent otherwise. A plain DOM fact so other parts of the app (the browser panel's page reveal) can leave
 * the phone's panels alone while the owner is typing a sign-in, without importing anything from the vault.
 */
export const INPUT_MODAL_ATTRIBUTE = 'data-fy-input-modal';

let openModals = 0;

/** Marks one modal open; the returned function marks it closed (once). The attribute follows the count. */
export function holdModalSignal(): () => void {
  openModals += 1;
  document.documentElement.setAttribute(INPUT_MODAL_ATTRIBUTE, 'open');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openModals -= 1;
    if (openModals <= 0) {
      openModals = 0;
      document.documentElement.removeAttribute(INPUT_MODAL_ATTRIBUTE);
    }
  };
}

const rank = (request: InputRequest): number => (asksCode(request) ? 0 : 1);

/**
 * The open cards in the order the modal shows them: a code card first (a code expires in seconds), newest first inside
 * each group. A request already past `pending` (delivering, delivered, refused, expired, cancelled) is not asked again.
 */
export function orderPending(requests: readonly InputRequest[]): readonly InputRequest[] {
  return requests
    .filter(request => request.state === 'pending')
    .toSorted((a, b) => rank(a) - rank(b) || Date.parse(b.raisedAt) - Date.parse(a.raisedAt));
}

/** Whether the card was raised longer ago than {@link STALE_CARD_MS}. */
export function isStale(request: InputRequest, now: number): boolean {
  const raised = Date.parse(request.raisedAt);
  return Number.isFinite(raised) && now - raised > STALE_CARD_MS;
}

/** The ask id (`A3`) a notification's routed address names with `?ask=`, or `undefined` for anything else. */
export function askFromUrl(url: string): string | undefined {
  let raw: string | null;
  try {
    raw = new URL(url, 'https://app.invalid').searchParams.get('ask');
  } catch {
    return undefined;
  }
  const parsed = AgendaIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Which card the modal shows after a read.
 *
 * - The card a tap named, when the daemon lists it: the owner asked for exactly that one.
 * - Otherwise the card on screen stays (so a Send in flight is never swapped out) while the daemon still lists it, or
 *   while it has settled and is saying what happened.
 * - Otherwise the first of {@link orderPending} the owner has not put off.
 */
export function chooseCard(input: {
  readonly requests: readonly InputRequest[];
  readonly currentId: string | undefined;
  readonly settled: boolean;
  readonly dismissed: ReadonlySet<string>;
  readonly pinnedAsk: string | undefined;
}): string | undefined {
  const { requests, currentId, settled, dismissed, pinnedAsk } = input;
  const pinned =
    pinnedAsk === undefined ? undefined : orderPending(requests).find(request => request.agendaItemId === pinnedAsk);
  if (pinned !== undefined) return pinned.id;
  if (currentId !== undefined && (settled || requests.some(request => request.id === currentId))) return currentId;
  return orderPending(requests).find(request => !dismissed.has(request.id))?.id;
}

/**
 * Which card a notification tap asked for, per machine, until the modal of that machine takes it. The tap can arrive
 * before the modal mounts (the app was starting), so it is kept here: an ask id and nothing else.
 */
const wanted = new Map<string, string>();
const listeners = new Set<(daemon: string) => void>();

export const tappedAsks = {
  /** A tap on a notification of `daemon` named `ask`. */
  want(daemon: string, ask: string): void {
    wanted.set(daemon, ask);
    for (const listener of [...listeners]) listener(daemon);
  },
  /** The ask `daemon`'s modal has not yet shown, handed out once. */
  take(daemon: string): string | undefined {
    const ask = wanted.get(daemon);
    wanted.delete(daemon);
    return ask;
  },
  subscribe(listener: (daemon: string) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
