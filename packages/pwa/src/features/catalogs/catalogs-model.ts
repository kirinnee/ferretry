/**
 * What the owner's catalog screens say and decide, as pure functions over what the daemon answered.
 *
 * Plain words, short lines, one idea each. Nothing here reads a source or recomputes a review: the
 * daemon answers those, and the app shows them.
 */

import {
  type CatalogSourceState,
  CatalogLabelSchema,
  type OwnedCatalog,
  type OwnedCatalogItem,
  type OwnedSharedItem,
  type QuickAddAnswer,
  type QuickAddUndone,
  type SharedItemPreview,
  PairedDeviceIdSchema,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { deviceGrantCommand, grantRefusalNotice } from '../../lib/grants.ts';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';
import { plural } from './catalog-review-model.ts';
import { sameAsVersionSentence } from './versions-model.ts';

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

export const FROZEN_COPY_NOTE = 'A frozen copy is shared. Later edits stay here until you press Publish update.';

export const PUBLISH_COPY_NOTE = 'This freezes a new version. Copies people already have stay as they are.';

export const EXPORT_NOTE = 'The file is signed by this machine. Anyone you send it to can check that, offline.';

export const CATALOGS_INTRO =
  'Share a catalog with someone by link. They read it; nothing on this machine is theirs to change.';

export const SHARING_OFF_TITLE = 'Sharing is off for this device';

/**
 * The command that turns Sharing on for one device.
 *
 * With this device's own id the owner can paste it as it is. A daemon-issued id is safe to put in a
 * command line; a device NAME is not, so a name is never used. Without a valid id it stays `<device>`.
 */
export const sharingGrantCommand = (deviceId: string | null = null): string => {
  const command = deviceGrantCommand('sharing', 'use');
  return deviceId !== null && PairedDeviceIdSchema.safeParse(deviceId).success
    ? command.replace('<device>', deviceId)
    : command;
};

export const SHARING_GRANT_COMMAND = sharingGrantCommand();

export const SHARING_OFF_LINES: readonly string[] = [
  'This device may not make or export catalogs yet.',
  'A device that has Sharing on and may manage devices can turn it on for this one in Settings › Devices.',
  'Or run this on the machine itself:',
];

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

export interface OwnerRefusal {
  readonly sentence: string;
  /** The source changed under the preview: the next step is to preview it again. */
  readonly previewAgain: boolean;
  /** This device may not use Sharing at all, so the screen explains that instead of the sentence. */
  readonly sharingOff: boolean;
}

const OWNER_REFUSALS: Readonly<Record<string, string>> = {
  changed_since_preview:
    'This changed since you previewed it. Nothing was added. Preview it again to see what it is now.',
  nothing_to_publish: 'Nothing to publish: the source is the same as the version already in the catalog.',
  name_taken: 'You already have a catalog with that name. Pick another name.',
  catalog_full: 'This catalog is full. Withdraw an item or start another catalog.',
  catalog_unknown: 'That catalog is gone. Go back to the list and look again.',
  item_unknown: 'That item is gone from this catalog.',
  item_withdrawn: 'That item was withdrawn, so it cannot get a new version.',
  public_unavailable: 'A public catalog is not available yet.',
  signing_unavailable: 'This machine cannot sign right now. Restart it and try again.',
  export_too_big: 'This catalog is too big to export as one file. Withdraw an item or start another catalog.',
  catalogs_full:
    'You already have as many catalogs as this machine allows (256). Delete one you do not use, then try again.',
  items_full: 'This machine already keeps as many shared items as it allows. Stop sharing one, then try again.',
  item_listed: 'That is already in this catalog.',
  current_changed: 'The item has a newer version than the one you read. Here is what it is now.',
  undo_expired: 'Undo ran out of time, so nothing was changed. Withdraw it from the catalog if you want it gone.',
  source_ambiguous:
    'This machine shares that more than once, so it cannot tell which one you mean. Pick a catalog below.',
  grant_step_up_required: 'Nothing was changed: the passkey wasn’t confirmed. Try again and confirm it.',
  same_as_version: 'That is a version you already keep. Make it current instead of publishing it again.',
  version_current: 'Make another version current first.',
  version_retired: 'That version is retired. Bring it back first, then make it current.',
  version_unknown: 'That version is not there any more. The list is out of date; look again.',
};

/** The daemon's own sentence names the version and the catalogs: `Version 2 of x is not one A, B may serve: …`. */
const BEFORE_JOIN_DAEMON = /^Version (\d+) of .+? is not one (.+) may serve:/su;

const KEEP_OR_NEWER = 'Keep the current version, or make a newer one current.';

/**
 * Plain words for a version a catalog that was added later may not offer. The names come out of the daemon's
 * sentence (the wire carries nothing else); a sentence that does not read that way says the same without them.
 */
function beforeJoinSentence(message: string): string {
  const found = BEFORE_JOIN_DAEMON.exec(message);
  const version = found?.[1];
  const named = found?.[2];
  if (version === undefined || named === undefined)
    return `A catalog that was added later can't offer that version. ${KEEP_OR_NEWER}`;
  const names = named.split(', ');
  const one = names.length === 1;
  const list = one ? named : `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`;
  return `${list} ${one ? 'was' : 'were'} added after version ${version}, so ${one ? 'it' : 'they'} can't offer version ${version}. ${KEEP_OR_NEWER}`;
}

export function ownerRefusal(error: unknown): OwnerRefusal {
  if (grantRefusalNotice(error) !== null && !(error instanceof FyHttpError && error.code === 'grant_step_up_required'))
    return { sentence: SHARING_OFF_TITLE, previewAgain: false, sharingOff: true };
  const code = error instanceof FyHttpError ? error.code : undefined;
  const known =
    code === 'version_before_join' && error instanceof FyHttpError
      ? beforeJoinSentence(error.message)
      : code === undefined
        ? undefined
        : OWNER_REFUSALS[code];
  return {
    sentence: known ?? changeRefusalSentence(error),
    previewAgain: code === 'changed_since_preview' || code === 'current_changed',
    sharingOff: false,
  };
}

// ── Catalogs and items ───────────────────────────────────────────────────────────────────────────

const live = (catalog: OwnedCatalog): readonly OwnedCatalogItem[] =>
  catalog.items.filter(item => item.withdrawnAt === undefined);

/** "3 items · revision 4" */
export function catalogSummary(catalog: OwnedCatalog): string {
  return `${plural(live(catalog).length, 'item')} · revision ${catalog.revision}`;
}

export function latestVersion(item: OwnedCatalogItem): number {
  return item.versions.at(-1)?.version ?? 1;
}

export interface ItemState {
  readonly label: string;
  readonly detail: string | null;
  readonly tone: 'ok' | 'caution' | 'muted';
  /** "Source changed — Publish update" is offered. */
  readonly canPublish: boolean;
}

const STATE_WORDS: Readonly<Record<CatalogSourceState, Omit<ItemState, 'detail'>>> = {
  unchanged: { label: 'Up to date', tone: 'ok', canPublish: false },
  changed: { label: 'Source changed', tone: 'caution', canPublish: true },
  unavailable: { label: 'Source not found', tone: 'caution', canPublish: false },
  withdrawn: { label: 'Withdrawn', tone: 'muted', canPublish: false },
};

/** How one item reads. A withdrawn item is withdrawn whatever the source says; no state yet says nothing. */
export function itemState(item: OwnedCatalogItem): ItemState | null {
  const state: CatalogSourceState | undefined = item.withdrawnAt === undefined ? item.sourceState : 'withdrawn';
  if (state === undefined) return null;
  return { ...STATE_WORDS[state], detail: state === 'unavailable' ? (item.sourceNote ?? null) : null };
}

/** `Team skills` → `Team-skills.catalog.json`. Letters and digits of any language stay; the rest becomes `-`. */
export function exportFileName(catalogName: string): string {
  const stem = catalogName
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '');
  return `${stem === '' ? 'catalog' : stem}.catalog.json`;
}

