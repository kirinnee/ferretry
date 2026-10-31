/**
 * What the owner's catalog screens say and decide, as pure functions over what the daemon answered.
 *
 * Plain words, short lines, one idea each. Nothing here reads a source or recomputes a review: the
 * daemon answers those, and the app shows them.
 */

import {
  type CatalogItemPreview,
  type CatalogSourceState,
  CatalogLabelSchema,
  type OwnedCatalog,
  type OwnedCatalogItem,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { deviceGrantCommand, grantRefusalNotice } from '../../lib/grants.ts';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';
import { plural } from './catalog-review-model.ts';

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

export const FROZEN_COPY_NOTE = 'A frozen copy is shared. Later edits stay here until you press Publish update.';

export const PUBLISH_COPY_NOTE = 'This freezes a new version. Copies people already have stay as they are.';

export const EXPORT_NOTE = 'The file is signed by this machine. Anyone you send it to can check that, offline.';

export const CATALOG_NOT_SHARED_YET =
  'A catalog is only a file for now. Nothing is sent anywhere until you send the file.';

export const SHARING_OFF_TITLE = 'Sharing is off for this device';

/** The command that turns Sharing on for one device. `<device>` is a placeholder on purpose. */
export const SHARING_GRANT_COMMAND = deviceGrantCommand('sharing', 'use');

export const SHARING_OFF_LINES: readonly string[] = [
  'This device may not make or export catalogs yet.',
  'Devices paired before this release start with Sharing off.',
  'To turn it on, run this on the machine itself:',
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
  grant_step_up_required: 'Nothing was changed: the passkey wasn’t confirmed. Try again and confirm it.',
};

export function ownerRefusal(error: unknown): OwnerRefusal {
  if (grantRefusalNotice(error) !== null && !(error instanceof FyHttpError && error.code === 'grant_step_up_required'))
    return { sentence: SHARING_OFF_TITLE, previewAgain: false, sharingOff: true };
  const code = error instanceof FyHttpError ? error.code : undefined;
  const known = code === undefined ? undefined : OWNER_REFUSALS[code];
  return {
    sentence: known ?? changeRefusalSentence(error),
    previewAgain: code === 'changed_since_preview',
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
  preview: CatalogItemPreview | null,
  busy: boolean,
): { enabled: boolean; reason: string | null } {
  if (preview === null) return { enabled: false, reason: 'Preview it first, so you can read what will be shared.' };
  if (preview.sameAsVersion !== undefined)
    return {
      enabled: false,
      reason: `This is the same as version ${preview.sameAsVersion}. There is nothing new to publish.`,
    };
  return { enabled: !busy, reason: null };
}
