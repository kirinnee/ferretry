/**
 * What the right side of a store row says and offers once a paired machine holds the item (&B131 B4): the installed
 * version, whether the publisher offers a newer one, and which acts are open. Pure functions over what the machine's
 * install record says and what the verified manifest lists. Nothing here updates anything: every act is the person's.
 */

import type {
  CatalogInstall,
  CatalogInstallPreview,
  CatalogInstallPreviewRequest,
  SharedCatalogItemVersions,
} from '../../../contract/wire/index.ts';
import type { InstallRefusal } from '../catalogs/catalog-install-model.ts';
import type { UpdateSource } from './shared-controller.ts';
import type { InstalledItem } from './shared-installs.ts';

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

const SEE_CHANGES = 'See changes';
const UPDATE = 'Update';
const SKIP = 'Skip this version';
export const MOVE = 'Move to version…';
const ASK_AGAIN = 'Ask again';
export const KEEP_MY_EDITS = 'Keep my edits';
export const REPLACE_MY_EDITS = 'Replace my edits';
export const UPDATE_BUTTON = 'Update · confirm with passkey';
export const MOVE_BUTTON = 'Move · confirm with passkey';
export const VERSIONS_LOADING = 'Reading the versions…';
export const NO_OTHER_VERSIONS = 'The publisher offers no other version of this.';
export const PREVIEW_UNRELATED =
  'This machine reads this version as something other than the one the publisher listed, so it was not used. Nothing was changed.';
export const MORE = 'More';

/** The choice under the banner. The banner says what happened; this says only what each button does. */
export const editedChoice = (version: number): string =>
  `Keep my edits leaves this install as it is. Replace my edits puts v${String(version)} over them.`;

const EDITED_FILES = /(?:installed|reviewed): (.+?)\. Nothing was replaced/u;

/** The banner for an install edited on the machine: nothing failed, so it says what was left alone and why, once. */
export function editedBanner(sentence: string): string {
  const files = EDITED_FILES.exec(sentence)?.[1];
  return `Not updated. You edited ${files ?? 'files of this install on this machine'}.`;
}

export const stayLabel = (version: number): string => `Stay on v${String(version)}`;
export const installedText = (version: number): string => `v${String(version)} installed`;
const availableText = (version: number): string => `v${String(version)} available`;
export const offeredText = (version: number): string => `v${String(version)}`;

/** One quiet line under each choice in the menu: what it does, and how it differs from the one beside it. */
export function actHint(act: MenuAct, installedVersion: number, listedVersion: number): string {
  switch (act) {
    case 'stay':
      return `Keep v${String(installedVersion)} and stop asking about newer versions. Ask again clears it.`;
    case 'skip':
      return `Hide v${String(listedVersion)} only. A newer version asks again.`;
    case 'move':
      return 'Pick any version the publisher still offers, newer or older.';
  }
}

// ── The status ───────────────────────────────────────────────────────────────────────────────────

export type RowAct = 'changes' | 'update' | 'stay' | 'skip' | 'move' | 'again';
export type MenuAct = Extract<RowAct, 'stay' | 'skip' | 'move'>;

type RowKind =
  /** The machine holds the version the publisher lists. */
  | 'current'
  /** The publisher lists a newer version and the person has not said no. */
  | 'update'
  /** The person chose to stay on this version. */
  | 'held'
  /** The person skipped the version now listed. */
  | 'skipped'
  /** The machine holds a version newer than the one listed (the publisher took it back). */
  | 'ahead';

export interface RowStatus {
  readonly kind: RowKind;
  /** `v2 installed`, `v1 installed · v2 available`: the versions live here and nowhere else on the row. */
  readonly text: string;
  /** The acts drawn as buttons beside the status, in order. */
  readonly buttons: readonly RowAct[];
  /** The acts kept in the More menu, in order. */
  readonly menu: readonly MenuAct[];
}

/** The status of an installed item against the version the verified manifest lists as current. */
export function rowStatus(installed: InstalledItem, listedVersion: number): RowStatus {
  const { version, install } = installed;
  const base = installedText(version);
  if (listedVersion < version) return { kind: 'ahead', text: base, buttons: [], menu: ['move'] };
  if (listedVersion === version) return { kind: 'current', text: base, buttons: [], menu: [] };
  if (install.hold === true)
    return { kind: 'held', text: `${base} · Staying on v${String(version)}`, buttons: ['again'], menu: ['move'] };
  if (install.skippedVersion === listedVersion)
    return {
      kind: 'skipped',
      text: `${base} · Skipped v${String(listedVersion)}`,
      buttons: ['again', 'changes'],
      menu: ['move'],
    };
  return {
    kind: 'update',
    text: `${base} · ${availableText(listedVersion)}`,
    buttons: ['update', 'changes'],
    menu: ['stay', 'skip', 'move'],
  };
}