// ── Choosing where to add ────────────────────────────────────────────────────────────────────────

export type CatalogChoice =
  | { readonly kind: 'existing'; readonly catalogId: string }
  | { readonly kind: 'new'; readonly name: string };

/** Why this choice cannot go on, in words, or `null` when it can. */
export function choiceProblem(choice: CatalogChoice | null, catalogs: readonly OwnedCatalog[]): string | null {
  if (choice === null) return 'Pick a catalog, or name a new one.';
  if (choice.kind === 'existing')
    return catalogs.some(catalog => catalog.id === choice.catalogId) ? null : 'That catalog is gone. Pick another.';
  if (choice.name.trim() === '') return 'Give the new catalog a name.';
  const label = CatalogLabelSchema.safeParse(choice.name.trim());
  if (!label.success) return 'Use a shorter name with no line breaks or hidden characters.';
  const taken = catalogs.some(catalog => catalog.name.toLowerCase() === choice.name.trim().toLowerCase());
  return taken ? 'You already have a catalog with that name. Pick it above, or use another name.' : null;
}

/**
 * Where the preview is read. A preview freezes nothing and does not depend on the catalog, so a new
 * catalog previews against any existing one and is only made when the person presses Add. The first
 * ever catalog has nothing to preview against, so it is made first.
 */
export type PreviewPlan =
  | { readonly kind: 'use'; readonly catalogId: string }
  | { readonly kind: 'make-first'; readonly name: string };

export function previewPlan(choice: CatalogChoice, catalogs: readonly OwnedCatalog[]): PreviewPlan {
  if (choice.kind === 'existing') return { kind: 'use', catalogId: choice.catalogId };
  const first = catalogs[0];
  return first === undefined ? { kind: 'make-first', name: choice.name.trim() } : { kind: 'use', catalogId: first.id };
}

