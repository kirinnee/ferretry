/**
 * What the member's screens say and decide, as pure functions: the join steps' copy, the countdown's
 * spoken thresholds, how a publisher's answer becomes a card, and which items a catalog lists.
 *
 * The sentences a publisher or the controller already owns stay in `shared-model.ts`; only words that
 * belong to a screen live here.
 */

import type { SharedCatalogManifestEntry, ShareLinkSeed } from '@ferretry/protocol';
import { revealHidden } from '@ferretry/protocol';
import { fingerprintHead, type MemberSubscription } from '../../lib/member-keys.ts';
import type { Attempt, RedeemOutcome, SharedBrowse, SharedCatalogView } from './shared-controller.ts';
import {
  JOIN_REFUSED_SENTENCE,
  type PasskeyWindow,
  type Problem,
  redeemedSentence,
  WINDOW_CLOSED_SENTENCE,
} from './shared-model.ts';

export const TRY_AGAIN = 'Try again';
export const BACK_TO_START = 'Back to start';
export const BACK_TO_MACHINES = '‹ Your machines';
export const JOIN_BUTTON = 'Join';
export const JOINING = 'Joining…';
export const JOIN_NOTHING_SENT = 'Nothing is sent until you tap Join.';
export const JOIN_TITLE = 'Join this catalog';
export const INVALID_TITLE = 'This link does not work';
export const OLD_KEY_NOTE =
  'This browser has an old key for this publisher, and the publisher refused it. It is only replaced after you join.';
export const PASSKEY_ADDED = 'Passkey added. Now unlock with it.';
export const OPEN_SHARED = 'Open Shared with me';
export const ADD_FROM_LINK = 'Add what is in this link';
export const ADDING = 'Adding…';
export const UNLOCK_THEN_LINK = 'Unlock with your passkey first. Then add what is in this link.';
export const UNLOCKED_THEN_LINK = 'Unlocked. Now add what is in this link.';
export const REDEEM_LOCKED_SENTENCE = 'Unlock with your passkey first, then open the link again.';
export const WORKING = 'Working…';
export const NO_ITEMS = 'This catalog has no items yet.';
export const LOADING_CATALOGS = 'Reading what is shared with you…';
export const SEE_SHARED = 'Shared with me';
export const SHARED_ENTRY_NOTE = 'Catalogs people shared with you.';
export const CONFIRM_FORGET = 'Remove this key from this browser?';
export const CONFIRM_FORGET_YES = 'Yes, forget it';
export const CONFIRM_LEAVE = 'Leave this publisher?';
export const CONFIRM_LEAVE_YES = 'Yes, leave';
export const KEEP = 'Keep it';
export const RENAME = 'Rename';
export const SAVE_NAME = 'Save name';
export const CANCEL = 'Cancel';
export const NAME_LABEL = 'Your name for this publisher';
export const NAME_PROBLEM = 'Use between 1 and 60 characters.';
export const NAME_NOT_SAVED = 'That name was not saved. Try again.';
export const INSTALL_ON_MACHINE = 'Install on a machine';
export const INSTALL_ON_LABEL = 'Install on';
export const OPENING_ITEM = 'Opening…';
export const NOT_PAIRED_NOTE = 'To install this, pair a machine with this browser first.';

/** The host of the publisher's address, to read beside the fingerprint. */
export function shareHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface JoinFacts {
  readonly host: string;
  readonly fingerprint: string;
  readonly fingerprintFull: string;
}

/** What a person can compare before joining: where the link points and the start of the fingerprint. */
export function joinFacts(seed: ShareLinkSeed): JoinFacts {
  return {
    host: shareHost(seed.daemonUrl),
    fingerprint: fingerprintHead(seed.daemonId),
    fingerprintFull: seed.daemonId,
  };
}

/** The countdown's spoken line. It changes at a threshold only, so a screen reader is not read to every second. */
export function windowAnnouncement(window: PasskeyWindow): string {
  if (!window.open) return WINDOW_CLOSED_SENTENCE;
  return window.urgent ? 'Less than a minute left to add a passkey.' : '';
}

/** `null` when a label is fine to keep, else the sentence. */
export function nameProblem(label: string): string | null {
  const length = label.trim().length;
  return length >= 1 && length <= 60 ? null : NAME_PROBLEM;
}

export function kindLabel(kind: SharedCatalogManifestEntry['kind']): string {
  return kind === 'skill' ? 'Skill' : kind === 'mcp' ? 'MCP server' : 'File';
}

export interface ItemLine {
  readonly entry: SharedCatalogManifestEntry;
  readonly title: string;
  readonly summary: string;
}

export function itemLine(entry: SharedCatalogManifestEntry): ItemLine {
  return {
    entry,
    title: `${revealHidden(entry.name)} · ${kindLabel(entry.kind)} · version ${entry.version}`,
    summary: revealHidden(entry.summary),
  };
}

type CatalogBlock =
  | { readonly kind: 'problem'; readonly catalogId: string; readonly name: string; readonly sentence: string }
  | {
      readonly kind: 'ok';
      readonly catalogId: string;
      readonly name: string;
      readonly view: SharedCatalogView;
      readonly items: readonly ItemLine[];
    };

/** A catalog that did not verify shows only its problem. One that did shows its items and nothing else. */
export function catalogBlock(view: SharedCatalogView): CatalogBlock {
  const name = revealHidden(view.name);
  if (view.problem !== undefined || view.manifest === undefined)
    return {
      kind: 'problem',
      catalogId: view.catalogId,
      name,
      sentence: view.problem ?? '',
    };
  return { kind: 'ok', catalogId: view.catalogId, name, view, items: view.manifest.items.map(itemLine) };
}

/** What one publisher's card shows, from the answer to "what is shared with me". */
export type CardState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly blocks: readonly CatalogBlock[] }
  | { readonly kind: 'locked' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'failed'; readonly sentence: string }
  | { readonly kind: 'refused' };

const problemState = (problem: Problem): CardState => {
  if (problem.kind === 'locked') return { kind: 'locked' };
  if (problem.kind === 'unreachable') return { kind: 'offline' };
  return { kind: 'failed', sentence: problem.sentence };
};

export function cardState(attempt: Attempt<SharedBrowse>): CardState {
  if (attempt.kind === 'refused') return { kind: 'refused' };
  if (attempt.kind === 'failed') return problemState(attempt.problem);
  return { kind: 'ok', blocks: attempt.value.catalogs.map(catalogBlock) };
}

/** Whether a subscription can be asked for anything: a refused one is shown as refused, and asked nothing. */
export const isRefused = (subscription: MemberSubscription): boolean => subscription.status === 'refused';

interface RedeemView {
  readonly kind: 'added' | 'refused' | 'locked';
  readonly sentence: string;
}

/** What opening a link with a key already here came to, said in one sentence and one of three ways. */
export function redeemView(outcome: RedeemOutcome): RedeemView {
  if (outcome.kind === 'added' && outcome.response !== undefined)
    return { kind: 'added', sentence: redeemedSentence(outcome.response) };
  const sentence = outcome.sentence ?? JOIN_REFUSED_SENTENCE;
  return sentence === REDEEM_LOCKED_SENTENCE
    ? { kind: 'locked', sentence: UNLOCK_THEN_LINK }
    : { kind: 'refused', sentence };
}