/** The label of an act on a row whose machine holds `installedVersion`. */
export function actLabel(act: RowAct, installedVersion: number): string {
  switch (act) {
    case 'changes':
      return SEE_CHANGES;
    case 'update':
      return UPDATE;
    case 'stay':
      return stayLabel(installedVersion);
    case 'skip':
      return SKIP;
    case 'move':
      return MOVE;
    case 'again':
      return ASK_AGAIN;
  }
}

/** What "Ask again" clears: the stay choice, or the skip. */
export function askAgainPrefs(
  install: Pick<CatalogInstall, 'hold'>,
): { readonly hold: false } | { readonly skippedVersion: null } {
  return install.hold === true ? { hold: false } : { skippedVersion: null };
}

// ── The versions on offer ────────────────────────────────────────────────────────────────────────

type MoveDirection = 'newer' | 'older' | 'installed';

export interface MoveLine {
  readonly version: number;
  readonly direction: MoveDirection;
  /** `v3 · Newer · current · 2026-11-02`; the summary follows on its own line. */
  readonly text: string;
  readonly summary: string;
}

/** Every version the publisher still offers, newest first, said against the version installed. */
export function moveLines(list: SharedCatalogItemVersions, installedVersion: number): readonly MoveLine[] {
  return list.offered
    .toSorted((left, right) => right.version - left.version)
    .map((offered): MoveLine => {
      const direction: MoveDirection =
        offered.version === installedVersion ? 'installed' : offered.version > installedVersion ? 'newer' : 'older';
      const words = [
        `v${String(offered.version)}`,
        direction === 'installed' ? 'Installed' : direction === 'newer' ? 'Newer' : 'Older',
        ...(offered.version === list.current ? ['Current'] : []),
        offered.publishedAt.slice(0, 10),
      ];
      return { version: offered.version, direction, text: words.join(' · '), summary: offered.summary };
    });
}

// ── Asking this machine ──────────────────────────────────────────────────────────────────────────

/** The preview request that replaces `install` on the machine that holds it, with the version in `source`. */
export function updateRequest(
  source: UpdateSource,
  install: CatalogInstall,
  options: { readonly replaceEdited: boolean },
): CatalogInstallPreviewRequest {
  return {
    signedManifest: source.signedManifest,
    item: source.item,
    target: install.target,
    ...(source.item.itemVersion < install.provenance.version ? { allowOlder: true as const } : {}),
    ...(source.signedVersions === undefined ? {} : { signedVersions: source.signedVersions }),
    ...(options.replaceEdited ? { replaceEdited: true as const } : {}),
  };
}

/**
 * `null` when the machine's review names the same publisher, catalog and item the verified source does, at the version
 * and digest asked for, and replaces THIS install; else the sentence to show instead.
 */
export function updateDisagreement(
  source: UpdateSource,
  install: CatalogInstall,
  preview: CatalogInstallPreview,
): string | null {
  const { manifest, item } = source;
  const { provenance, publisher, replaces } = preview;
  const agrees =
    provenance.publisher === manifest.publisher &&
    publisher.daemonId === manifest.publisher &&
    provenance.publisherName === manifest.publisherName &&
    publisher.name === manifest.publisherName &&
    provenance.catalogId === manifest.catalogId &&
    provenance.catalogName === manifest.name &&
    provenance.itemId === item.itemId &&
    provenance.itemId === install.provenance.itemId &&
    provenance.kind === item.kind &&
    provenance.name === item.name &&
    provenance.version === item.itemVersion &&
    provenance.digest === source.expectedDigest &&
    replaces?.installId === install.installId;
  return agrees ? null : PREVIEW_UNRELATED;
}

// ── The update sheet ─────────────────────────────────────────────────────────────────────────────

export type UpdateVerb = 'Update' | 'Move';

/** The verb for taking `version` over `installedVersion`: Update goes to the version the publisher lists, Move to any other. */
export function updateVerb(version: number, listedVersion: number, installedVersion: number): UpdateVerb {
  return version === listedVersion && version > installedVersion ? 'Update' : 'Move';
}

export const confirmLabel = (verb: UpdateVerb): string => (verb === 'Update' ? UPDATE_BUTTON : MOVE_BUTTON);
export const busyLabel = (verb: UpdateVerb): string => (verb === 'Update' ? 'Updating…' : 'Moving…');

export const READING_VERSION = 'Reading this version on your machine…';
export const NO_COMPARISON = 'This machine could not compare the two versions. Read the full review before you update.';
export const DONE_UPDATING = 'Done';

/** `v2 to v3 on kirin-box` */
export function moveSubtitle(installedVersion: number, version: number, machineName: string): string {
  return `v${String(installedVersion)} to v${String(version)} on ${machineName}`;
}

/** A refusal that came from this app's own check, not from the machine: no button follows it. */
export function plainRefusal(sentence: string): InstallRefusal {
  return { sentence, previewAgain: false, olderOffered: false, editedOffered: false };
}