/** The label on the button that reads the source. */
export function previewButtonLabel(plan: PreviewPlan): string {
  return plan.kind === 'make-first' ? 'Make the catalog and preview' : 'Preview';
}

/** What Add may do, from the preview in hand. Add is bound to exactly that preview's digest. */
export function addState(
  preview: SharedItemPreview | null,
  busy: boolean,
  canMakeCurrent = false,
): { enabled: boolean; reason: string | null } {
  if (preview === null) return { enabled: false, reason: 'Preview it first, so you can read what will be shared.' };
  if (preview.sameAsVersion !== undefined)
    return {
      enabled: false,
      reason: canMakeCurrent
        ? sameAsVersionSentence(preview.sameAsVersion)
        : `This is the same as version ${preview.sameAsVersion}. There is nothing new to publish.`,
    };
  return { enabled: !busy, reason: null };
}

// ── The default catalog, and one-tap Add ─────────────────────────────────────────────────────────

/** How long the Added toast waits for an Undo. The daemon keeps the token longer (60 s), so a slow link still lands. */
export const ADDED_TOAST_MS = 10_000;

/** How long the plain toasts ("Already in …", what Undo did) stay. */
export const NOTE_TOAST_MS = 4_000;

/** "default" on the catalog one tap adds to; the others say nothing. */
export const roleLabel = (catalog: OwnedCatalog, defaultCatalogId?: string): string | null =>
  catalog.role === 'default' || catalog.id === defaultCatalogId ? 'default' : null;

/** The catalog one tap adds to, if this machine has made one. */
export const defaultCatalogOf = (
  catalogs: readonly OwnedCatalog[],
  defaultCatalogId: string | undefined,
): OwnedCatalog | undefined =>
  catalogs.find(catalog => catalog.id === defaultCatalogId) ?? catalogs.find(catalog => catalog.role === 'default');

/**
 * The name the machine gives the default catalog the first time one tap makes it ("kirin-box's skills"). The
 * daemon has the final say; this is what the app says will happen, and the name it offers in the sheet.
 */
export function defaultCatalogName(machineName: string | undefined): string {
  const label = [...(machineName?.trim() ?? '')].slice(0, 71).join('');
  return label === '' ? 'My skills' : `${label}’s skills`;
}

/** What the one-tap Publish item says it does. Never claims a catalog the machine has not made yet. */
export function publishDestination(defaultCatalog: OwnedCatalog | undefined, machineName: string | undefined): string {
  return defaultCatalog === undefined
    ? `Publish in a new catalog, ${defaultCatalogName(machineName)}`
    : `Publish in ${defaultCatalog.name}`;
}

/** What a tap did, as the row shows it. Nothing here decides: the daemon already did. */
export type QuickAddOutcome =
  | { readonly kind: 'added'; readonly catalogName: string; readonly token: string }
  | { readonly kind: 'already'; readonly catalogName: string }
  | { readonly kind: 'review'; readonly preview: SharedItemPreview | undefined; readonly reasons: readonly string[] };

/** Turns the answer into row state. `catalogs` names a catalog the answer only gave an id for. */
export function quickAddOutcome(answer: QuickAddAnswer, catalogs: readonly OwnedCatalog[]): QuickAddOutcome {
  if (answer.outcome === 'added') return { kind: 'added', catalogName: answer.catalog.name, token: answer.undo.token };
  if (answer.outcome === 'already')
    return {
      kind: 'already',
      catalogName: catalogs.find(catalog => catalog.id === answer.catalogId)?.name ?? 'your default catalog',
    };
  return { kind: 'review', preview: answer.preview, reasons: answer.reasons };
}

const REVIEW_REASONS: Readonly<Record<string, string>> = {
  warnings: 'It has something to read first.',
  problems: 'Some files were left out, so read what is shared first.',
  'needs-summary': 'It needs a one-line summary before it can be shared.',
};

/** Why one tap stopped and opened the review, in one sentence. */
export const reviewSentence = (reasons: readonly string[]): string =>
  reasons
    .map(reason => REVIEW_REASONS[reason])
    .filter((sentence): sentence is string => sentence !== undefined)
    .join(' ');

export const addedSentence = (catalogName: string): string => `Published in ${catalogName}`;
export const alreadySentence = (catalogName: string): string => `Already in ${catalogName}`;

/** What Undo did. A retraction left no trace; a withdrawal is the ordinary one, which a member may have seen. */
export const undoneSentence = (undone: QuickAddUndone, catalogName: string): string =>
  undone.mode === 'retracted'
    ? `Taken back. It was never in ${catalogName} for anyone.`
    : `Withdrawn from ${catalogName}. Someone may have seen it, so it shows as withdrawn.`;

/** The catalogs that still list the item live, which are not where it could go next. */
export const listedLive = (item: OwnedSharedItem): readonly string[] =>
  item.catalogs.filter(entry => entry.state === 'live').map(entry => entry.catalogId);
